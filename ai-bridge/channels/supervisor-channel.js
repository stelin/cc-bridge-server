/**
 * Supervisor Channel.
 *
 * Runs a parallel Claude SDK Query session that observes the main AI's event
 * stream (forwarded from Java) and emits structured ACTION decisions via the
 * mcp__supervisor__emit_action tool — see ../services/supervisor/supervisor-tools.js.
 *
 * Protocol (daemon NDJSON):
 *   - supervisor.start   { pairId, supervisorId, name, description, planContent,
 *                          specContent?, model?, allowedTools? }
 *   - supervisor.postEvent { pairId, supervisorId, event: {...} }
 *   - supervisor.stop    { pairId, supervisorId }
 *
 * For each postEvent, this channel:
 *   1. Summarizes the event (see event-summarizer.js)
 *   2. Enqueues it as a user message in the persistent input stream
 *   3. Iterates the SDK query result until turn_end. The model calls
 *      emit_action, which captures the validated action onto the runtime.
 *   4. Writes a single `{ id, type: 'supervisor_action', ... }` NDJSON line
 *      back to Java.
 *
 * Each pair_supervisor combination holds its own runtime; closing it disposes
 * the SDK query and removes the entry.
 */

import { loadClaudeSdk, loadZod, isClaudeSdkAvailable } from '../utils/sdk-loader.js';
import { AsyncStream } from '../utils/async-stream.js';
import { summarizeEvent } from '../services/supervisor/event-summarizer.js';
import {
    buildSupervisorMcpServer,
    QUALIFIED_EMIT_ACTION,
    SUPERVISOR_MCP_NAME,
    EMIT_ACTION_TOOL_NAME,
} from '../services/supervisor/supervisor-tools.js';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

// v3: read-only file tools granted to the supervisor so it can perform
// in-turn review (Glob to locate produced files, Read to inspect contents,
// Grep to flag TODO/FIXME/stub functions). Write/Edit/Bash remain forbidden
// — supervisors decide, the main AI edits.
const SUPERVISOR_READ_TOOLS = ['Read', 'Glob', 'Grep'];

/** @type {Map<string, SupervisorRuntime>} */
const runtimes = new Map();

class SupervisorRuntime {
    constructor({ pairId, supervisorId, name, model, systemPrompt, allowedTools }) {
        this.pairId = pairId;
        this.supervisorId = supervisorId;
        this.name = name || supervisorId;
        this.model = model || DEFAULT_MODEL;
        this.systemPrompt = systemPrompt;
        this.allowedTools = Array.isArray(allowedTools) ? allowedTools : [];
        this.inputStream = new AsyncStream();
        /** @type {AsyncGenerator | null} */
        this.query = null;
        this.disposed = false;
        /** Serialize concurrent postEvent calls to avoid interleaved turns. */
        this.busy = Promise.resolve();
        /**
         * Filled by the emit_action tool handler during the current turn.
         * Reset at the start of each postEvent and read after the turn ends.
         * @type {{action: string, reason: string, payload: object} | null}
         */
        this.lastCapturedAction = null;
        /**
         * v4 unified pipeline: turnId assigned at the start of postEvent. Used by
         * streamSdkMessage so each `[SUPERVISOR_MSG]` line carries the same id
         * as the wrapper's terminating `[SUPERVISOR_ACTION]`. null between
         * turns; non-null while a turn is collecting messages.
         * @type {string | null}
         */
        this.currentTurnId = null;
    }
}

function key(pairId, supervisorId) {
    return `${pairId}:${supervisorId}`;
}

/**
 * Compose the system prompt for the Supervisor LLM. Always emits the
 * tool-based action contract; the agent's `description` field is the
 * user-defined persona portion.
 */
function buildSystemPrompt({ name, description, planContent, specContent }) {
    const hasPlan = planContent && planContent.trim().length > 0;
    const sections = [
        description?.trim() || `你是名为 ${name} 的 Supervisor。`,
    ];

    if (hasPlan) {
        sections.push(
            '',
            '# 当前任务方案（plan.md，已锁定，不可修改）',
            planContent.trim()
        );
    } else {
        sections.push(
            '',
            '# 当前任务方案',
            '尚未提供。等待用户在右侧输入框给出任务描述。',
            '在用户提供任务前，**保持沉默**——除非收到 user_input 事件，否则调用 emit_action 时使用 action="wait"。'
        );
    }

    if (specContent && specContent.trim()) {
        sections.push(
            '',
            '# 项目适用规范 / 技能包',
            '以下是当前项目启用的规范包。主 AI 每次产出后，把这些当作 review 检查项；',
            '违反时立即通过 emit_action(action="inject_prompt") 反馈具体违反点（引用规范名 + 文件:行号）。',
            '',
            specContent.trim()
        );
    }

    sections.push(
        '',
        '# 你可用的只读工具（必读）',
        '除 `emit_action` 外，你拥有 **只读** 文件工具：`Read`、`Glob`、`Grep`。',
        '- 你**没有**写工具——不能调用 Edit / Write / Bash。修改代码靠 inject_prompt 让主 AI 做。',
        '- 一个 turn 内可以多次调用文件工具，最后调用 **一次** `emit_action` 收尾。',
        '',
        '# 必做：review 协议（强约束）',
        '收到 turn_end / verify_result / review_result 等"主 AI 已产出"类事件时：',
        '1) **必须**至少调用一次 `Glob` 或 `Read`（针对 modified_in_plan 文件）——不可跳过；',
        '2) 怀疑有 TODO / FIXME / 桩函数 / 假数据时，调用 `Grep` 验证；',
        '3) 完成检查后再调用 `emit_action`。',
        '**绝不可以只在自然语言里说"我读了 XXX 文件"而不真正发出 tool_use**——',
        '只信主 AI 自述、跳过文件检查直接 emit_action 视为协议违例，本轮判失败。',
        '',
        '收到 user_input / start 等"无产出"事件时，可以直接 emit_action 不调文件工具。',
        '',
        '# 输出格式（强约束）',
        '每一轮决策必须：',
        '1) （可选）先输出简短自然语言段：用 💭/✓/⚠️/⚡/→ 等符号描述观察。',
        '2) 按 review 协议调用所需文件工具（review 类事件必做）。',
        '3) **必须调用 `emit_action` 工具**结束本轮。一轮只能调用一次；调用成功后立即结束本轮。',
        '',
        '`emit_action` 字段说明：',
        '- action: 必填，枚举 inject_prompt / retry_with_hint / approve_and_continue / escalate_to_human / request_amendment / wait',
        '- reason: 强烈建议，1-2 句决策原因',
        '- inject_prompt / retry_with_hint 需要 prompt（注入给主 AI 的内容）',
        '- retry_with_hint 可选 wait_seconds（延迟秒数）',
        '- escalate_to_human 需要 question，可选 choices / context_files',
        '- request_amendment 建议带 proposal',
        '- approve_and_continue 可选 mark_step_complete（步骤序号）',
        '- wait 无额外字段',
        '',
        '若不确定下一步，调用 `emit_action(action="wait")`——**绝不可以只输出文字不调用工具**。',
        '',
        '# 行为约束',
        '- 方案 plan.md 是标准答案。主 AI 不能擅自偏离；偏离时升级用户（escalate_to_human）或要求修正（inject_prompt）。',
        '- 一轮只调用一次 emit_action。',
        '- 文件工具仅用于 review 检查产出，不要用来探查无关代码。'
    );

    return sections.join('\n');
}

/**
 * Start a new supervisor session.
 */
export async function startSupervisorSession(params) {
    if (!isClaudeSdkAvailable()) {
        throw new Error('Claude SDK not installed; supervisor cannot start.');
    }

    const {
        pairId,
        supervisorId,
        name,
        description,
        planContent,
        specContent,
        model,
        allowedTools,
        autoCompactThreshold,
    } = params || {};

    if (!pairId || !supervisorId) {
        throw new Error('supervisor.start requires pairId and supervisorId');
    }

    // Allow the JetBrains side to override the daemon-wide autocompact
    // threshold per Pair session. The CLI re-reads process.env on every
    // shouldAutoCompact() call (autoCompact.ts:40), so a late mutation here
    // takes effect on the *next* turn — both for this supervisor and for
    // the main AI sharing the same daemon (acknowledged in the design;
    // see Q1 alignment in the rollout plan).
    if (typeof autoCompactThreshold === 'number'
        && autoCompactThreshold >= 50 && autoCompactThreshold <= 95) {
        process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(autoCompactThreshold);
        process.stdout.write(
            `[supervisor] autocompact threshold set to ${autoCompactThreshold}%\n`
        );
    }

    const k = key(pairId, supervisorId);
    if (runtimes.has(k)) {
        // Idempotent: if already alive, return early.
        process.stdout.write(`[supervisor] session already running: ${k}\n`);
        return { alreadyRunning: true };
    }

    const systemPrompt = buildSystemPrompt({ name, description, planContent, specContent });

    const [sdk, zod] = await Promise.all([loadClaudeSdk(), loadZod()]);
    const queryFn = sdk?.query;
    if (typeof queryFn !== 'function') {
        throw new Error('Claude SDK does not expose query() function');
    }

    const runtime = new SupervisorRuntime({
        pairId,
        supervisorId,
        name,
        model,
        systemPrompt,
        allowedTools,
    });

    // Build the in-process MCP server. The handler captures the validated
    // action onto the runtime; collectAssistantTurn reads it after the turn.
    const supervisorMcpServer = buildSupervisorMcpServer(sdk, zod, (action) => {
        runtime.lastCapturedAction = action;
    });

    // Allow emit_action + read-only file tools by default; callers may opt-in
    // to extra tools. Read/Glob/Grep are required by the v3 supervisor prompt
    // to perform in-turn code review (see SUPERVISOR_READ_TOOLS comment).
    const allowedToolList = [
        QUALIFIED_EMIT_ACTION,
        ...SUPERVISOR_READ_TOOLS,
        ...runtime.allowedTools,
    ];

    // SDK options. Supervisor judgment-only: no project-scoped settings, no
    // file checkpointing. We do still pass a cwd because the SDK requires one.
    const cwd = process.env.IDEA_PROJECT_PATH || process.env.PROJECT_PATH || process.cwd();
    runtime.query = queryFn({
        prompt: runtime.inputStream,
        options: {
            cwd,
            model: runtime.model,
            maxTurns: 100,
            // The SDK accepts a string-or-object systemPrompt. Use a string here so the
            // claude_code preset is NOT activated — Supervisor must obey OUR persona,
            // not Claude Code's default agent instructions.
            systemPrompt: runtime.systemPrompt,
            mcpServers: { [SUPERVISOR_MCP_NAME]: supervisorMcpServer },
            allowedTools: allowedToolList,
            // Defensive allowlist: pre-approve emit_action, deny everything else
            // even if it slips into allowedTools by mistake.
            canUseTool: async (toolName) => {
                if (toolName === QUALIFIED_EMIT_ACTION) {
                    return { behavior: 'allow' };
                }
                if (SUPERVISOR_READ_TOOLS.includes(toolName)) {
                    return { behavior: 'allow' };
                }
                if (runtime.allowedTools.includes(toolName)) {
                    return { behavior: 'allow' };
                }
                return {
                    behavior: 'deny',
                    message: `Supervisor sessions may only call ${QUALIFIED_EMIT_ACTION} or read-only file tools (Read/Glob/Grep).`,
                };
            },
        },
    });

    runtimes.set(k, runtime);
    process.stdout.write(`[supervisor] started: ${k} (model=${runtime.model})\n`);
    return { started: true, key: k };
}

/**
 * Post an event to the supervisor; wait for its next ACTION; emit a NDJSON
 * line tagged with the current request id, so Java can demux the response.
 *
 * The returned promise resolves once the supervisor turn ends or fails.
 */
export async function postEventToSupervisor(params) {
    const { pairId, supervisorId, event } = params || {};
    if (!pairId || !supervisorId) {
        throw new Error('supervisor.postEvent requires pairId and supervisorId');
    }

    const runtime = runtimes.get(key(pairId, supervisorId));
    if (!runtime || runtime.disposed) {
        // Stable prefix + code: Java EventBus matches on this to trigger a lazy
        // supervisor.start + retry after the daemon process has been restarted
        // (its in-memory `runtimes` Map is empty on a fresh process, but the
        // Java-side PairSession still thinks the supervisor is alive).
        const err = new Error(
            `SUPERVISOR_NOT_FOUND supervisor session not found or disposed: ${pairId}:${supervisorId}`
        );
        err.code = 'SUPERVISOR_NOT_FOUND';
        throw err;
    }

    // Serialize per-runtime so concurrent postEvent calls don't interleave turns.
    const prev = runtime.busy;
    let release;
    runtime.busy = new Promise((resolve) => { release = resolve; });

    try {
        await prev;
        const summary = summarizeEvent(event);

        // Reset per-turn capture before enqueueing the next user message.
        runtime.lastCapturedAction = null;

        // v4 unified pipeline: assign a turnId so streamed SDK messages and the
        // closing [SUPERVISOR_ACTION] wrapper can be correlated on the webview
        // side (entries with the same turnId become one supervisor bubble).
        const turnId = `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        runtime.currentTurnId = turnId;

        // Enqueue the summarized event as a user message in the SDK input stream.
        // Schema must match what the Claude Agent SDK expects (see persistent-query-service.js).
        runtime.inputStream.enqueue({
            type: 'user',
            session_id: '',
            parent_tool_use_id: null,
            message: {
                role: 'user',
                content: [{ type: 'text', text: summary }],
            },
        });

        const turn = await collectAssistantTurn(runtime);

        const wrapper = buildActionWrapper({
            pairId,
            supervisorId,
            assistantText: turn.assistantText,
            reasoningText: turn.reasoningText,
            capturedAction: runtime.lastCapturedAction,
        });
        wrapper.turnId = turnId;
        // v3 side-channel data: only `usage` remains on the wrapper. tool_use
        // and compaction blocks now flow live via [SUPERVISOR_MSG] streaming so
        // the webview can render them as they happen (and so we no longer
        // double-render them). See collectAssistantTurn / streamSdkMessage.
        if (turn.usage) {
            wrapper.usage = { model: runtime.model, ...turn.usage };
        }

        // Emit a single NDJSON event line that the daemon-tagged stdout wraps
        // with the active request id. Java consumers see:
        //   { "id": "<reqId>", "line": "[SUPERVISOR_ACTION] {...}" }
        process.stdout.write('[SUPERVISOR_ACTION] ' + JSON.stringify(wrapper) + '\n');

        return { ok: true };
    } finally {
        runtime.currentTurnId = null;
        release();
    }
}

/**
 * Stop and dispose a supervisor session.
 */
export async function stopSupervisorSession(params) {
    const { pairId, supervisorId } = params || {};
    if (!pairId || !supervisorId) {
        throw new Error('supervisor.stop requires pairId and supervisorId');
    }

    const k = key(pairId, supervisorId);
    const runtime = runtimes.get(k);
    if (!runtime) {
        return { alreadyStopped: true };
    }

    runtime.disposed = true;
    try {
        runtime.inputStream.done();
    } catch { /* ignore */ }
    try {
        if (typeof runtime.query?.return === 'function') {
            await runtime.query.return();
        }
    } catch { /* ignore */ }
    runtimes.delete(k);
    process.stdout.write(`[supervisor] stopped: ${k}\n`);
    return { stopped: true };
}

/**
 * Stop every supervisor — used at daemon shutdown.
 */
export async function stopAllSupervisorSessions() {
    const keys = Array.from(runtimes.keys());
    for (const k of keys) {
        const [pairId, supervisorId] = k.split(':', 2);
        try {
            await stopSupervisorSession({ pairId, supervisorId });
        } catch { /* ignore */ }
    }
}

/**
 * Drain SDK messages until the next assistant turn ends.
 *
 * The model's structured ACTION is delivered via the emit_action tool handler
 * (which writes into runtime.lastCapturedAction). What we collect here is the
 * surrounding context for the UI:
 *   - assistantText  — concatenated `text` blocks (the model's visible prose
 *                       prelude/coda around the tool call)
 *   - reasoningText  — concatenated `thinking` / reasoning blocks (model's
 *                       hidden chain of thought, present only when reasoning
 *                       effort is enabled and the model supports it)
 */
async function collectAssistantTurn(runtime) {
    const textBuf = [];
    const reasoningBuf = [];
    /** Tool-use blocks (Read/Glob/Grep …) plus their matching tool_result. */
    const toolEvents = [];
    /** Pending tool_use entries waiting for their tool_result by tool_use_id. */
    const pendingTools = new Map();
    /** Compaction boundary messages emitted by CLI mid-stream. */
    const compactEvents = [];
    /** Last usage snapshot we saw — taken from the final assistant or result message. */
    let lastUsage = null;
    // Diagnostic ledger for the v3 usage-stream bug investigation. We dump
    // the shape of each SDK message we see this turn (type, subtype, what
    // usage fields are present) so when the user reports "0% never moves"
    // we can post-mortem the daemon log without guessing.
    const seenTypes = [];
    while (true) {
        if (runtime.disposed) {
            throw new Error('Supervisor runtime disposed mid-turn');
        }
        let next;
        try {
            next = await runtime.query.next();
        } catch (err) {
            throw new Error('Supervisor SDK iteration failed: ' + (err?.message ?? String(err)));
        }
        if (next?.done) break;

        const msg = next.value;
        if (!msg) continue;

        // Record this message's shape so we can debug usage extraction later.
        // Cheap (constant string concat); the dump happens once per turn.
        seenTypes.push(
            (msg.type || '?')
            + (msg.subtype ? `:${msg.subtype}` : '')
            + (msg.message?.usage ? '[u]' : '')
            + (msg.usage ? '[U]' : '')
        );

        // v4 unified pipeline: stream the raw SDK message to the webview the
        // instant it arrives. The webview converts content blocks into pane
        // entries on the fly — no need to wait for the turn to end and
        // reconstruct from a wrapper. result/system meta-frames are streamed
        // too because the webview may want to surface them (e.g. compaction).
        streamSdkMessage(runtime, msg);

        if (msg.type === 'assistant' && msg.message?.content) {
            for (const block of msg.message.content) {
                if (!block || typeof block !== 'object') continue;
                if (block.type === 'text' && typeof block.text === 'string') {
                    textBuf.push(block.text);
                } else if (block.type === 'thinking') {
                    // SDK reasoning content block.
                    const t = typeof block.thinking === 'string' ? block.thinking
                              : typeof block.text === 'string' ? block.text : '';
                    if (t) reasoningBuf.push(t);
                } else if (block.type === 'redacted_thinking') {
                    // Redacted by Anthropic policy — show a marker so the UI doesn't lie.
                    reasoningBuf.push('[redacted reasoning]');
                } else if (block.type === 'tool_use') {
                    // Read/Glob/Grep invocations — we surface these to the UI
                    // so users can see what the supervisor inspected, matching
                    // the main AI's tool card rendering. The MCP emit_action
                    // tool is filtered out — it's an internal protocol detail,
                    // not user-facing.
                    const isMcpAction = typeof block.name === 'string'
                        && block.name.includes(EMIT_ACTION_TOOL_NAME);
                    if (!isMcpAction) {
                        const entry = {
                            id: block.id,
                            name: block.name,
                            input: block.input,
                            result: null,
                        };
                        pendingTools.set(block.id, entry);
                        toolEvents.push(entry);
                    }
                }
            }
            // Per-message usage rollup, in case the result message doesn't carry one.
            if (msg.message.usage) lastUsage = msg.message.usage;
        } else if (msg.type === 'user' && msg.message?.content) {
            // tool_result blocks come back as user-role messages in the SDK
            // stream. Match them to the pending tool_use by id and attach
            // a brief stringified preview (full content can be huge — we
            // cap it so the IPC line stays sensible).
            for (const block of msg.message.content) {
                if (!block || typeof block !== 'object') continue;
                if (block.type !== 'tool_result') continue;
                const pending = pendingTools.get(block.tool_use_id);
                if (!pending) continue;
                pending.result = summarizeToolResult(block);
                pendingTools.delete(block.tool_use_id);
            }
        } else if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
            // CLI auto-compaction event — the conversation history was just
            // summarised down to fit the model's context window. We pass the
            // before/after token counts to the UI so the user understands
            // why earlier turns suddenly look terser.
            compactEvents.push({
                trigger: msg.compact_metadata?.trigger || 'auto',
                preTokens: msg.compact_metadata?.pre_tokens ?? null,
            });
        } else if (msg.type === 'result') {
            if (msg.usage) lastUsage = msg.usage;
            break;
        }
    }
    // One-line per-turn diagnostic. Goes to daemon stderr via console.error
    // (intercepted by daemon.js and forwarded as a daemon stderr line, NOT
    // a request-tagged stdout line — so it doesn't pollute the IPC stream).
    // Read it via the IDE's daemon-stderr log when triaging "0% never moves"
    // or "no tool cards" complaints.
    console.error(
        `[supervisor-diag] turn complete: msgs=[${seenTypes.join(', ')}] `
        + `tools=${toolEvents.length} compact=${compactEvents.length} `
        + `usage=${lastUsage ? JSON.stringify(lastUsage) : 'null'}`
    );
    if (toolEvents.length > 0) {
        // List the tool names so we can verify the supervisor is exercising
        // the protocol ("at least one Read before emit_action"). If this line
        // is missing from the daemon log, the wrapper.toolEvents was empty
        // and Java has nothing to dispatch.
        console.error(
            `[supervisor-diag] toolEvents=${toolEvents.map(t => t.name).join(',')}`
        );
    } else {
        console.error('[supervisor-diag] toolEvents=(none) — supervisor skipped review tools');
    }
    return {
        assistantText: textBuf.join('').trim(),
        reasoningText: reasoningBuf.join('\n').trim(),
        toolEvents,
        compactEvents,
        usage: lastUsage ? normaliseUsage(lastUsage) : null,
    };
}

/**
 * v4 unified pipeline: forward one raw SDK message to Java/webview as a
 * `[SUPERVISOR_MSG]` line tagged with pairId / supervisorId / turnId. The
 * payload is a thin envelope — the SDK message body is passed through
 * untouched so the webview can use the same content-block shape it already
 * handles for main-AI messages.
 *
 * Lines are written through the daemon's intercepted process.stdout, which
 * wraps them as `{ id: <reqId>, line: "[SUPERVISOR_MSG] {...}" }` NDJSON.
 * If JSON.stringify fails (e.g. circular ref in a future SDK shape), we log
 * and drop — losing a stream message must not break the turn.
 */
function streamSdkMessage(runtime, msg) {
    try {
        // Tool_result blocks can be huge (a Read on a multi-MB file). Cap the
        // text content here so the IPC line stays under a few KB — matches the
        // cap we apply in summarizeToolResult for the old wrapper path.
        const envelope = {
            pairId: runtime.pairId,
            supervisorId: runtime.supervisorId,
            turnId: runtime.currentTurnId,
            message: capStreamMessage(msg),
        };
        process.stdout.write('[SUPERVISOR_MSG] ' + JSON.stringify(envelope) + '\n');
    } catch (e) {
        console.error('[supervisor-stream] failed to stream msg: '
            + (e?.message || String(e)));
    }
}

/**
 * Safety-valve cap on tool_result text in streamed messages. Set high enough
 * (200KB) that ordinary Read/Glob/Grep outputs flow through intact, but low
 * enough to defend against a pathological multi-MB Read blowing past IPC
 * limits. The UI now uses the full main-AI rendering pipeline (with
 * CollapsibleTextBlock) so it can handle large outputs gracefully — the cap
 * here is purely a DoS guard, not a UI affordance.
 */
function capStreamMessage(msg) {
    if (!msg || msg.type !== 'user' || !Array.isArray(msg.message?.content)) {
        return msg;
    }
    const MAX_LEN = 200_000;
    const cappedContent = msg.message.content.map((block) => {
        if (!block || block.type !== 'tool_result') return block;
        let text = '';
        if (typeof block.content === 'string') {
            text = block.content;
        } else if (Array.isArray(block.content)) {
            text = block.content
                .filter((c) => c?.type === 'text' && typeof c.text === 'string')
                .map((c) => c.text)
                .join('\n');
        }
        if (text.length <= MAX_LEN) return block;
        const truncated = text.slice(0, MAX_LEN) + '\n…(truncated)';
        return {
            ...block,
            content: truncated,
            _totalLength: text.length,
        };
    });
    return {
        ...msg,
        message: { ...msg.message, content: cappedContent },
    };
}

/**
 * Tool-result summary used by the legacy wrapper path (only triggered when
 * the SDK stream produced no live messages — transport errors / skipped
 * emit_action). Same 200KB safety valve as capStreamMessage.
 */
function summarizeToolResult(block) {
    const isError = block.is_error === true;
    let text = '';
    if (typeof block.content === 'string') {
        text = block.content;
    } else if (Array.isArray(block.content)) {
        text = block.content
            .filter((c) => c?.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text)
            .join('\n');
    }
    const MAX_LEN = 200_000;
    const truncated = text.length > MAX_LEN;
    return {
        isError,
        preview: truncated ? text.slice(0, MAX_LEN) + '\n…(truncated)' : text,
        totalLength: text.length,
    };
}

/**
 * Normalise the SDK's usage object into a consistent shape and compute a
 * "total prompt tokens" estimate — the figure the UI percentage is keyed off.
 * Cache hits + cache writes both count as "in the window" because that's
 * what the model sees on the next turn.
 */
function normaliseUsage(usage) {
    const input = usage.input_tokens || 0;
    const cacheCreate = usage.cache_creation_input_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const output = usage.output_tokens || 0;
    return {
        inputTokens: input,
        outputTokens: output,
        cacheCreationInputTokens: cacheCreate,
        cacheReadInputTokens: cacheRead,
        totalPromptTokens: input + cacheCreate + cacheRead,
    };
}

/**
 * Build the wrapper object the Java side (ActionRouter) expects.
 *
 * <p>v4 unified pipeline: text and reasoning are NOT carried on the wrapper for
 * the normal path — they were already streamed live via [SUPERVISOR_MSG]. The
 * wrapper carries only the {@code action} (emit_action result) plus a turnId
 * the webview uses to group the streamed entries with the action card into
 * one bubble. Empty {@code naturalText} / {@code reasoningText} placeholders
 * are kept for backward compatibility with any consumer reading the JSON; the
 * webview ignores them when {@code parseError} is null.
 *
 * <p>If the model never calls emit_action, we still downgrade to a
 * {@code wait} action with a non-null {@code parseError} so the UI surfaces
 * a card and the dispatcher does not dead-lock. {@code rawText} keeps the
 * model's prose for debugging — it never reaches the bubble (the streamed
 * text entries already did).
 */
function buildActionWrapper({ pairId, supervisorId, assistantText, reasoningText, capturedAction }) {
    if (capturedAction) {
        return {
            pairId,
            supervisorId,
            naturalText: '',
            reasoningText: '',
            action: capturedAction,
            parseError: null,
            rawText: JSON.stringify(capturedAction),
        };
    }

    return {
        pairId,
        supervisorId,
        naturalText: '',
        reasoningText: '',
        action: {
            action: 'wait',
            reason: '(downgraded) supervisor did not call emit_action this turn',
            payload: {},
        },
        parseError: 'no_tool_use',
        rawText: assistantText,
    };
}

/**
 * Diagnostic — useful for daemon shutdown hooks.
 */
export function getActiveSupervisorCount() {
    return runtimes.size;
}
