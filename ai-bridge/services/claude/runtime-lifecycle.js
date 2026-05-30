import { AsyncStream } from '../../utils/async-stream.js';
import { loadClaudeSdk } from '../../utils/sdk-loader.js';
import { createPreToolUseHook, normalizePermissionMode } from './permission-mode.js';
import { buildSubagentStopHook } from '../supervisor/subagent-stop-hook.js';
import { buildMainAiMcpServer, MAIN_MCP_NAME } from './main-ai-tools.js';
import {
  beginRuntimeTurn,
  cleanupStaleAnonymousRuntimes as cleanupAnonymousFromRegistry,
  cleanupStaleSessionRuntimes as cleanupSessionsFromRegistry,
  clearActiveTurnRuntimeIf,
  endRuntimeTurn,
  findRuntimeForRequest,
  rememberRuntime,
  promoteRuntimeToSession,
  removeRuntime,
  touchRuntime
} from './runtime-registry.js';

let cachedQueryFn = null;

export function buildRuntimeSignature(options, systemPromptAppend, streamingEnabled, runtimeSessionEpoch, pairId) {
  // Protocol v2 (2026-05-24): include pairId in the signature so a Pair-mode
  // runtime is NEVER reused by a non-Pair request (and vice versa). Same pairId
  // continues to reuse, which is what we want for back-to-back Pair turns.
  const material = {
    cwd: options.cwd || '',
    additionalDirectories: options.additionalDirectories || [],
    systemPromptAppend: systemPromptAppend || '',
    streamingEnabled: !!streamingEnabled,
    runtimeSessionEpoch: runtimeSessionEpoch || '',
    model: options.model || '',
    pairId: pairId || '',
    // Toggling 'ultra' (ultracode) flips workflow orchestration, which the SDK
    // only reads at query creation. Including it here forces a clean recreation
    // when the user switches into/out of Ultra. Plain effort levels are NOT in
    // the signature (unchanged behaviour) — they apply on the next recreation.
    ultracode: !!(options.settings && options.settings.ultracode),
  };
  return JSON.stringify(material);
}

async function ensureQueryFn() {
  if (cachedQueryFn) return cachedQueryFn;
  const sdk = await loadClaudeSdk();
  const queryFn = sdk?.query;
  if (typeof queryFn !== 'function') {
    throw new Error('Claude SDK query function not available. Please reinstall dependencies.');
  }
  cachedQueryFn = queryFn;
  return cachedQueryFn;
}

export function setCachedQueryFn(queryFn) {
  cachedQueryFn = queryFn;
}

export function resetCachedQueryFn() {
  cachedQueryFn = null;
}

export function registerRuntimeSession(runtime, sessionId, callbacks) {
  promoteRuntimeToSession(runtime, sessionId, callbacks);
}

export async function disposeRuntime(runtime, callbacks) {
  if (!runtime || runtime.closed) return;
  console.log('[LIFECYCLE] disposeRuntime sessionId=' + (runtime.sessionId || '(new)')
    + ' epoch=' + (runtime.runtimeSessionEpoch || '(none)')
    + ' signature=' + (runtime.runtimeSignature || '(none)'));
  runtime.closed = true;
  runtime.activeTurnCount = 0;

  try {
    runtime.inputStream.done();
  } catch (err) {
    console.error('[LIFECYCLE] inputStream.done() failed:', err?.message || err);
  }

  try {
    runtime.query?.close?.();
  } catch (err) {
    console.error('[LIFECYCLE] query.close() failed:', err?.message || err);
  }

  removeRuntime(runtime, callbacks?.removeSession);
  clearActiveTurnRuntimeIf(runtime);
}

async function createRuntime(requestContext, callbacks) {
  const queryFn = await ensureQueryFn();
  const initialPermissionMode = normalizePermissionMode(requestContext.permissionMode);

  // Protocol v2 (2026-05-24): pairContext-aware runtime. When Java side opens
  // a Pair, requestContext.pairContext.pairId is set; the runtime then gets
  // (a) SubagentStop hook forwarding subagent results to the supervisor, and
  // (b) mcp__main MCP server exposing report_turn_completion. Non-Pair
  // requests skip both — legacy behaviour fully preserved.
  const pairContext = requestContext.pairContext || null;
  const pairId = pairContext?.pairId || null;

  const runtime = {
    closed: false,
    sessionId: requestContext.requestedSessionId || null,
    runtimeSessionEpoch: requestContext.runtimeSessionEpoch || null,
    runtimeSignature: requestContext.runtimeSignature,
    currentModel: requestContext.sdkModelName || null,
    currentPermissionMode: initialPermissionMode,
    permissionModeState: { value: initialPermissionMode },
    currentMaxThinkingTokens: requestContext.maxThinkingTokens ?? null,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    activeTurnCount: 0,
    stderrLines: [],
    query: null,
    inputStream: new AsyncStream(),
    // Protocol v2: pair-mode bookkeeping. Mutated by executeTurn on each
    // active turn so MCP tools (report_turn_completion) can tag emitted lines
    // with the correct directive id.
    pairId,
    activeDirectiveId: pairContext?.activeDirectiveId || null,
    currentTurnId: null,
    // Mutable cell holding the per-turn windowId. The PreToolUse hook closes
    // over this ref (not the value) so each AskUserQuestion uses the
    // CURRENT turn's windowId. Set by acquireRuntime on every reuse;
    // initialised here from the create-time request (often preconnect,
    // which sends no windowId — applyDynamicControls patches it before the
    // first real turn fires).
    windowIdRef: { value: requestContext.windowId || null },
  };

  const options = {
    ...requestContext.options,
    stderr: (data) => {
      try {
        const text = (data ?? '').toString().trim();
        if (!text) return;
        runtime.stderrLines.push(text);
        if (runtime.stderrLines.length > 200) {
          runtime.stderrLines.shift();
        }
        console.error(`[SDK-STDERR] ${text}`);
      } catch (_) {
      }
    }
  };

  // Hooks: PreToolUse for permissions (always). SubagentStop is added only in
  // Pair mode — it forwards [SUBAGENT_STOP] NDJSON tagged with runtime context.
  console.log('[WINDOWID_TRACE] createRuntime requestContext.windowId=' + JSON.stringify(requestContext.windowId)
    + ' sessionId=' + (requestContext.requestedSessionId || '(new)')
    + ' signature=' + requestContext.runtimeSignature);
  const hooks = {
    ...(options.hooks || {}),
    PreToolUse: [{
      hooks: [createPreToolUseHook(runtime.permissionModeState, options.cwd, async (mode) => {
        if (runtime.currentPermissionMode === mode) {
          runtime.permissionModeState.value = mode;
          return;
        }
        if (typeof runtime.query?.setPermissionMode === 'function') {
          try {
            await runtime.query.setPermissionMode(mode);
          } catch (error) {
            console.warn('[LIFECYCLE] hook setPermissionMode failed, updating local state only:', error.message);
          }
        }
        // Always update local state to keep hook and runtime in sync
        runtime.currentPermissionMode = mode;
        runtime.permissionModeState.value = mode;
      }, runtime.windowIdRef)]
    }]
  };
  if (pairId) {
    hooks.SubagentStop = [{
      hooks: [buildSubagentStopHook(runtime)],
    }];
  }
  options.hooks = hooks;

  // mcp__main MCP server (Pair mode only). report_turn_completion writes a
  // [TURN_REPORT] NDJSON line that the Java EventBus consumes.
  if (pairId) {
    try {
      const mainMcp = await buildMainAiMcpServer(runtime);
      options.mcpServers = {
        ...(options.mcpServers || {}),
        [MAIN_MCP_NAME]: mainMcp,
      };
    } catch (err) {
      console.error('[LIFECYCLE] buildMainAiMcpServer failed (Pair mode degraded, '
        + 'report_turn_completion will be unavailable):', err?.message || err);
    }
  }

  runtime.query = queryFn({
    prompt: runtime.inputStream,
    options
  });

  rememberRuntime(runtime, requestContext, callbacks?.registerActiveQueryResult);

  console.log('[LIFECYCLE] createRuntime sessionId=' + (runtime.sessionId || '(new)')
    + ' epoch=' + (runtime.runtimeSessionEpoch || '(none)')
    + ' signature=' + runtime.runtimeSignature
    + (pairId ? ' pairId=' + pairId : ''));

  return runtime;
}

async function applyDynamicControls(runtime, requestContext) {
  if (!runtime || runtime.closed) return;

  // Refresh windowId on every acquire so the PreToolUse hook's closure (which
  // captured this same ref at createRuntime time) sees the CURRENT turn's
  // windowId. Without this, a runtime created by preconnect (no windowId)
  // would keep firing AskUserQuestion with windowId=null even after a real
  // claude.send carrying a windowId arrived — causing cross-tab pair-mode
  // misrouting (Tab A's pair denying Tab B's popup).
  if (runtime.windowIdRef) {
    const previous = runtime.windowIdRef.value;
    const next = requestContext.windowId || null;
    if (previous !== next) {
      runtime.windowIdRef.value = next;
      console.log('[WINDOWID_TRACE] applyDynamicControls updated windowId previous='
        + JSON.stringify(previous) + ' next=' + JSON.stringify(next)
        + ' sessionId=' + (runtime.sessionId || '(new)'));
    }
  }

  const targetPermissionMode = normalizePermissionMode(requestContext.permissionMode);
  if (runtime.currentPermissionMode !== targetPermissionMode) {
    if (typeof runtime.query?.setPermissionMode === 'function') {
      try {
        await runtime.query.setPermissionMode(targetPermissionMode);
      } catch (error) {
        console.error('[DAEMON] setPermissionMode failed:', error.message);
      }
    }
    runtime.currentPermissionMode = targetPermissionMode;
    if (runtime.permissionModeState) {
      runtime.permissionModeState.value = targetPermissionMode;
    }
  }

  const targetModel = requestContext.sdkModelName || null;
  if (runtime.currentModel !== targetModel && typeof runtime.query?.setModel === 'function') {
    try {
      await runtime.query.setModel(targetModel || undefined);
      runtime.currentModel = targetModel;
    } catch (error) {
      console.error('[DAEMON] setModel failed:', error.message);
    }
  }

  const targetThinking = requestContext.maxThinkingTokens ?? null;
  if (runtime.currentMaxThinkingTokens !== targetThinking && typeof runtime.query?.setMaxThinkingTokens === 'function') {
    try {
      await runtime.query.setMaxThinkingTokens(targetThinking);
      runtime.currentMaxThinkingTokens = targetThinking;
    } catch (error) {
      console.error('[DAEMON] setMaxThinkingTokens failed:', error.message);
    }
  }
}

function assertRuntimeOwnership(runtime, requestContext) {
  if (!runtime || runtime.closed) {
    const err = new Error('Runtime is closed');
    err.runtimeTerminated = true;
    throw err;
  }

  if (requestContext.runtimeSessionEpoch && runtime.runtimeSessionEpoch !== requestContext.runtimeSessionEpoch) {
    const err = new Error(
      `Runtime ownership mismatch: expected epoch ${requestContext.runtimeSessionEpoch}, got ${runtime.runtimeSessionEpoch || '(none)'}`
    );
    err.runtimeTerminated = true;
    throw err;
  }

  if (requestContext.requestedSessionId && runtime.sessionId && runtime.sessionId !== requestContext.requestedSessionId) {
    const err = new Error(
      `Runtime ownership mismatch: expected session ${requestContext.requestedSessionId}, got ${runtime.sessionId}`
    );
    err.runtimeTerminated = true;
    throw err;
  }
}

export async function acquireRuntime(requestContext, callbacks) {
  await cleanupAnonymousFromRegistry((runtime) => disposeRuntime(runtime, callbacks));

  let runtime = findRuntimeForRequest(requestContext);

  if (runtime && runtime.runtimeSignature !== requestContext.runtimeSignature) {
    await disposeRuntime(runtime, callbacks);
    runtime = null;
  }

  if (runtime && requestContext.runtimeSessionEpoch && runtime.runtimeSessionEpoch !== requestContext.runtimeSessionEpoch) {
    console.log('[LIFECYCLE] disposeRuntimeForEpochMismatch existing=' + (runtime.runtimeSessionEpoch || '(none)')
      + ' requested=' + requestContext.runtimeSessionEpoch);
    await disposeRuntime(runtime, callbacks);
    runtime = null;
  }

  if (!runtime) {
    runtime = await createRuntime(requestContext, callbacks);
  } else {
    console.log('[LIFECYCLE] reuseRuntime sessionId=' + (runtime.sessionId || '(new)')
      + ' epoch=' + (runtime.runtimeSessionEpoch || '(none)')
      + ' signature=' + runtime.runtimeSignature);
  }

  assertRuntimeOwnership(runtime, requestContext);
  await applyDynamicControls(runtime, requestContext);
  touchRuntime(runtime);
  return runtime;
}

export async function cleanupStaleAnonymousRuntimes(callbacks) {
  return cleanupAnonymousFromRegistry((runtime) => disposeRuntime(runtime, callbacks));
}

export async function cleanupStaleSessionRuntimes(callbacks) {
  return cleanupSessionsFromRegistry((runtime) => disposeRuntime(runtime, callbacks));
}

export { beginRuntimeTurn, endRuntimeTurn, touchRuntime };
