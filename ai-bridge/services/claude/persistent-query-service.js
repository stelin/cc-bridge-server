/**
 * Persistent query service for daemon mode.
 * Keeps Claude Query processes alive across turns to reduce per-request latency.
 */

import { isCustomBaseUrl, loadClaudeSettings, setupApiKey, buildCliEnv } from '../../config/api-config.js';
import { selectWorkingDirectory } from '../../utils/path-utils.js';
import {
  mapModelIdToSdkName,
  resolveModelFromSettings,
  setModelEnvironmentVariables
} from '../../utils/model-utils.js';
import { canUseTool } from '../../permission-handler.js';
import { buildContentBlocks, loadAttachments } from './attachment-service.js';
import { buildIDEContextPrompt } from '../system-prompts.js';
import { buildQuickFixPrompt } from '../quickfix-prompts.js';
import { registerActiveQueryResult, removeSession } from './message-service.js';
import { normalizePermissionMode } from './permission-mode.js';
import { truncateString } from './message-output-filter.js';
import {
  beginRuntimeTurn,
  cleanupStaleAnonymousRuntimes,
  cleanupStaleSessionRuntimes,
  disposeRuntime,
  registerRuntimeSession,
  acquireRuntime,
  buildRuntimeSignature,
  endRuntimeTurn,
  resetCachedQueryFn,
  setCachedQueryFn,
  touchRuntime,
} from './runtime-lifecycle.js';
import {
  SESSION_CLEANUP_INTERVAL_MS,
  clearActiveTurnRuntime,
  clearActiveTurnRuntimeIf,
  getActiveTurnRuntime,
  getAllRuntimes,
  getRuntimeForSession,
  getSnapshot,
  resetRegistryState,
  setActiveTurnRuntime,
} from './runtime-registry.js';
import {
  createTurnState,
  emitUsageTag,
  processMessageContent,
  processStreamEvent,
  processToolResultMessages,
  shouldOutputMessage,
} from './stream-event-processor.js';

const SUPPORTED_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function normalizeReasoningEffort(value) {
  const e = typeof value === 'string' ? value.trim() : '';
  if (!e) return null;
  if (SUPPORTED_EFFORT_LEVELS.has(e)) return e;
  console.warn(`[REASONING_EFFORT] ⚠️ unsupported effort value received: ${JSON.stringify(value)} — falling back to SDK default`);
  return null;
}

function resolveThinkingTokens(params, settings) {
  const alwaysThinkingEnabled = settings?.alwaysThinkingEnabled ?? true;
  const configuredMax = settings?.maxThinkingTokens
    || parseInt(process.env.MAX_THINKING_TOKENS || '0', 10)
    || 10000;

  if (params.disableThinking === true) return 0;
  if (alwaysThinkingEnabled) return configuredMax;
  return undefined;
}

function resolveStreamingEnabled(params, settings) {
  return params.streaming != null
    ? !!params.streaming
    : (settings?.streamingEnabled ?? false);
}

/**
 * Protocol v2 (2026-05-24): Pair-mode system prompt append. Inlined from
 * `jetbrains-cc-gui/src/main/resources/main-ai-system-prompt-append.md`.
 * If you edit this string you MUST also update that .md file (and vice versa)
 * — the .md is the human-readable canonical source; this copy is the runtime
 * shipper. Phase 5+ will move to a single shared source.
 *
 * Kept short here on purpose — long instructions live in the .md, but the
 * critical contract that the main AI MUST call report_turn_completion is
 * the load-bearing part for this protocol to work.
 */
const PAIR_MODE_SYSTEM_PROMPT_APPEND = [
  '# Supervisor Pair 模式约束',
  '',
  '你现在在 Supervisor Pair 协作模式下工作。supervisor 是你的协作者(类似 PM / 架构师),通过 `inject_prompt` 派任务,你执行后必须**结构化汇报**结果。',
  '',
  '## 强约束:每个 turn 必调 `report_turn_completion`',
  '',
  '在每个 turn 结束前,你**必须**调用 `mcp__main__report_turn_completion` 工具汇报本轮工作。',
  '**唯一例外**:本轮只输出了纯对话/澄清/没有任何代码或工具产出的解释性回复时,可以不调用。',
  '',
  '工具入参:',
  '- `summary`: 1-2 句任务级摘要',
  '- `deliverables`: 你新增/修改的文件清单(相对项目根 POSIX 路径)+ 每个文件 `change` 描述 + 可选 `confidence`',
  '- `verifications` (可选): 你跑过的命令 + pass/fail + 失败时 stderrTail (<=1KB)',
  '- `selfAssessment` (必填):',
  '  - `confidence`: high / medium / low',
  '  - `concerns`: 你自己觉得不踏实的具体点(空数组表示完全自信)',
  '  - `suggestedReview` (可选): 建议 supervisor 重点 review 哪里 (如 "user_dao.go:42-58")',
  '',
  '## confidence 怎么定',
  '- **high**: 做完 + verifications 全 pass + 没有 unaddressed concerns → supervisor 信任直接通过',
  '- **medium**: 主流程对了但某些边界没验证 → supervisor 会自己 Read 验证',
  '- **low**: 你按指令做了但心里没底 → supervisor 必派 code reviewer 子 agent 重 review',
  '',
  '**不要骗 supervisor** — 故意报 high 但实际有问题,后续会被发现,trust 降级到全部强制 reviewer。',
  '',
  '## inject_prompt 收到后',
  'supervisor 派来的 inject_prompt 是结构化任务派单,含 `objective` + `expectedDeliverables` (期望产出路径) + `acceptanceCriteria` (验收标准)。如果含 `spilledPath` (>8KB 指令存在磁盘文件), 先 Read 该路径再执行。',
  '',
  '你的 `deliverables` 应覆盖 `expectedDeliverables` 中所有路径(可以多但不能少)。',
  '',
  '## 你内部的子 agent',
  '你**可以**派 Task 子 agent (并行/隔离),这是你的内部行为不需要向 supervisor 解释。supervisor 通过 SubagentStop hook 自动看见子 agent 摘要 + transcript 路径。**但子 agent 的产出也算你的 deliverables**——子 agent 改的文件,你的 `deliverables` 数组也要列。',
  '',
  '## Contract State Machine v3 协议 (2026-05-25 新增)',
  '',
  'supervisor 派来的每个 inject_prompt 都对应一个 **Contract** (系统跟踪的工作契约)。你的 turn 必须按以下规则收尾。',
  '',
  '### 规则 1: turn 不允许以纯文本对话结尾',
  '每个 turn 必须以下三者之一结尾,**禁止**以"请发送..."、"我将立即..."、"等待..."、"请告诉我..."等等待型语句结束:',
  '1. **至少一个 tool_use** (实际执行了操作)',
  '2. **`mcp__main__report_turn_completion`** 调用 (显式汇报完成 / 阻塞 / 需澄清)',
  '3. **`mcp__main__ask_clarification`** 调用 (如果有,显式要求澄清——比纯文本提问可靠)',
  '',
  '违反此规则会被系统检测为"对话漂移",立即触发 R1 重推消息,影响协作效率。',
  '',
  '### 规则 2: 看到 [系统提示] 重推消息的处理',
  '如果消息以 `[系统提示] 这是 contract <id> 的第 N 次重推` 开头,说明你上一轮没有完成它。按以下三段式处理:',
  '- 如果**你已经完成**:立即调 `report_turn_completion(status="done")`,不要重做',
  '- 如果**你正在做**:无需重启,继续执行,完成后正常 report',
  '- 如果**你没开始**:立即按下面的原任务内容执行,不要再发任何文字解释',
  '',
  '### 规则 3: 看到 [系统提示] R2 强约束的处理',
  '如果消息说"你的下一个 turn 必须以下三者之一结尾",这是系统层的硬性要求——按规则 1 处理,不要再失败一次。',
  '',
  '### 规则 4: 重复消息以最新一条为准',
  '如果你看到同一任务在你的上下文中出现多次,**以最后一条的内容为准**,前面的视为过期版本。这是系统重推机制,不是 supervisor 改主意。',
  '',
  '## v3.1 协议变更 (2026-05-26)',
  '',
  '系统层加了 anti-hallucination guard,可能影响你看到的派单节奏:',
  '',
  '### 规则 5: supervisor 的 action 偶尔会被服务端拒绝',
  'supervisor 如果错误地 `emit_action(wait)`(典型 LLM 幻觉:narrate 说派单实际选了 wait),服务端 state-machine 会发 `{type:"action_rejected"}` 系统事件给 supervisor,要求它本轮改派正确 action。**对你的影响**:supervisor 可能比你预期晚 1 轮派单,这是正常自愈,不是 supervisor 卡住,不要主动再请求任务。',
  '',
  '### 规则 6: complete_plan = 项目结束的正式信号',
  'supervisor 在 plan 全部 step 完成后会调 `emit_action(complete_plan, {summary})`,Java 端立即写 COMPLETION_REPORT.md。**对你的影响**:你不需要做"等下个 tick 检测 isComplete"的等待——supervisor 调 complete_plan 后 pair 就结束了,你的最后一轮 report_turn_completion 就是收尾。',
].join('\n');

/**
 * Protocol v2 (2026-05-24): extract a leading {@code <!--pair-context:{...}-->}
 * marker from the systemPromptAppend string into a structured pairContext
 * object. Returns the cleaned remainder (without the marker) so the rest of
 * the prompt processing sees a normal append. No marker → returns input
 * unchanged + pairContext null.
 *
 * Why a marker instead of a dedicated IPC field: avoids threading a new
 * parameter through 5 layers of Java IPC (ClaudeSession → SessionSendService →
 * ClaudeSDKBridge → DaemonRequestExecutor → daemon RPC). One day Phase 5 may
 * promote this to a clean field; for now the marker is the smallest viable
 * wiring that lets the Pair-mode hooks + MCP server actually mount.
 */
const PAIR_CTX_MARKER_RE = /^<!--pair-context:({[\s\S]+?})-->\r?\n?/;
function extractInlinedPairContext(systemPromptAppendRaw) {
  if (typeof systemPromptAppendRaw !== 'string' || systemPromptAppendRaw.length === 0) {
    return { pairContext: null, cleaned: systemPromptAppendRaw };
  }
  const m = systemPromptAppendRaw.match(PAIR_CTX_MARKER_RE);
  if (!m) return { pairContext: null, cleaned: systemPromptAppendRaw };
  let parsed = null;
  try { parsed = JSON.parse(m[1]); } catch (_) { /* malformed, ignore */ }
  return { pairContext: parsed, cleaned: systemPromptAppendRaw.slice(m[0].length) };
}

function buildSystemPromptAppend(params) {
  const openedFiles = params.openedFiles || null;
  const agentPrompt = params.agentPrompt || null;
  // Phase 6c (2026-05-24): main-AI rotation handoff. Staged on the Java side
  // by ClaudeSession.swapInnerSession and consumed once by SessionSendService.
  // Concatenated with (not replacing) the IDE/agentPrompt append so the new
  // post-rotation runtime keeps the agent persona AND gets the handoff doc.
  // Order: handoff first (highest signal — recent user messages verbatim,
  // anchored facts, plan progress) — then IDE context. Last block tends to
  // get weighted heavier by the model, but in practice both are loaded into
  // the system prompt at the same priority; ordering is a tie-break.
  // Protocol v2: strip the pair-context marker from systemPromptAppend before
  // it goes into the model prompt (the marker is bookkeeping, not for the LLM).
  // The extracted pairContext is consumed by buildRequestContext below.
  const { pairContext: _ignored, cleaned: cleanedAppend } =
      extractInlinedPairContext(params.systemPromptAppend);
  const rotationAppend = (typeof cleanedAppend === 'string' && cleanedAppend.trim() !== '')
    ? cleanedAppend
    : null;
  let baseAppend;
  if (openedFiles && openedFiles.isQuickFix) {
    baseAppend = buildQuickFixPrompt(openedFiles, params.message || '');
  } else {
    baseAppend = buildIDEContextPrompt(openedFiles, agentPrompt);
  }

  // Protocol v2 (2026-05-24): Pair-mode append. Only injected when this send
  // is for a Pair-mode main AI (caller passed pairContext.pairId). Non-Pair
  // sends never see this prompt — they keep working without report_turn_completion.
  const pairAppend = (params.pairContext && typeof params.pairContext === 'object'
      && typeof params.pairContext.pairId === 'string' && params.pairContext.pairId.length > 0)
    ? PAIR_MODE_SYSTEM_PROMPT_APPEND
    : null;

  // Composition order: rotationAppend → baseAppend → pairAppend.
  // pairAppend goes last so the "must call report_turn_completion" rule is
  // the freshest in the model's context window when generating the response.
  const parts = [rotationAppend, baseAppend, pairAppend].filter(
    (p) => typeof p === 'string' && p.trim().length > 0
  );
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return parts.join('\n\n---\n\n');
}

function buildQueryOptions(workingDirectory, sdkModelName, permissionMode, maxThinkingTokens, streamingEnabled, systemPromptAppend, requestedSessionId, reasoningEffort) {
  return {
    cwd: workingDirectory,
    permissionMode,
    model: sdkModelName,
    maxTurns: 100,
    enableFileCheckpointing: true,
    env: buildCliEnv(),
    ...(maxThinkingTokens !== undefined && { maxThinkingTokens }),
    ...(reasoningEffort && { effort: reasoningEffort }),
    ...(streamingEnabled && { includePartialMessages: true }),
    additionalDirectories: Array.from(
      new Set(
        [workingDirectory, process.env.IDEA_PROJECT_PATH, process.env.PROJECT_PATH].filter(Boolean)
      )
    ),
    canUseTool,
    settingSources: ['user', 'project', 'local'],
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      ...(systemPromptAppend && { append: systemPromptAppend })
    },
    ...(requestedSessionId && { resume: requestedSessionId })
  };
}

async function buildUserMessage(params, withAttachments, requestedSessionId) {
  if (withAttachments) {
    const attachments = await loadAttachments({ attachments: params.attachments || [] });
    const contentBlocks = buildContentBlocks(attachments, params.message || '');
    return {
      type: 'user',
      session_id: requestedSessionId || '',
      parent_tool_use_id: null,
      message: { role: 'user', content: contentBlocks }
    };
  }

  const userText = (params.message || '').trim() || '[Empty message]';
  return {
    type: 'user',
    session_id: requestedSessionId || '',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text: userText }] }
  };
}

async function buildRequestContext(params, withAttachments) {
  setupApiKey();

  const baseUrl = process.env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_API_URL || '';
  if (isCustomBaseUrl(baseUrl)) {
    console.debug('[DEBUG] Custom Base URL detected');
  }

  const requestedSessionId = (typeof params.sessionId === 'string' && params.sessionId.trim() !== '')
    ? params.sessionId.trim()
    : null;
  const runtimeSessionEpoch = (typeof params.runtimeSessionEpoch === 'string' && params.runtimeSessionEpoch.trim() !== '')
    ? params.runtimeSessionEpoch.trim()
    : null;

  const workingDirectory = selectWorkingDirectory(params.cwd || null);
  try {
    process.chdir(workingDirectory);
  } catch (error) {
    console.error('[WARNING] Failed to change process.cwd():', error.message);
  }

  const settings = loadClaudeSettings();
  const modelId = params.model || null;
  const sdkModelName = mapModelIdToSdkName(modelId);
  const resolvedModel = resolveModelFromSettings(modelId, settings?.env);
  setModelEnvironmentVariables(resolvedModel, modelId);

  const permissionMode = normalizePermissionMode(params.permissionMode);
  const streamingEnabled = resolveStreamingEnabled(params, settings);
  const normalizedReasoningEffort = normalizeReasoningEffort(params.reasoningEffort);
  // effort 与 maxThinkingTokens 互斥:设置了 effort 时禁用 maxThinkingTokens
  const maxThinkingTokens = normalizedReasoningEffort
    ? undefined
    : resolveThinkingTokens(params, settings);
  const systemPromptAppend = buildSystemPromptAppend(params);

  if (normalizedReasoningEffort) {
    console.log(`[REASONING_EFFORT] ✓ persistent buildRequestContext applied options.effort=${normalizedReasoningEffort} (model=${sdkModelName ?? modelId ?? 'default'}, maxThinkingTokens disabled due to mutex)`);
  } else {
    console.log(`[REASONING_EFFORT] ⊝ persistent buildRequestContext: no effort set (model=${sdkModelName ?? modelId ?? 'default'}, maxThinkingTokens=${maxThinkingTokens ?? 'undefined'}, raw=${JSON.stringify(params.reasoningEffort ?? null)})`);
  }

  const options = buildQueryOptions(
    workingDirectory, sdkModelName, permissionMode,
    maxThinkingTokens, streamingEnabled, systemPromptAppend, requestedSessionId,
    normalizedReasoningEffort
  );

  const userMessage = await buildUserMessage(params, withAttachments, requestedSessionId);

  // Protocol v2 (2026-05-24): Pair-mode context. Two sources, in priority:
  //   1. params.pairContext (explicit IPC field) — preferred, but not yet wired
  //      through every Java IPC path.
  //   2. systemPromptAppend marker (Java SessionSendService prepends a
  //      <!--pair-context:{...}--> marker; we extracted it above into the
  //      `extractInlinedPairContext` discard variable, re-do it here to take
  //      the value).
  // When set the runtime gets SubagentStop hook + mcp__main MCP server.
  let pairContext = null;
  if (params.pairContext && typeof params.pairContext === 'object'
      && typeof params.pairContext.pairId === 'string'
      && params.pairContext.pairId.length > 0) {
    pairContext = {
      pairId: params.pairContext.pairId,
      activeDirectiveId: typeof params.pairContext.activeDirectiveId === 'string'
        ? params.pairContext.activeDirectiveId : null,
    };
  } else {
    const { pairContext: markerCtx } = extractInlinedPairContext(params.systemPromptAppend);
    if (markerCtx && typeof markerCtx.pairId === 'string' && markerCtx.pairId.length > 0) {
      pairContext = {
        pairId: markerCtx.pairId,
        activeDirectiveId: typeof markerCtx.activeDirectiveId === 'string'
          ? markerCtx.activeDirectiveId : null,
      };
    }
  }

  // Signature includes pairId so a Pair-mode runtime is never reused by a
  // non-Pair request — they need different hooks + MCP wiring.
  const runtimeSignature = buildRuntimeSignature(
    options, systemPromptAppend, streamingEnabled, runtimeSessionEpoch,
    pairContext?.pairId || null
  );
  console.log('[LIFECYCLE] buildRequestContext sessionId=' + (requestedSessionId || '(new)')
    + ' epoch=' + (runtimeSessionEpoch || '(none)')
    + ' signature=' + runtimeSignature
    + (pairContext?.pairId ? ' pairId=' + pairContext.pairId : ''));

  return {
    requestedSessionId,
    runtimeSessionEpoch,
    streamingEnabled,
    options,
    userMessage,
    sdkModelName,
    permissionMode,
    maxThinkingTokens,
    runtimeSignature,
    pairContext,
  };
}

// Background cleanup of idle session runtimes, decoupled from the request hot path.
// Runs every 5 minutes instead of on every acquireRuntime call to avoid O(n) scans.
const _sessionCleanupTimer = setInterval(async () => {
  await cleanupStaleSessionRuntimes({ registerActiveQueryResult, removeSession });
}, SESSION_CLEANUP_INTERVAL_MS);
// unref() so the timer does not prevent natural process exit
_sessionCleanupTimer.unref();

async function executeTurn(runtime, requestContext, turnMeta) {
  if (!runtime || runtime.closed) {
    const err = new Error('Runtime is closed');
    err.runtimeTerminated = true;
    throw err;
  }

  setActiveTurnRuntime(runtime);
  console.log('[LIFECYCLE] executeTurn sessionId=' + (requestContext.requestedSessionId || runtime.sessionId || '(new)')
    + ' epoch=' + (requestContext.runtimeSessionEpoch || runtime.runtimeSessionEpoch || '(none)'));

  // Protocol v2 (2026-05-24): refresh per-turn ids so the mcp__main tools
  // (report_turn_completion) and SubagentStop hook emit lines tagged with the
  // current turn / directive context. activeDirectiveId is set by Java when
  // it pushes a directive-bearing send; null for normal user messages.
  runtime.sessionId = runtime.sessionId || requestContext.requestedSessionId || null;
  if (requestContext.pairContext) {
    runtime.activeDirectiveId = requestContext.pairContext.activeDirectiveId || null;
  }

  const turnState = createTurnState(requestContext, runtime);
  if (turnMeta) {
    turnMeta.state = turnState;
  }

  try {
    beginRuntimeTurn(runtime);
    console.log('[MESSAGE_START]');
    runtime.inputStream.enqueue(requestContext.userMessage);

    while (true) {
      let next;
      try {
        next = await runtime.query.next();
      } catch (error) {
        const wrapped = new Error(error?.message || String(error));
        wrapped.runtimeTerminated = true;
        throw wrapped;
      }

      if (next.done) {
        const err = new Error('Claude session stream ended unexpectedly');
        err.runtimeTerminated = true;
        throw err;
      }

      touchRuntime(runtime);
      const msg = next.value;

      if (turnState.streamingEnabled && !turnState.streamStarted) {
        process.stdout.write('[STREAM_START]\n');
        turnState.streamStarted = true;
      }

      if (msg?.type === 'stream_event' && turnState.streamingEnabled) {
        turnState.hasStreamEvents = true;
        processStreamEvent(msg, turnState);
        continue;
      }

      if (shouldOutputMessage(msg, turnState)) {
        console.log('[MESSAGE]', JSON.stringify(msg));
      }

      processMessageContent(msg, turnState);
      // Emit usage tag for assistant messages.
      // IMPORTANT: This is the authoritative source for token usage, NOT the accumulatedUsage.
      // The assistant message's usage field contains the correct cumulative total.
      // In streaming mode, this overwrites any intermediate [USAGE] values sent during streaming.
      // The Java backend (ClaudeMessageHandler.handleAssistantMessage) relies on this for correct totals.
      emitUsageTag(msg);
      processToolResultMessages(msg);

      // Phase 6b (2026-05-24): mirror the supervisor-channel observation so
      // the Java MainAIMonitor can count main-AI auto-compactions. The line
      // is request-id-tagged by daemon.js stdout interception, so it routes
      // to the active send's callback (ClaudeSDKBridge → MainAIMonitor).
      if (msg?.type === 'system' && msg.subtype === 'compact_boundary') {
        try {
          console.log('[COMPACT_BOUNDARY]', JSON.stringify({
            sessionId: turnState.finalSessionId
                    || runtime.sessionId
                    || requestContext.requestedSessionId
                    || null,
            ts: Date.now(),
            trigger: msg.compact_metadata?.trigger || 'auto',
            preTokens: msg.compact_metadata?.pre_tokens ?? null,
          }));
        } catch (_) { /* stdout closed */ }
      }

      if (msg?.type === 'system' && msg.session_id) {
        turnState.finalSessionId = msg.session_id;
        console.log('[SESSION_ID]', msg.session_id);
        registerRuntimeSession(runtime, msg.session_id, { registerActiveQueryResult, removeSession });
      }

      if (msg?.type === 'result') {
        if (msg.is_error) {
          throw new Error(msg.result || msg.message || 'API request failed');
        }
        break;
      }
    }

    if (turnState.streamingEnabled && turnState.streamStarted && !turnState.streamEnded) {
      // NOTE: Do NOT emit accumulatedUsage at stream end.
      // The assistant message's usage (sent via emitUsageTag above) is the authoritative final value.
      // Emitting accumulatedUsage here would send a redundant or potentially stale value.
      process.stdout.write('[STREAM_END]\n');
      turnState.streamEnded = true;
    }

    const finalSessionId = turnState.finalSessionId || runtime.sessionId || requestContext.requestedSessionId || '';
    if (finalSessionId) {
      registerRuntimeSession(runtime, finalSessionId, { registerActiveQueryResult, removeSession });
    }

    console.log('[MESSAGE_END]');
    console.log(JSON.stringify({
      success: true,
      sessionId: finalSessionId
    }));
  } finally {
    endRuntimeTurn(runtime);
    // Only clear if this runtime still owns the pointer (not cleared by abort)
    clearActiveTurnRuntimeIf(runtime);
  }
}

// Pattern matches Anthropic API rejection when 1M context beta is requested
// without the entitlement (paid credits / Tier 4). The exact phrase has been
// stable; we keep it case-insensitive and forgiving to minor wording shifts.
const LONG_CONTEXT_NOT_ENTITLED_PATTERN = /usage credits.*required.*long\s*context|long\s*context.*requires?.*credits/i;

function detectClaudeErrorCode(messageText) {
  if (typeof messageText !== 'string' || !messageText) return null;
  if (LONG_CONTEXT_NOT_ENTITLED_PATTERN.test(messageText)) {
    return 'LONG_CONTEXT_NOT_ENTITLED';
  }
  return null;
}

function emitSendError(runtime, error, requestContext) {
  const payload = {
    success: false,
    error: error?.message || String(error),
    details: {}
  };

  if (error?.code) payload.details.code = error.code;
  if (error?.stack) payload.details.stack = truncateString(error.stack, 2000);

  if (runtime?.stderrLines?.length) {
    const sdkErrorText = runtime.stderrLines.slice(-10).join('\n');
    payload.error = `SDK-STDERR:\n\`\`\`\n${sdkErrorText}\n\`\`\`\n\n${payload.error}`;
    payload.details.sdkError = sdkErrorText;
  }

  payload.error = truncateString(payload.error, 2500);

  // Classify well-known API errors so the UI can self-correct (e.g. auto-disable
  // 1M context toggle when the account lacks the entitlement) without showing
  // the raw upstream wording.
  const claudeErrorCode = detectClaudeErrorCode(payload.error);
  if (claudeErrorCode) {
    payload.code = claudeErrorCode;
  }

  console.error('[SEND_ERROR]', JSON.stringify(payload));
  console.log('[SEND_ERROR]', JSON.stringify(payload));
  console.log(JSON.stringify(payload));
}

async function sendInternal(params, withAttachments) {
  const safeParams = params || {};
  const turnMeta = { state: null };
  let runtime = null;
  let requestContext = null;
  try {
    requestContext = await buildRequestContext(safeParams, withAttachments);
    runtime = await acquireRuntime(requestContext, { registerActiveQueryResult, removeSession });
    await executeTurn(runtime, requestContext, turnMeta);
  } catch (error) {
    // Only clear if this runtime still owns the pointer (not cleared by abort)
    clearActiveTurnRuntimeIf(runtime);
    if (turnMeta.state?.streamingEnabled && turnMeta.state?.streamStarted && !turnMeta.state?.streamEnded) {
      // NOTE: Do NOT emit accumulatedUsage at stream end, even on error.
      // If an assistant message was received, emitUsageTag already sent the correct usage.
      // If no assistant message was received, the usage would be incomplete anyway.
      process.stdout.write('[STREAM_END]\n');
      turnMeta.state.streamEnded = true;
    }
    emitSendError(runtime, error, requestContext);
    // Only dispose if not already disposed by abort
    if (runtime && !runtime.closed && error?.runtimeTerminated) {
      await disposeRuntime(runtime, { removeSession });
    }
  }
}

export async function sendMessagePersistent(params = {}) {
  await sendInternal(params, false);
}

export async function sendMessageWithAttachmentsPersistent(params = {}) {
  await sendInternal(params, true);
}

export async function preconnectPersistent(params = {}) {
  const safeParams = params || {};
  const requestContext = await buildRequestContext(safeParams, false);
  console.log('[LIFECYCLE] preconnectPersistent epoch=' + (requestContext.runtimeSessionEpoch || '(none)'));
  await acquireRuntime(requestContext, { registerActiveQueryResult, removeSession });
}

export async function resetRuntimePersistent(params = {}) {
  const runtimeSessionEpoch = typeof params === 'string'
    ? params
    : (params?.runtimeSessionEpoch || null);

  console.log('[LIFECYCLE] resetRuntimePersistent targetEpoch=' + (runtimeSessionEpoch || '(all-runtimes)'));

  const runtimes = getAllRuntimes();

  for (const runtime of runtimes) {
    if (!runtimeSessionEpoch || runtime.runtimeSessionEpoch === runtimeSessionEpoch) {
      await disposeRuntime(runtime, { removeSession });
    }
  }
}

export async function abortCurrentTurn() {
  // Atomic swap: clear first to prevent double-disposal from rapid abort calls.
  // JS is single-threaded so assignment is atomic — only the first caller gets
  // a non-null runtime, subsequent callers see null and exit early.
  const runtime = getActiveTurnRuntime();
  if (!runtime) return;
  console.log('[LIFECYCLE] abortCurrentTurn epoch=' + (runtime.runtimeSessionEpoch || '(none)'));
  clearActiveTurnRuntime();

  try {
    if (!runtime.closed) {
      await disposeRuntime(runtime, { removeSession });
    }
  } catch (error) {
    // Best-effort — log but don't throw so abort always "succeeds"
    console.error('[ABORT] Failed to dispose runtime:', error.message);
  }
}

/**
 * Phase 6b (2026-05-24): produce a handoff JSON document from the main-AI
 * runtime tied to {@code sessionId}. Mirrors the supervisor flow:
 *   1. Enqueue {@code prompt} as a one-shot user message.
 *   2. Drain SDK iteration, collect assistant text + bail on result.
 *   3. Extract the first balanced {...} block from the assistant prose.
 *   4. Emit a {@code [HANDOFF_DOC]} line; Java's MainAIRotationCoordinator
 *      consumes it.
 *
 * <p>Differences from {@code produceHandoffForSupervisor}:
 * <ul>
 *   <li>Looks up the runtime via the global per-session registry instead of
 *       a dedicated runtimes Map.</li>
 *   <li>Does NOT emit [MESSAGE_START] / [STREAM_START] / [USAGE] / etc.,
 *       because the Java ClaudeMessageHandler would otherwise treat the
 *       output as a regular user-visible turn.</li>
 *   <li>Skips registering [SESSION_ID] — the runtime already has a session
 *       and we don't want the prompt to start a new conversation.</li>
 * </ul>
 *
 * <p>Concurrency: defensively bails if the runtime currently holds an
 * active turn ({@code beginRuntimeTurn} would throw). The Java coordinator
 * is expected to schedule this only when the main-AI session is idle.
 */
export async function produceHandoffForMainAI(params = {}) {
  const { sessionId, prompt } = params || {};
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('mainAi.produceHandoff requires sessionId');
  }
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('mainAi.produceHandoff requires non-empty prompt');
  }

  const runtime = getRuntimeForSession(sessionId);
  if (!runtime || runtime.closed) {
    const err = new Error('MAIN_AI_RUNTIME_NOT_FOUND ' + sessionId);
    err.code = 'MAIN_AI_RUNTIME_NOT_FOUND';
    throw err;
  }

  let acquired = false;
  try {
    try {
      beginRuntimeTurn(runtime);
      acquired = true;
    } catch (e) {
      const err = new Error('MAIN_AI_RUNTIME_BUSY ' + (e?.message || String(e)));
      err.code = 'MAIN_AI_RUNTIME_BUSY';
      throw err;
    }

    runtime.inputStream.enqueue({
      type: 'user',
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
      },
    });

    const textChunks = [];
    while (true) {
      let next;
      try {
        next = await runtime.query.next();
      } catch (e) {
        const err = new Error('MAIN_AI_HANDOFF_ITER_FAILED ' + (e?.message || String(e)));
        err.code = 'MAIN_AI_HANDOFF_ITER_FAILED';
        throw err;
      }
      if (next.done) break;
      const msg = next.value;
      if (!msg) continue;

      // Aggregate assistant text without firing the normal observability tags.
      // We deliberately ignore stream events to keep the IPC bandwidth low.
      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block && block.type === 'text' && typeof block.text === 'string') {
            textChunks.push(block.text);
          }
        }
      }
      if (msg.type === 'result') break;
    }

    const raw = textChunks.join('').trim();
    const extracted = extractFirstJsonBlockMainAI(raw);
    const envelope = extracted == null
      ? {
          sessionId,
          ts: Date.now(),
          valid: false,
          error: 'no JSON block found in assistant output',
          raw,
          json: null,
        }
      : {
          sessionId,
          ts: Date.now(),
          valid: true,
          json: extracted,
          raw,
        };
    console.log('[HANDOFF_DOC]', JSON.stringify(envelope));
    return { ok: true };
  } finally {
    if (acquired) {
      try { endRuntimeTurn(runtime); } catch (_) { /* ignore */ }
    }
  }
}

/**
 * Phase 6b: get the SDK's real context-window usage for the main-AI runtime
 * tied to {@code sessionId}. Emits a {@code [CONTEXT_USAGE]} line consumed
 * by the Java ClaudeSDKBridge / MainAIMonitor. Cheap; safe to call from
 * any tick.
 */
export async function getMainAIContextUsage(params = {}) {
  const { sessionId } = params || {};
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('mainAi.getContextUsage requires sessionId');
  }
  const runtime = getRuntimeForSession(sessionId);
  if (!runtime || runtime.closed) {
    const err = new Error('MAIN_AI_RUNTIME_NOT_FOUND ' + sessionId);
    err.code = 'MAIN_AI_RUNTIME_NOT_FOUND';
    throw err;
  }
  if (!runtime.query || typeof runtime.query.getContextUsage !== 'function') {
    const err = new Error('Loaded SDK does not expose Query.getContextUsage');
    err.code = 'SDK_FEATURE_UNAVAILABLE';
    throw err;
  }
  const usage = await Promise.race([
    runtime.query.getContextUsage(),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('MAIN_AI_CONTEXT_USAGE_TIMEOUT')), 8_000
    )),
  ]);
  const totalUsed = pickFiniteNumber(usage, ['totalTokens', 'total', 'usedTokens']);
  const contextLimit = pickFiniteNumber(usage, ['contextLimit', 'maxTokens', 'limit', 'windowSize']);
  const ratio = (totalUsed != null && contextLimit > 0)
    ? Math.min(1, totalUsed / contextLimit)
    : null;
  console.log('[CONTEXT_USAGE]', JSON.stringify({
    sessionId,
    ts: Date.now(),
    ratio,
    totalUsed,
    contextLimit,
    breakdown: usage,
  }));
  return { ok: true };
}

function pickFiniteNumber(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Best-effort JSON extraction — strip ```json fences and find the largest
 * balanced {...} block. Mirrors {@code extractFirstJsonBlock} in
 * supervisor-channel.js (kept separate to avoid cross-file coupling).
 */
function extractFirstJsonBlockMainAI(text) {
  if (!text) return null;
  let s = text;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1];
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
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export async function shutdownPersistentRuntimes() {
  const all = getAllRuntimes();
  for (const runtime of all) {
    await disposeRuntime(runtime, { removeSession });
  }
  resetRegistryState();
  resetCachedQueryFn();
}

export const __testing = {
  async resetState() {
    await shutdownPersistentRuntimes();
    clearActiveTurnRuntime();
  },
  setQueryFn(queryFn) {
    setCachedQueryFn(queryFn);
  },
  async buildRequestContext(params = {}, withAttachments = false) {
    return buildRequestContext(params, withAttachments);
  },
  async acquireRuntime(requestContext) {
    return acquireRuntime(requestContext, { registerActiveQueryResult, removeSession });
  },
  async executeTurn(runtime, requestContext, turnMeta = null) {
    return executeTurn(runtime, requestContext, turnMeta);
  },
  async cleanupAnonymousRuntimes() {
    return cleanupStaleAnonymousRuntimes({ registerActiveQueryResult, removeSession });
  },
  async cleanupSessionRuntimes() {
    return cleanupStaleSessionRuntimes({ registerActiveQueryResult, removeSession });
  },
  async resetRuntimePersistent(params = {}) {
    return resetRuntimePersistent(params);
  },
  async abortCurrentTurn() {
    return abortCurrentTurn();
  },
  setActiveTurnRuntime(runtime) {
    setActiveTurnRuntime(runtime);
  },
  getRuntimeForSession(sessionId) {
    return getRuntimeForSession(sessionId);
  },
  getSnapshot() {
    return getSnapshot();
  }
};
