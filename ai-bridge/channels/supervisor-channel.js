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
import { estimateTokensFromChars } from '../utils/usage-utils.js';
import { summarizeEvent } from '../services/supervisor/event-summarizer.js';
import {
    buildSupervisorMcpServer,
    QUALIFIED_EMIT_ACTION,
    QUALIFIED_DISPATCH_TO_MAIN_AI,
    QUALIFIED_RETRY_MAIN_AI_WITH_HINT,
    QUALIFIED_UPDATE_STATE,
    QUALIFIED_SAVE_PLAN,
    SUPERVISOR_MCP_NAME,
    EMIT_ACTION_TOOL_NAME,
    DISPATCH_TO_MAIN_AI_TOOL_NAME,
    RETRY_MAIN_AI_WITH_HINT_TOOL_NAME,
} from '../services/supervisor/supervisor-tools.js';
import { buildPreCompactHook } from '../services/supervisor/pre-compact-hook.js';
import { PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '../services/supervisor/protocol-v2.js';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

// v3: read-only file tools granted to the supervisor so it can perform
// in-turn review (Glob to locate produced files, Read to inspect contents,
// Grep to flag TODO/FIXME/stub functions). Write/Edit/Bash remain forbidden
// — supervisors decide, the main AI edits.
const SUPERVISOR_READ_TOOLS = ['Read', 'Glob', 'Grep'];

// Protocol v2 (2026-05-24): the supervisor may delegate review/manifest tasks
// to its OWN subagents via the SDK Task tool. Subagent's tool whitelist is
// constrained by the subagent prompt (R1 decision: general-purpose, no
// pre-defined types — keep simple). Note the Task tool itself does NOT let
// the supervisor write files; only the supervisor's subagents do, and they
// run in their own isolated context per SDK semantics.
const SUPERVISOR_AGENT_TOOLS = ['Task'];

// 2026-05-25 (FUNDAMENTAL FIX): wall-clock caps on the active path were
// CONFLATING "stuck" with "slow but progressing". A Task subagent that reads
// a 60K-token design doc takes minutes by design — that's not a fault, that's
// the work. Any fixed cap will misfire; we just shifted at what duration the
// misfire happens by tweaking constants. Pointless.
//
// New design: the active path has NO wall-clock cap. Liveness is detected
// via three orthogonal signals, NONE of which are wall-clock:
//   1. SDK-internal timeouts (API call, network, batch size) — Anthropic's
//      SDK throws on its own transport failures. We bubble them up.
//   2. Manual user interrupt — `supervisor.interrupt` RPC calls
//      `runtime.query.interrupt()`; the active `query.next()` settles
//      cleanly. Wired to a Stop button in the supervisor pane.
//   3. Daemon process death — Java's SupervisorBridge IPC layer detects
//      stdout EOF and rejects pending futures with a connection error.
//
// What we KEEP:
//   - per-frame `prev_frame_kind` tracking (purely for diagnostic logging)
//   - end-of-turn diagnostic dumps (so post-mortem of "wedged" turns works)
//
// What we REMOVE:
//   - the Promise.race against a setTimeout in nextWithTimeout
//   - the `SUPERVISOR_QUERY_TIMEOUT` synthetic error
//   - the after_tool_use / after_compact stage-aware timeout caps
//
// If a turn genuinely wedges (no frame arrives for hours, nothing the user
// expects), the user clicks Stop. We do not pretend to know better than them.
//
// Env knobs still honoured for emergency rollback (set any to a positive ms
// value to re-enable a wall-clock cap on the corresponding stage):
//   SUPERVISOR_QUERY_TIMEOUT_MS                 — default stage
//   SUPERVISOR_QUERY_TIMEOUT_AFTER_TOOL_USE_MS  — after tool_use frame
//   SUPERVISOR_QUERY_TIMEOUT_AFTER_COMPACT_MS   — after compact_boundary frame
// When unset (default), each stage runs uncapped.
const QUERY_NEXT_TIMEOUT_MS = readEnvMsOrZero('SUPERVISOR_QUERY_TIMEOUT_MS');
const QUERY_NEXT_TIMEOUT_AFTER_TOOL_USE_MS = readEnvMsOrZero('SUPERVISOR_QUERY_TIMEOUT_AFTER_TOOL_USE_MS');
const QUERY_NEXT_TIMEOUT_AFTER_COMPACT_MS = readEnvMsOrZero('SUPERVISOR_QUERY_TIMEOUT_AFTER_COMPACT_MS');

function readEnvMsOrZero(name) {
    const raw = process.env[name];
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Wait for the SDK's next iterator result. If `timeoutMs > 0` (env-opt-in
 * emergency rollback), race against a wall-clock cap and throw
 * `SUPERVISOR_QUERY_TIMEOUT` on expiry. Default ({@code timeoutMs === 0}) is
 * an unbounded await — the normal mode of operation post-2026-05-25.
 */
async function nextWithOptionalTimeout(query, timeoutMs, stage = 'default') {
    if (!(timeoutMs > 0)) {
        return await query.next();
    }
    let timer;
    try {
        return await Promise.race([
            query.next(),
            new Promise((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(
                        `SUPERVISOR_QUERY_TIMEOUT after ${timeoutMs}ms (stage=${stage})`
                    )),
                    timeoutMs
                );
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

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

        // Phase 2 (2026-05-24): diagnostic counters surfaced via
        // supervisor.health. compactCount tracks SDK auto-compaction events
        // observed during this runtime's lifetime; lastActivityAt is the
        // wall-clock ms of the most recent successful turn end; createdAt is
        // session-start time. All used by the Java PairStatusPusher.
        this.compactCount = 0;
        this.lastCompactAt = null;
        this.createdAt = Date.now();
        this.lastActivityAt = Date.now();
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
            '在用户提供任务（user_input 事件）前，**保持沉默**——不要调用任何收尾工具。',
            '系统会在你不调任何收尾工具时自动 downgrade 为 wait，这是正确的"等用户"状态。'
        );
    }

    if (specContent && specContent.trim()) {
        sections.push(
            '',
            '# 项目适用规范 / 技能包',
            '以下是当前项目启用的规范包。主 AI 每次产出后，把这些当作 review 检查项；',
            '违反时立即通过 `retry_main_ai_with_hint` 反馈具体违反点（引用规范名 + 文件:行号）。',
            '',
            specContent.trim()
        );
    }

    sections.push(
        '',
        '# 你拥有的工具',
        '',
        '## 收尾工具（每个 turn 必须调用且仅调用一个）',
        '- `dispatch_to_main_ai` — **派新任务给主 AI**。prompt 字段必填（>= 10 字），是主 AI 直接读到的指令。',
        '- `retry_main_ai_with_hint` — **让主 AI 重试/修正上一次产出**。prompt 字段必填（>= 10 字），写要改的具体内容。',
        '- `emit_action` — **非派单的流程控制**。action 枚举：',
        '  - `approve_and_continue` — 主 AI 产出通过 review，推进 plan。可选 mark_step_complete=步骤号。',
        '  - `record_alert` — 记录告警。必填 fallback_choice，必填 category（C1=软告警 / C2=硬告警）+ severity（warn / alert）。',
        '  - `escalate_to_human` — 升级人工询问。在全自治模式下系统自动 alias 成 record_alert(C2)；非全自治模式会 block 等用户回答。带 question / choices / context_files。',
        '  - `request_amendment` — 提议修改 plan。建议带 proposal。',
        '',
        '## 辅助工具（任意 turn 内可调，不算收尾）',
        '- `save_plan` — 写入 plan.md（一般在 step 计划生成时调）。',
        '- `update_state` — 提交 L2 状态变更。',
        '- `Read` / `Glob` / `Grep` — 只读文件，用于 review 主 AI 产出。',
        '- `Task` — 派只读子代理做重型 review（如读 50K+ 设计文档、跨文件 manifest 抽取）。子代理跑在独立 context，不污染你的对话历史。',
        '',
        '你**没有**写工具——不能调用 Edit / Write / Bash。修改代码靠 `dispatch_to_main_ai` / `retry_main_ai_with_hint` 让主 AI 做。',
        '',
        '# 一 turn 一收尾铁律',
        '',
        '每个 turn 必须调用**恰好一个**收尾工具：`dispatch_to_main_ai` / `retry_main_ai_with_hint` / `emit_action`，三选一。',
        '',
        '- **收尾工具调用成功 = 你的 turn 立即结束**。返回 "Turn complete" 后**停止输出**，不要再调任何工具，也不要再写任何文字。',
        '- 派完单后**不存在"显式等待主 AI"的需要**——系统会在主 AI 回执时自动唤醒你。',
        '- 第二个收尾工具调用会被 `[CAPTURE_GUARD]` 拒（first-wins），第一个动作仍然生效。但这表明你**违反了协议**，下次注意。',
        '- 错误示范：调 `dispatch_to_main_ai` → 又调 `emit_action(approve_and_continue)` 表达"派完顺便确认上一步"——拆成两个 turn。',
        '- 正确示范：调一个收尾工具 → 沉默结束本轮。',
        '',
        '# review 协议（强约束）',
        '',
        '收到 turn_end / verify_result / review_result 等"主 AI 已产出"类事件时：',
        '1) **必须**至少调用一次 `Glob` 或 `Read`（针对 modified_in_plan 文件）——不可跳过；',
        '2) 怀疑有 TODO / FIXME / 桩函数 / 假数据时，调用 `Grep` 验证；',
        '3) 完成检查后再调用收尾工具。',
        '**绝不可以只在自然语言里说"我读了 XXX 文件"而不真正发出 tool_use**——只信主 AI 自述、跳过文件检查直接收尾视为协议违例，本轮判失败。',
        '',
        '收到 user_input / start 等"无产出"事件时，可以直接收尾不调文件工具。',
        '',
        '# 反幻觉规则（强约束）',
        '',
        '`dispatch_to_main_ai` / `retry_main_ai_with_hint` 是派单的唯一事实来源。系统以"你本轮是否真的调用过这两个工具之一"判定派单是否发生，**不看**你的自然语言陈述。',
        '',
        '- **禁止在 narration / reason 里虚构事实**。以下断言只有在本轮真的调过 dispatch/retry 工具后才合法：',
        '  - "已派单 / 已下发 / 已发送指令给主 AI"',
        '  - "主 AI 已 ack / ping 通过 / 已上线 / 已确认在线"',
        '  - "主 AI 完成 X / 主 AI 回执 X"',
        '- **派单是动作不是描述**。想让主 AI 做任何事，**先调 dispatch/retry 工具，再说**。',
        '',
        '# 行为约束',
        '- 方案 plan.md 是标准答案。主 AI 不能擅自偏离；偏离时用 `retry_main_ai_with_hint` 要求修正，或 `emit_action(record_alert, category=C2)` 升级。',
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
        // Phase 4 (2026-05-24): rotation-aware extras. The Java
        // RotationCoordinator passes successorPromptAppend (rendered handoff
        // doc + behavioural directives) on every generation > 0 start.
        // generation is informational — printed in diagnostics, may be used
        // by Phase 5+ for telemetry filtering.
        successorPromptAppend,
        generation,
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
        return {
            alreadyRunning: true,
            protocolVersion: PROTOCOL_VERSION,
            supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
        };
    }

    let systemPrompt = buildSystemPrompt({ name, description, planContent, specContent });
    // Phase 4: append the rendered handoff / bootstrap appendix so the
    // generation > 0 supervisor reads its inheritance inline with BASE.
    // BASE itself is always rebuilt from the same configuration, so the
    // user's persona text never drifts across generations.
    if (successorPromptAppend && typeof successorPromptAppend === 'string'
            && successorPromptAppend.length > 0) {
        systemPrompt = systemPrompt + '\n\n' + successorPromptAppend;
        process.stdout.write(
            `[supervisor] gen=${generation ?? '?'} successorPromptAppend bytes=${successorPromptAppend.length}\n`
        );
    }

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
    // Phase 3 (2026-05-24): pass runtimeRef so the server also exposes
    // update_state — emits [STATE_UPDATE] lines that Java's L2Store consumes.
    //
    // 2026-05-26: first-wins capture guard. Closing tools (emit_action /
    // dispatch_to_main_ai / retry_main_ai_with_hint) must be called exactly
    // once per turn. Without this guard, an LLM that called
    // dispatch_to_main_ai followed by emit_action(wait) would silently overwrite
    // the dispatch — the wrapper would carry wait, Java would see no
    // inject_prompt, and the main AI would never receive the prompt while the
    // supervisor narration claimed it did. We surface a hard error on the
    // second attempt so the LLM learns to stop at one closing tool.
    const onCaptureGuarded = (action) => {
        if (runtime.lastCapturedAction !== null) {
            console.error(
                `[CAPTURE_GUARD] duplicate closing-tool call rejected pair=${runtime.pairId} `
                + `supervisor=${runtime.supervisorId} turnId=${runtime.currentTurnId || '?'} `
                + `first=${runtime.lastCapturedAction.action} `
                + `second=${(action && action.action) || '?'}`
            );
            return false;
        }
        runtime.lastCapturedAction = action;
        return true;
    };
    const supervisorMcpServer = buildSupervisorMcpServer(
        sdk,
        zod,
        onCaptureGuarded,
        { pairId: runtime.pairId, supervisorId: runtime.supervisorId }
    );

    // Allow emit_action + dispatch_to_main_ai + retry_main_ai_with_hint +
    // update_state + save_plan + read-only file tools + Task by default.
    // Protocol v2: supervisor now owns its own subagents for review/manifest
    // extraction. 2026-05-26: dispatch_to_main_ai replaces emit_action
    // (inject_prompt) for new task assignment; retry_main_ai_with_hint replaces
    // emit_action(retry_with_hint) for review feedback. emit_action stays for
    // non-dispatch decisions (wait / approve / record_alert / request_amendment).
    const allowedToolList = [
        QUALIFIED_EMIT_ACTION,
        QUALIFIED_DISPATCH_TO_MAIN_AI,
        QUALIFIED_RETRY_MAIN_AI_WITH_HINT,
        QUALIFIED_UPDATE_STATE,
        QUALIFIED_SAVE_PLAN,
        ...SUPERVISOR_READ_TOOLS,
        ...SUPERVISOR_AGENT_TOOLS,
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
            // 2026-05-28: emit partial-message stream_event frames so the
            // supervisor's WaitingIndicator can show a live "↓ N tokens" counter
            // during the turn. collectAssistantTurn consumes these for the live
            // estimate ONLY — rendering stays driven by complete assistant
            // messages, so no double-render. See the stream_event branch.
            includePartialMessages: true,
            // The SDK accepts a string-or-object systemPrompt. Use a string here so the
            // claude_code preset is NOT activated — Supervisor must obey OUR persona,
            // not Claude Code's default agent instructions.
            systemPrompt: runtime.systemPrompt,
            mcpServers: { [SUPERVISOR_MCP_NAME]: supervisorMcpServer },
            allowedTools: allowedToolList,
            // Phase 3 (2026-05-24): register PreCompact hook so the SDK
            // pings us before auto-compacting; the Java side dumps an L2
            // snapshot per emission for rotation-fallback safety.
            hooks: {
                PreCompact: [{
                    hooks: [buildPreCompactHook({
                        pairId: runtime.pairId,
                        supervisorId: runtime.supervisorId,
                    })],
                }],
            },
            // Defensive allowlist: pre-approve emit_action / update_state /
            // save_plan / read-only file tools / Task. Deny everything else
            // even if it slips into allowedTools by mistake. Note we never
            // allow Edit/Write/Bash here — only the main AI edits.
            canUseTool: async (toolName) => {
                if (toolName === QUALIFIED_EMIT_ACTION) {
                    return { behavior: 'allow' };
                }
                if (toolName === QUALIFIED_DISPATCH_TO_MAIN_AI) {
                    return { behavior: 'allow' };
                }
                if (toolName === QUALIFIED_RETRY_MAIN_AI_WITH_HINT) {
                    return { behavior: 'allow' };
                }
                if (toolName === QUALIFIED_UPDATE_STATE) {
                    return { behavior: 'allow' };
                }
                if (toolName === QUALIFIED_SAVE_PLAN) {
                    return { behavior: 'allow' };
                }
                if (SUPERVISOR_READ_TOOLS.includes(toolName)) {
                    return { behavior: 'allow' };
                }
                if (SUPERVISOR_AGENT_TOOLS.includes(toolName)) {
                    return { behavior: 'allow' };
                }
                if (runtime.allowedTools.includes(toolName)) {
                    return { behavior: 'allow' };
                }
                return {
                    behavior: 'deny',
                    message: `Supervisor sessions may only call ${QUALIFIED_EMIT_ACTION} / ${QUALIFIED_DISPATCH_TO_MAIN_AI} / ${QUALIFIED_RETRY_MAIN_AI_WITH_HINT} / ${QUALIFIED_UPDATE_STATE} / ${QUALIFIED_SAVE_PLAN}, Task (subagent dispatch), or read-only file tools (Read/Glob/Grep).`,
                };
            },
        },
    });

    runtimes.set(k, runtime);
    process.stdout.write(`[supervisor] started: ${k} (model=${runtime.model}, protocol=${PROTOCOL_VERSION})\n`);
    // Appendix B (plan §附录 B): advertise the protocol set so the Java client
    // can pick one it understands. No v1 fallback is wired today — daemon and
    // Java both code to v2 only — but logging it gives a clean handle for
    // future mismatches (or for the user to confirm the daemon is up to date).
    return {
        started: true,
        key: k,
        protocolVersion: PROTOCOL_VERSION,
        supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
    };
}

/**
 * Post an event to the supervisor; wait for its next ACTION; emit a NDJSON
 * line tagged with the current request id, so Java can demux the response.
 *
 * The returned promise resolves once the supervisor turn ends or fails.
 */
export async function postEventToSupervisor(params) {
    const { pairId, supervisorId, event, role: requestedRole } = params || {};
    if (!pairId || !supervisorId) {
        throw new Error('supervisor.postEvent requires pairId and supervisorId');
    }
    // Contract State Machine v3 (2026-05-25): Java may request role='system'
    // for framework-injected messages (R3 DECISION_REQUEST). Default 'user'
    // preserves all legacy callers. We accept 'system' iff the SDK exposes
    // it — fall back to 'user' with a "[SYSTEM] " content prefix otherwise
    // so the message still reaches supervisor, just as a marked user msg.
    const role = (requestedRole === 'system') ? 'system' : 'user';

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

        // Enqueue the summarized event into the SDK input stream.
        // - role='user'   : legacy path; appears as a user turn in supervisor history
        // - role='system' : Contract State Machine v3; framework-injected
        //                   message (e.g. R3 DECISION_REQUEST). Some SDK
        //                   versions reject role='system' for streamed input;
        //                   we fall back to 'user' with a "[SYSTEM] " prefix
        //                   so the supervisor still sees it (prompt template
        //                   tells it to treat such markers as system msgs).
        const enqueueText = role === 'system' ? '[SYSTEM] ' + summary : summary;
        try {
            runtime.inputStream.enqueue({
                type: role === 'system' ? 'system' : 'user',
                session_id: '',
                parent_tool_use_id: null,
                message: {
                    role: role,
                    content: [{ type: 'text', text: enqueueText }],
                },
            });
        } catch (e) {
            // SDK rejected role='system' (older claude-agent-sdk).
            // Retry as 'user' with the [SYSTEM] marker so the message still lands.
            if (role === 'system') {
                console.error(
                    `[supervisor-channel] system-role enqueue failed for ${pairId}; `
                    + `falling back to user with marker: ${e.message}`
                );
                runtime.inputStream.enqueue({
                    type: 'user',
                    session_id: '',
                    parent_tool_use_id: null,
                    message: {
                        role: 'user',
                        content: [{ type: 'text', text: enqueueText }],
                    },
                });
            } else {
                throw e;
            }
        }

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

        // 2026-05-24 (Q4 trace): log inject_prompt actions written to IPC so we
        // can correlate the daemon write with Java's ActionRouter receipt. If
        // Java says it never saw an inject_prompt while this line shows one,
        // the IPC demuxer is dropping the message.
        const actionType = wrapper.action && wrapper.action.action;
        if (actionType === 'inject_prompt' || actionType === 'retry_with_hint') {
            const p = (wrapper.action && wrapper.action.payload) || {};
            console.error(
                `[INJECT_TRACE] daemon wrote [SUPERVISOR_ACTION] `
                + `action=${actionType} directiveId=${p.directiveId || '(none)'} `
                + `turnId=${wrapper.turnId || '?'} parseError=${wrapper.parseError || 'null'}`
            );
        }

        // Phase 2: track liveness for supervisor.health.
        runtime.lastActivityAt = Date.now();

        return { ok: true };
    } finally {
        runtime.currentTurnId = null;
        release();
    }
}

/**
 * Phase 4 (2026-05-24): run one supervisor turn driven by the Java-provided
 * producer prompt; extract the model's JSON output and emit it back as a
 * {@code [HANDOFF_DOC]} envelope for the rotation coordinator to parse.
 *
 * <p>Differs from {@code postEventToSupervisor} in three ways:
 * <ul>
 *   <li>Caller-controlled user message (the producer prompt) instead of a
 *       summarised event.</li>
 *   <li>Output is the assistant's prose JSON, not an {@code emit_action}
 *       capture. We deliberately do NOT clear {@code lastCapturedAction}
 *       afterwards in case the model also called emit_action — but rotation
 *       discards that on purpose.</li>
 *   <li>Tagged response prefix is {@code [HANDOFF_DOC]} rather than
 *       {@code [SUPERVISOR_ACTION]}.</li>
 * </ul>
 *
 * <p>Best-effort JSON extraction:
 * <ol>
 *   <li>Strip ```json ... ``` code fences if present.</li>
 *   <li>Take the first {@code {} ... {@code }} balanced block.</li>
 *   <li>If parsing fails, still emit the envelope with {@code valid: false}
 *       so Java surfaces a precise error to the rotation coordinator (which
 *       then retries with the validation-error prompt variant).</li>
 * </ol>
 */
export async function produceHandoffForSupervisor(params) {
    const { pairId, supervisorId, prompt } = params || {};
    if (!pairId || !supervisorId) {
        throw new Error('supervisor.produceHandoff requires pairId and supervisorId');
    }
    if (typeof prompt !== 'string' || prompt.length === 0) {
        throw new Error('supervisor.produceHandoff requires non-empty prompt');
    }

    const runtime = runtimes.get(key(pairId, supervisorId));
    if (!runtime || runtime.disposed) {
        const err = new Error(
            `SUPERVISOR_NOT_FOUND supervisor session not found or disposed: ${pairId}:${supervisorId}`
        );
        err.code = 'SUPERVISOR_NOT_FOUND';
        throw err;
    }

    // Serialise with other postEvent turns on the same runtime.
    const prev = runtime.busy;
    let release;
    runtime.busy = new Promise((resolve) => { release = resolve; });

    try {
        await prev;

        runtime.lastCapturedAction = null;
        const turnId = `handoff_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        runtime.currentTurnId = turnId;

        runtime.inputStream.enqueue({
            type: 'user',
            session_id: '',
            parent_tool_use_id: null,
            message: {
                role: 'user',
                content: [{ type: 'text', text: prompt }],
            },
        });

        const turn = await collectAssistantTurn(runtime);
        const raw = (turn.assistantText || '').trim();
        const extracted = extractFirstJsonBlock(raw);
        let envelope;
        if (extracted == null) {
            envelope = {
                pairId, supervisorId, turnId,
                valid: false,
                error: 'no JSON block found in assistant output',
                raw,
                json: null,
            };
        } else {
            envelope = {
                pairId, supervisorId, turnId,
                valid: true,
                json: extracted,
                raw,
            };
        }
        process.stdout.write('[HANDOFF_DOC] ' + JSON.stringify(envelope) + '\n');

        runtime.lastActivityAt = Date.now();
        return { ok: true };
    } finally {
        runtime.currentTurnId = null;
        release();
    }
}

/**
 * Best-effort: take the largest balanced {...} block from a string. Strips
 * markdown ```json fences first. Returns the JSON SUBSTRING (not parsed) —
 * Java parses + validates on its side so we don't double-decode.
 */
function extractFirstJsonBlock(text) {
    if (!text) return null;
    let s = text;
    // Strip ```json or ``` fences
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) {
        s = fence[1];
    }
    // Find first { and matching } using a depth counter
    const start = s.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inString) {
            if (escape) { escape = false; continue; }
            if (ch === '\\') { escape = true; continue; }
            if (ch === '"') { inString = false; }
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) {
                return s.slice(start, i + 1);
            }
        }
    }
    return null;
}

/**
 * Phase 2 (2026-05-24): query the SDK's real context-window usage breakdown
 * for a supervisor session. Writes a `[CONTEXT_USAGE]` line tagged with the
 * active request id so the Java SupervisorBridge can resolve a Future with
 * the parsed payload.
 *
 * <p>The SDK method is named {@code getContextUsage} on the Query interface
 * (sdk.d.ts line 2167). It returns category-bucketed token counts (system
 * prompt / tools / messages / memory / mcp), the total, and the model's
 * context window — much more accurate than our existing input+output rollup.
 */
export async function getSupervisorContextUsage(params) {
    const { pairId, supervisorId } = params || {};
    if (!pairId || !supervisorId) {
        throw new Error('supervisor.getContextUsage requires pairId and supervisorId');
    }
    const runtime = runtimes.get(key(pairId, supervisorId));
    if (!runtime || runtime.disposed) {
        const err = new Error(
            `SUPERVISOR_NOT_FOUND supervisor session not found or disposed: ${pairId}:${supervisorId}`
        );
        err.code = 'SUPERVISOR_NOT_FOUND';
        throw err;
    }
    if (!runtime.query || typeof runtime.query.getContextUsage !== 'function') {
        const err = new Error('Loaded SDK does not expose Query.getContextUsage');
        err.code = 'SDK_FEATURE_UNAVAILABLE';
        throw err;
    }
    // Race against a short timeout — getContextUsage is a control request
    // (round-trips to the CLI host) so a stuck CLI should not hang our health
    // check forever.
    const usage = await Promise.race([
        runtime.query.getContextUsage(),
        new Promise((_, reject) => setTimeout(
            () => reject(new Error('SUPERVISOR_CONTEXT_USAGE_TIMEOUT')), 8_000
        )),
    ]);

    // Try to compute a 0..1 ratio. SDK shape varies across versions; defend
    // against missing fields by walking common candidates.
    const totalUsed = pickNum(usage, ['totalTokens', 'total', 'usedTokens']);
    const contextLimit = pickNum(usage, ['contextLimit', 'maxTokens', 'limit', 'windowSize']);
    const ratio = (totalUsed != null && contextLimit > 0)
        ? Math.min(1, totalUsed / contextLimit)
        : null;

    const line = {
        pairId,
        supervisorId,
        ts: Date.now(),
        ratio,
        totalUsed,
        contextLimit,
        breakdown: usage,
    };
    process.stdout.write('[CONTEXT_USAGE] ' + JSON.stringify(line) + '\n');
    return { ok: true };
}

function pickNum(obj, keys) {
    if (!obj || typeof obj !== 'object') return null;
    for (const k of keys) {
        const v = obj[k];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return null;
}

/**
 * Phase 2: synthesise a single-shot health snapshot for the Pair status
 * panel. Includes liveness, runtime age, compaction tally, and the current
 * inputStream pending size — does NOT call into the SDK (cheap, safe to
 * call every tick even if the supervisor is mid-turn).
 *
 * <p>For a richer snapshot that includes real context usage, callers should
 * make a second `supervisor.getContextUsage` round-trip; we keep them
 * separate because getContextUsage is a control request that may stall.
 */
export async function getSupervisorHealth(params) {
    const { pairId, supervisorId } = params || {};
    if (!pairId || !supervisorId) {
        throw new Error('supervisor.health requires pairId and supervisorId');
    }
    const runtime = runtimes.get(key(pairId, supervisorId));
    const now = Date.now();
    let line;
    if (!runtime || runtime.disposed) {
        line = {
            pairId,
            supervisorId,
            ts: now,
            alive: false,
        };
    } else {
        line = {
            pairId,
            supervisorId,
            ts: now,
            alive: true,
            createdAt: runtime.createdAt,
            ageMs: now - runtime.createdAt,
            lastActivityAt: runtime.lastActivityAt,
            inactiveMs: now - (runtime.lastActivityAt || runtime.createdAt),
            compactCount: runtime.compactCount || 0,
            lastCompactAt: runtime.lastCompactAt,
            inputStreamPending: typeof runtime.inputStream?.size === 'function'
                ? runtime.inputStream.size() : null,
            inputStreamDropped: typeof runtime.inputStream?.droppedCount === 'function'
                ? runtime.inputStream.droppedCount() : null,
            currentTurnInProgress: runtime.currentTurnId != null,
            model: runtime.model,
        };
    }
    process.stdout.write('[SUPERVISOR_HEALTH] ' + JSON.stringify(line) + '\n');
    return { ok: true };
}

/**
 * Phase 2: best-effort interrupt of the currently-running supervisor turn.
 * Used by the monitor when a tick times out (Phase 1 sets health=DEGRADED
 * and would benefit from interrupting before the next round). The SDK
 * documents {@code Query.interrupt} as only valid in streaming-input mode,
 * which the supervisor channel always uses.
 */
export async function interruptSupervisor(params) {
    const { pairId, supervisorId } = params || {};
    if (!pairId || !supervisorId) {
        throw new Error('supervisor.interrupt requires pairId and supervisorId');
    }
    const k = key(pairId, supervisorId);
    const runtime = runtimes.get(k);
    if (!runtime || runtime.disposed) {
        // Nothing to interrupt — the turn is already over (or the runtime was
        // disposed). That's success from the caller's POV: emit a result line
        // so Java settles the request and clears the thinking spinner. We do
        // NOT throw SUPERVISOR_NOT_FOUND here: interrupt is fire-and-forget and
        // an absent runtime means "already stopped", not a recoverable error.
        process.stdout.write('[SUPERVISOR_INTERRUPT_RESULT] ' + JSON.stringify({
            pairId, supervisorId, ts: Date.now(),
            interrupted: false, forceStopped: false, error: 'SUPERVISOR_NOT_FOUND',
        }) + '\n');
        return { ok: true };
    }

    // Capture the in-flight turn's barrier BEFORE we touch anything. postEvent
    // reassigns runtime.busy per turn and clears runtime.currentTurnId in its
    // finally, so these two snapshots let us tell whether the turn actually
    // ended after interrupt() — not just whether interrupt() resolved.
    const busyAtCall = runtime.busy;
    const turnWasActive = runtime.currentTurnId != null;
    let interrupted = false;
    let forceStopped = false;
    let error = null;

    // 1) Graceful interrupt — preserves the SDK session/context so the
    //    supervisor can keep observing after the current turn is cut short.
    if (typeof runtime.query?.interrupt === 'function') {
        try {
            await Promise.race([
                runtime.query.interrupt(),
                new Promise((_, reject) => setTimeout(
                    () => reject(new Error('INTERRUPT_TIMEOUT')), 3_000
                )),
            ]);
            interrupted = true;
        } catch (e) {
            error = e?.message || String(e);
        }
    } else {
        error = 'SDK does not expose Query.interrupt';
    }

    // 2) Confirm the turn actually SETTLED. query.interrupt() resolving only
    //    means the interrupt was accepted; a turn wedged in extended-thinking
    //    can still be blocked inside `await query.next()` (collectAssistantTurn
    //    awaits it unbounded since the 2026-05-25 cap removal). Wait on the
    //    captured busy barrier — it resolves via postEvent's finally release()
    //    when the turn ends or fails — for a short grace period.
    let settled = !turnWasActive || runtime.currentTurnId == null;
    if (!settled) {
        settled = await Promise.race([
            busyAtCall.then(() => true, () => true),
            new Promise((r) => setTimeout(() => r(false), 2_500)),
        ]);
    }

    // 3) Hard-stop fallback. interrupt() did not unwedge the turn in time, so
    //    force the transport down exactly like the main-AI abort path does via
    //    disposeRuntime: query.close() rejects the blocked query.next(), which
    //    unwinds collectAssistantTurn -> postEvent rejects -> the daemon writes
    //    the request's done line -> Java fires onPairThinking(false) and the
    //    spinner clears. Deleting the runtime is safe: the next postEvent hits
    //    the SUPERVISOR_NOT_FOUND lazy-restart path and recreates it.
    if (!settled) {
        forceStopped = true;
        runtime.disposed = true;
        try { runtime.inputStream.done(); } catch { /* ignore */ }
        try {
            if (typeof runtime.query?.close === 'function') {
                runtime.query.close();
            } else if (typeof runtime.query?.return === 'function') {
                await Promise.race([
                    runtime.query.return(),
                    new Promise((r) => setTimeout(r, 2_000)),
                ]);
            }
        } catch (e) {
            error = error || (e?.message || String(e));
        }
        runtimes.delete(k);
    }

    process.stdout.write('[SUPERVISOR_INTERRUPT_RESULT] ' + JSON.stringify({
        pairId, supervisorId, ts: Date.now(), interrupted, forceStopped, error,
    }) + '\n');
    return { ok: true };
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
    // 2026-05-25 (FUNDAMENTAL FIX): per-frame timing + previous-frame kind
    // are kept ONLY for diagnostic logging. They no longer drive timeouts;
    // the active path waits as long as the SDK takes. See header comment on
    // QUERY_NEXT_TIMEOUT_MS for the design rationale.
    const turnStartMs = Date.now();
    let lastFrameMs = turnStartMs;
    let prevFrameKind = 'init'; // init | tool_use | compact | text | result | other
    let lastToolUseName = null;
    // Live output-token estimate (2026-05-28): streamed chars (text + thinking)
    // + last-emit timestamp for throttling + authoritative running output from
    // message_delta. Drives the supervisor pane's live "↓ N tokens".
    let streamedOutputChars = 0;
    let lastLiveUsageEmitMs = 0;
    let liveRealOutputTokens = 0;
    while (true) {
        if (runtime.disposed) {
            throw new Error('Supervisor runtime disposed mid-turn');
        }
        let next;
        // Stage is logged only — by default we await unbounded. Env-opted-in
        // wall-clock caps are honoured by nextWithOptionalTimeout (emergency
        // rollback knob; not used in default deployments).
        const stage = prevFrameKind === 'compact' ? 'after_compact'
            : prevFrameKind === 'tool_use' ? 'after_tool_use'
            : 'default';
        const frameTimeoutMs = stage === 'after_compact' ? QUERY_NEXT_TIMEOUT_AFTER_COMPACT_MS
            : stage === 'after_tool_use' ? QUERY_NEXT_TIMEOUT_AFTER_TOOL_USE_MS
            : QUERY_NEXT_TIMEOUT_MS;
        try {
            next = await nextWithOptionalTimeout(runtime.query, frameTimeoutMs, stage);
        } catch (err) {
            const msg = err?.message ?? String(err);
            if (msg.startsWith('SUPERVISOR_QUERY_TIMEOUT')) {
                // Env-opted-in cap actually fired — surface diagnostic, do
                // NOT cancel the SDK iterator (the operator chose this knob
                // explicitly and the next postEvent will still be serviced).
                const elapsedMs = Date.now() - turnStartMs;
                const sinceLastFrameMs = Date.now() - lastFrameMs;
                console.error(
                    `[supervisor-diag] ENV_TIMEOUT stage=${stage} frame_cap=${frameTimeoutMs}ms `
                    + `prev_frame=${prevFrameKind}${lastToolUseName ? `(${lastToolUseName})` : ''} `
                    + `since_last_frame=${sinceLastFrameMs}ms turn_elapsed=${elapsedMs}ms `
                    + `pair=${runtime.pairId} supervisor=${runtime.supervisorId} `
                    + `seen=[${seenTypes.slice(-10).join(', ')}]`
                );
                try { if (typeof runtime.query?.return === 'function') runtime.query.return(); }
                catch { /* ignore */ }
                const e = new Error('SUPERVISOR_QUERY_TIMEOUT: ' + msg);
                e.code = 'SUPERVISOR_QUERY_TIMEOUT';
                throw e;
            }
            // Real SDK-layer error (network failure, malformed response, etc).
            // Bubble it; do NOT synthesize a generic timeout error.
            throw new Error('Supervisor SDK iteration failed: ' + msg);
        }
        // A frame returned — reset heartbeat (for the diagnostic log).
        lastFrameMs = Date.now();
        if (next?.done) break;

        const msg = next.value;
        if (!msg) continue;

        // Live-usage path (2026-05-28): with includePartialMessages on, the SDK
        // yields stream_event frames. Consume them ONLY for the live output-token
        // ticker, then skip the rest (no streamSdkMessage / no content
        // extraction) so rendering stays driven by the complete assistant
        // messages below — no double-render.
        if (msg.type === 'stream_event' && msg.event) {
            const ev = msg.event;
            if (ev.type === 'message_delta' && ev.usage
                    && typeof ev.usage.output_tokens === 'number') {
                liveRealOutputTokens = ev.usage.output_tokens;
            }
            if (ev.type === 'content_block_delta' && ev.delta) {
                const chunk = ev.delta.type === 'text_delta' ? (ev.delta.text || '')
                    : ev.delta.type === 'thinking_delta' ? (ev.delta.thinking || '')
                    : '';
                if (chunk) {
                    streamedOutputChars += chunk.length;
                    const now = Date.now();
                    if (now - lastLiveUsageEmitMs >= 150) {
                        lastLiveUsageEmitMs = now;
                        const est = estimateTokensFromChars(streamedOutputChars);
                        emitSupervisorLiveUsage(runtime, Math.max(liveRealOutputTokens, est));
                    }
                }
            }
            continue;
        }

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
            let sawToolUse = false;
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
                    // the main AI's tool card rendering. The MCP closing tools
                    // (emit_action / dispatch_to_main_ai / retry_main_ai_with_hint)
                    // are filtered out — they're internal protocol details
                    // rendered as the supervisor's action card, not as a
                    // separate tool card.
                    const isMcpAction = typeof block.name === 'string'
                        && (block.name.includes(EMIT_ACTION_TOOL_NAME)
                            || block.name.includes(DISPATCH_TO_MAIN_AI_TOOL_NAME)
                            || block.name.includes(RETRY_MAIN_AI_WITH_HINT_TOOL_NAME));
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
                    // 2026-05-24 (Q1): even emit_action counts as a tool_use
                    // for next-frame timing — the SDK still needs to deliver
                    // the tool_result on the next frame, which is normally fast
                    // but can be slow under load. Track ALL tool calls.
                    sawToolUse = true;
                    if (typeof block.name === 'string') lastToolUseName = block.name;
                }
            }
            // Per-message usage rollup, in case the result message doesn't carry one.
            if (msg.message.usage) lastUsage = msg.message.usage;
            // 2026-05-24 (Q1): if this assistant frame dispatched a tool, the
            // NEXT next() call is waiting for the tool to run + its result to
            // be delivered. Read/Glob/Grep finish in seconds, but Task subagents
            // can take minutes — use the heavier cap. Pure text/thinking frames
            // get the default cap (model just keeps producing).
            prevFrameKind = sawToolUse ? 'tool_use' : 'text';
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
            // Model now needs to react to the tool result — usually fast,
            // but on heavy results (Task subagent returning a 50KB manifest)
            // it can think for a while. Keep default cap.
            prevFrameKind = 'tool_result';
        } else if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
            // CLI auto-compaction event — the conversation history was just
            // summarised down to fit the model's context window. We pass the
            // before/after token counts to the UI so the user understands
            // why earlier turns suddenly look terser.
            compactEvents.push({
                trigger: msg.compact_metadata?.trigger || 'auto',
                preTokens: msg.compact_metadata?.pre_tokens ?? null,
            });
            // Phase 2 (2026-05-24): also surface compaction as a discrete
            // tagged stdout line so the Java SupervisorBridge can keep a
            // per-pair compactCount counter — used by the rotation triggers
            // in Phase 5. The line is request-id-tagged automatically by
            // daemon.js since collectAssistantTurn runs inside the active
            // postEvent request.
            try {
                process.stdout.write(`[COMPACT_BOUNDARY] ${JSON.stringify({
                    pairId: runtime.pairId,
                    supervisorId: runtime.supervisorId,
                    ts: Date.now(),
                    trigger: msg.compact_metadata?.trigger || 'auto',
                    preTokens: msg.compact_metadata?.pre_tokens ?? null,
                })}\n`);
            } catch (_) { /* stdout closed */ }
            // Update the runtime's compaction tally — accessed by the
            // supervisor.health endpoint.
            runtime.compactCount = (runtime.compactCount || 0) + 1;
            runtime.lastCompactAt = Date.now();
            // 2026-05-24 (Q1): post-compaction the model has to re-process its
            // entire (now compressed) history before producing the next frame
            // — give it more headroom.
            prevFrameKind = 'compact';
        } else if (msg.type === 'result') {
            if (msg.usage) lastUsage = msg.usage;
            break;
        } else {
            prevFrameKind = 'other';
        }
    }
    // One-line per-turn diagnostic. Goes to daemon stderr via console.error
    // (intercepted by daemon.js and forwarded as a daemon stderr line, NOT
    // a request-tagged stdout line — so it doesn't pollute the IPC stream).
    // Read it via the IDE's daemon-stderr log when triaging "0% never moves"
    // or "no tool cards" complaints.
    const turnDurMs = Date.now() - turnStartMs;
    console.error(
        `[supervisor-diag] turn complete: dur=${turnDurMs}ms msgs=[${seenTypes.join(', ')}] `
        + `tools=${toolEvents.length} compact=${compactEvents.length} `
        + `captured_action=${runtime.lastCapturedAction ? runtime.lastCapturedAction.action : 'null'} `
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
 * 2026-05-28: emit a live output-token estimate for the supervisor turn, tagged
 * like {@link streamSdkMessage} so Java can route it by pairId/supervisorId. The
 * count is the larger of the authoritative message_delta output and the streamed
 * char estimate (never moves backward). Best-effort — a dropped line just skips
 * one tick, never breaks the turn.
 */
function emitSupervisorLiveUsage(runtime, outputTokens) {
    try {
        const envelope = {
            pairId: runtime.pairId,
            supervisorId: runtime.supervisorId,
            turnId: runtime.currentTurnId,
            outputTokens,
        };
        process.stdout.write('[SUPERVISOR_USAGE] ' + JSON.stringify(envelope) + '\n');
    } catch (e) {
        console.error('[supervisor-stream] failed to emit live usage: '
            + (e?.message || String(e)));
    }
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
        // Protocol v2 (2026-05-24): surface directiveId at the wrapper top so
        // Java's ActionRouter + DirectiveTracker can correlate without diving
        // into payload. Only inject_prompt / retry_with_hint get a directiveId
        // (assigned by normalizeAction); other actions stay null.
        const directiveId = capturedAction?.payload?.directiveId || null;
        return {
            pairId,
            supervisorId,
            naturalText: '',
            reasoningText: '',
            action: capturedAction,
            directiveId,
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
        directiveId: null,
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
