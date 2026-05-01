/**
 * Stdio IPC primitives for permission communication with remote client.
 *
 * Replaces the original file-based IPC: instead of writing request files into
 * /tmp/claude-permission and polling for response files, we emit `_ctrl`
 * messages on stdout (carried over SSE by ai-bridge-server) and receive
 * responses on stdin (forwarded from client POST /session/{id}/in).
 *
 * Wire format (stdout — server transports as SSE event):
 *   {"type":"_ctrl","action":"permission_request","requestId":"...","toolName":"Edit","inputs":{...},"cwd":"..."}
 *   {"type":"_ctrl","action":"ask_user_question_request","requestId":"...","questions":[...],"cwd":"..."}
 *   {"type":"_ctrl","action":"plan_approval_request","requestId":"...","plan":"...","cwd":"..."}
 *
 * Wire format (stdin — server forwards from client POST /session/{id}/in):
 *   {"type":"_ctrl","action":"permission_response","requestId":"...","allow":true}
 *   {"type":"_ctrl","action":"ask_user_question_response","requestId":"...","answers":[...]}
 *   {"type":"_ctrl","action":"plan_approval_response","requestId":"...","approved":true,"editedPlan":null}
 *
 * Public API signatures match the original file-based implementation, so
 * upstream callers (permission-handler.js, services/*) need no changes.
 */

// ========== Debug logging ==========
// Cannot use console.log: daemon.js intercepts stdout for business messages.
// Write directly to stderr; ai-bridge-server collects stderr separately.
export function debugLog(tag, message, data = null) {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` | Data: ${JSON.stringify(data)}` : '';
  process.stderr.write(`[${timestamp}][PERM_DEBUG][${tag}] ${message}${dataStr}\n`);
}

// ========== Constants ==========
// Kept in sync with Java-side PermissionHandler.PERMISSION_TIMEOUT_SECONDS.
export const PERMISSION_TIMEOUT_MS = 300000; // 5 min

// ========== Pending requests registry ==========
// requestId -> { resolve, reject, timer, action }
const pending = new Map();

// ========== _ctrl response router ==========
// daemon.js stdin loop calls this when it sees a message with type === '_ctrl'.
export function handleControlResponse(msg) {
  if (!msg || !msg.requestId) {
    debugLog('CTRL_BAD_MSG', 'Control response missing requestId', msg);
    return;
  }
  const p = pending.get(msg.requestId);
  if (!p) {
    debugLog('CTRL_NO_PENDING', `No pending request for ${msg.requestId} (action=${msg.action})`);
    return;
  }
  pending.delete(msg.requestId);
  clearTimeout(p.timer);
  debugLog('CTRL_RESOLVE', `Resolving ${p.action} ${msg.requestId}`);
  p.resolve(msg);
}

// ========== Helper: send a request and wait for response ==========
function sendRequest(action, payload) {
  const requestId = `${action.split('_')[0]}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  const envelope = {
    type: '_ctrl',
    action,
    requestId,
    ...payload,
  };

  // Use the raw stdout writer exposed by daemon.js. daemon.js intercepts
  // both console.log and process.stdout.write to wrap output in request-scoped
  // envelopes, so we must bypass that wrapping for control messages.
  const line = JSON.stringify(envelope) + '\n';
  if (typeof globalThis.__rawStdoutWrite === 'function') {
    globalThis.__rawStdoutWrite(line);
  } else {
    // Fallback for non-daemon contexts (tests / standalone usage).
    process.stdout.write(line);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      debugLog('TIMEOUT', `${action} timeout`, { requestId });
      reject(new Error(`${action} timeout after ${PERMISSION_TIMEOUT_MS}ms`));
    }, PERMISSION_TIMEOUT_MS);
    pending.set(requestId, { resolve, reject, timer, action });
    debugLog('CTRL_SEND', `Sent ${action} ${requestId}`);
  });
}

// ========== Public API (signatures preserved from original) ==========

/**
 * Request permission from Java side for a tool invocation.
 * @param {string} toolName
 * @param {Object} input
 * @returns {Promise<boolean>}
 */
export async function requestPermissionFromJava(toolName, input) {
  debugLog('REQUEST_START', `Tool: ${toolName}`, { input });
  try {
    const resp = await sendRequest('permission_request', {
      toolName,
      inputs: input,
      cwd: process.cwd(),
      timestamp: new Date().toISOString(),
    });
    const allow = Boolean(resp.allow);
    debugLog('RESPONSE_PARSED', `allow=${allow}`);
    return allow;
  } catch (e) {
    debugLog('FATAL_ERROR', `requestPermissionFromJava failed: ${e.message}`);
    return false;
  }
}

/**
 * Request answers to AskUserQuestion tool input.
 * @param {Object} input - has `questions` array
 * @returns {Promise<Array|null>}
 */
export async function requestAskUserQuestionAnswers(input) {
  debugLog('ASK_USER_QUESTION_START', 'Requesting answers', { input });
  try {
    const resp = await sendRequest('ask_user_question_request', {
      questions: input?.questions || [],
      cwd: process.cwd(),
      timestamp: new Date().toISOString(),
    });
    const answers = resp.answers || null;
    debugLog('ASK_USER_QUESTION_RESPONSE', `answers=${JSON.stringify(answers)}`);
    return answers;
  } catch (e) {
    debugLog('ASK_USER_QUESTION_ERROR', `failed: ${e.message}`);
    return null;
  }
}

/**
 * Request plan approval (ExitPlanMode tool).
 * @param {Object} input - has `plan` field
 * @returns {Promise<{approved: boolean, editedPlan: string|null}>}
 */
export async function requestPlanApproval(input) {
  debugLog('PLAN_APPROVAL_START', 'Requesting plan approval', { input });
  try {
    const resp = await sendRequest('plan_approval_request', {
      plan: input?.plan || '',
      cwd: process.cwd(),
      timestamp: new Date().toISOString(),
    });
    const approved = Boolean(resp.approved);
    const editedPlan = resp.editedPlan || null;
    debugLog('PLAN_APPROVAL_RESPONSE', `approved=${approved}`);
    return { approved, editedPlan };
  } catch (e) {
    debugLog('PLAN_APPROVAL_ERROR', `failed: ${e.message}`);
    return { approved: false, editedPlan: null };
  }
}
