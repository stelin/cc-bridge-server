/**
 * Protocol v2 constants for the autonomous supervisor collaboration layer.
 * Single source of truth for NDJSON event types and payload kinds.
 */

/** Current protocol version emitted by this daemon. */
export const PROTOCOL_VERSION = 'v2';

/** All protocol versions this daemon can still talk. v1 = pre-autonomy
 *  (Monitor+Rotation era). v2 = autonomous collab (Phases 0-6, 2026-05-24).
 *  Appendix B of the plan: daemon advertises this on supervisor.start; the
 *  Java client picks one it supports. Used today only as a telltale — no v1
 *  fallback path is wired because the autonomy refactor is "single cutover"
 *  per §10.3. */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['v1', 'v2']);

export const NDJSON_EVENTS = Object.freeze({
  TURN_REPORT: 'TURN_REPORT',
  SUBAGENT_STOP: 'SUBAGENT_STOP',
  MAIN_ACK: 'MAIN_ACK',
  SUPERVISOR_ACTION: 'SUPERVISOR_ACTION',
  SUPERVISOR_MSG: 'SUPERVISOR_MSG',
  STATE_UPDATE: 'STATE_UPDATE',
  COMPACT_BOUNDARY: 'COMPACT_BOUNDARY',
  SUPERVISOR_HEALTH: 'SUPERVISOR_HEALTH',
  CONTEXT_USAGE: 'CONTEXT_USAGE',
  HANDOFF_DOC: 'HANDOFF_DOC',
  PRE_COMPACT: 'PRE_COMPACT',
  SUPERVISOR_INTERRUPT_RESULT: 'SUPERVISOR_INTERRUPT_RESULT',
  BUDGET_WARNING: 'BUDGET_WARNING',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  DIRECTIVE_LOST: 'DIRECTIVE_LOST',
});

export const DIRECTIVE_KINDS = Object.freeze({
  TASK_ASSIGNMENT: 'task_assignment',
  REVIEW_FEEDBACK: 'review_feedback',
  ACKNOWLEDGEMENT: 'acknowledgement',
  BOOTSTRAP: 'bootstrap',
});

export const ACTION_TYPES = Object.freeze({
  INJECT_PROMPT: 'inject_prompt',
  RETRY_WITH_HINT: 'retry_with_hint',
  APPROVE_AND_CONTINUE: 'approve_and_continue',
  ESCALATE_TO_HUMAN: 'escalate_to_human',
  RECORD_ALERT: 'record_alert',
  REQUEST_AMENDMENT: 'request_amendment',
  WAIT: 'wait',
});

export const DECISION_CATEGORIES = Object.freeze(['A', 'B', 'C1', 'C2', 'C3']);
export const DECISION_SEVERITIES = Object.freeze(['info', 'warn', 'alert']);
export const DECISION_CONFIDENCES = Object.freeze(['high', 'medium', 'low']);

export function isValidActionType(action) {
  return Object.values(ACTION_TYPES).includes(action);
}

export function generateDirectiveId() {
  return `d_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function generateTurnId() {
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
