/**
 * Supervisor Channel.
 *
 * Runs a parallel Claude SDK Query session that observes the main AI's event
 * stream (forwarded from Java) and emits structured ACTION decisions.
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
 *   3. Iterates the SDK query result until turn_end
 *   4. Parses the ACTION block from the final assistant text
 *   5. Writes a single `{ id, type: 'supervisor_action', ... }` NDJSON line back
 *
 * Each pair_supervisor combination holds its own runtime; closing it disposes
 * the SDK query and removes the entry.
 */

import { loadClaudeSdk, isClaudeSdkAvailable } from '../utils/sdk-loader.js';
import { AsyncStream } from '../utils/async-stream.js';
import { summarizeEvent } from '../services/supervisor/event-summarizer.js';
import { parseSupervisorOutput } from '../services/supervisor/action-parser.js';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

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
  }
}

function key(pairId, supervisorId) {
  return `${pairId}:${supervisorId}`;
}

/**
 * Compose the system prompt for the Supervisor LLM. Always emits the
 * structured-action contract; the agent's `description` field is the
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
      '在用户提供任务前，**保持沉默**——除非收到 user_input 事件，否则不要主动输出任何 ACTION。'
    );
  }

  if (specContent && specContent.trim()) {
    sections.push(
      '',
      '# 项目适用规范 / 技能包',
      '以下是当前项目启用的规范包。主 AI 每次产出后，把这些当作 review 检查项；',
      '违反时立即通过 inject_prompt 反馈具体违反点（引用规范名 + 文件:行号）。',
      '',
      specContent.trim()
    );
  }

  sections.push(
    '',
    '# 输出格式（强约束）',
    '每次决策按以下两段输出：',
    '1) 自然语言段：用 💭/✓/⚠️/⚡/→ 等符号简短描述观察、判断、决策。',
    '2) 一个 \`\`\`ACTION 代码块，包裹严格 JSON：',
    '',
    '```',
    '```ACTION',
    '{ "action": "...", "reason": "...", "payload": { ... } }',
    '```',
    '```',
    '',
    'action 必须是以下之一：',
    '- inject_prompt    payload.prompt (string, required)',
    '- retry_with_hint  payload.prompt (string), payload.wait_seconds (number, optional)',
    '- approve_and_continue',
    '- escalate_to_human  payload.question (string, required), payload.choices (string[]), payload.context_files (string[])',
    '- request_amendment  payload.reason (string), payload.proposal (string)',
    '- wait',
    '',
    '# 行为约束',
    '- 方案 plan.md 是标准答案。主 AI 不能擅自偏离；偏离时升级用户。',
    '- 一次只输出一个 ACTION。',
    '- 不要输出代码、不要输出多余 markdown 块。'
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
  } = params || {};

  if (!pairId || !supervisorId) {
    throw new Error('supervisor.start requires pairId and supervisorId');
  }

  const k = key(pairId, supervisorId);
  if (runtimes.has(k)) {
    // Idempotent: if already alive, return early.
    process.stdout.write(`[supervisor] session already running: ${k}\n`);
    return { alreadyRunning: true };
  }

  const systemPrompt = buildSystemPrompt({ name, description, planContent, specContent });

  const sdk = await loadClaudeSdk();
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

  // SDK options. Supervisor is judgment-only: no tools, no project-scoped settings,
  // no file checkpointing. We do still pass a cwd because the SDK requires one.
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
      // Supervisor doesn't execute tools by default. Callers can opt-in.
      allowedTools: runtime.allowedTools,
      // Block any tool attempts (defensive — even with empty allowedTools the
      // SDK may surface internal tool calls).
      canUseTool: async (_toolName, _input) => ({
        behavior: 'deny',
        message: 'Supervisor sessions cannot use tools.',
      }),
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
    throw new Error(`supervisor session not found or disposed: ${pairId}:${supervisorId}`);
  }

  // Serialize per-runtime so concurrent postEvent calls don't interleave turns.
  const prev = runtime.busy;
  let release;
  runtime.busy = new Promise((resolve) => { release = resolve; });

  try {
    await prev;
    const summary = summarizeEvent(event);

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
    const parsed = parseSupervisorOutput(turn.assistantText);

    // Emit a single NDJSON event line that the daemon-tagged stdout wraps
    // with the active request id. Java consumers see:
    //   { "id": "<reqId>", "line": "[SUPERVISOR_ACTION] {...}" }
    process.stdout.write('[SUPERVISOR_ACTION] ' + JSON.stringify({
      pairId,
      supervisorId,
      // The Supervisor LLM's structured reasoning prelude (from inside the
      // text block, before the ACTION JSON). Free-form natural language.
      naturalText: parsed.naturalText,
      // SDK-level reasoning blocks (if reasoning effort is enabled on the
      // model). Distinct from naturalText: this is the model's hidden chain
      // of thought, surfaced for transparency.
      reasoningText: turn.reasoningText || '',
      action: parsed.action,
      parseError: parsed.parseError || null,
      rawText: turn.assistantText,
    }) + '\n');

    return { ok: true };
  } finally {
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
 * Returns:
 *   - assistantText  — concatenated `text` blocks (the model's visible output;
 *                       contains the ACTION JSON code block and the natural
 *                       reasoning prelude described in our system prompt)
 *   - reasoningText  — concatenated `thinking` / reasoning blocks (the model's
 *                       hidden chain of thought, only present when reasoning
 *                       effort is enabled and the model supports it)
 */
async function collectAssistantTurn(runtime) {
  const textBuf = [];
  const reasoningBuf = [];
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
        }
      }
    } else if (msg.type === 'result') {
      break;
    }
    // tool_use / tool_result / system messages: silently consume.
  }
  return {
    assistantText: textBuf.join('').trim(),
    reasoningText: reasoningBuf.join('\n').trim(),
  };
}

/**
 * Diagnostic — useful for daemon shutdown hooks.
 */
export function getActiveSupervisorCount() {
  return runtimes.size;
}
