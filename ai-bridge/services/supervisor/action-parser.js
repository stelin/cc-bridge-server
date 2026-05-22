/**
 * Action Parser.
 *
 * Supervisor LLM outputs follow this contract:
 *   <natural language reasoning lines>
 *
 *   ```ACTION
 *   { "action": "...", "payload": { ... } }
 *   ```
 *
 * This module extracts the trailing ACTION block, validates the schema, and
 * returns { naturalText, action }. On any parse/validation failure, it
 * downgrades to a `wait` action and surfaces the parse error in the result.
 */

export const ACTION_TYPES = new Set([
  'inject_prompt',
  'retry_with_hint',
  'approve_and_continue',
  'escalate_to_human',
  'request_amendment',
  'wait',
]);

const ACTION_BLOCK_RE = /```ACTION\s*\n([\s\S]*?)\n```/i;

/**
 * @param {string} text - full assistant message text
 * @returns {{ naturalText: string, action: object, parseError?: string }}
 */
export function parseSupervisorOutput(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return {
      naturalText: '',
      action: defaultWaitAction('empty supervisor output'),
      parseError: 'empty_output',
    };
  }

  const match = text.match(ACTION_BLOCK_RE);
  if (!match) {
    return {
      naturalText: text.trim(),
      action: defaultWaitAction('no ACTION block detected'),
      parseError: 'no_action_block',
    };
  }

  const naturalText = text.slice(0, match.index).trim();
  const rawJson = match[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    return {
      naturalText,
      action: defaultWaitAction('invalid JSON in ACTION block'),
      parseError: `json_parse_failed: ${e.message}`,
    };
  }

  const validated = validate(parsed);
  if (validated.error) {
    return {
      naturalText,
      action: defaultWaitAction(validated.error),
      parseError: validated.error,
    };
  }

  return { naturalText, action: validated.action };
}

function validate(obj) {
  if (!obj || typeof obj !== 'object') {
    return { error: 'action is not an object' };
  }
  const action = obj.action;
  if (typeof action !== 'string' || !ACTION_TYPES.has(action)) {
    return { error: `unknown action: ${action}` };
  }

  const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : {};
  const reason = typeof obj.reason === 'string' ? obj.reason : '';

  switch (action) {
    case 'inject_prompt':
      if (typeof payload.prompt !== 'string' || payload.prompt.length === 0) {
        return { error: 'inject_prompt requires payload.prompt (non-empty string)' };
      }
      break;
    case 'retry_with_hint':
      if (typeof payload.prompt !== 'string') {
        return { error: 'retry_with_hint requires payload.prompt' };
      }
      if (payload.wait_seconds != null && typeof payload.wait_seconds !== 'number') {
        return { error: 'retry_with_hint.payload.wait_seconds must be a number if present' };
      }
      break;
    case 'escalate_to_human':
      if (typeof payload.question !== 'string' || payload.question.length === 0) {
        return { error: 'escalate_to_human requires payload.question' };
      }
      break;
    // approve_and_continue / request_amendment / wait have no required fields.
    default:
      break;
  }

  return {
    action: {
      action,
      reason,
      payload,
    },
  };
}

function defaultWaitAction(reason) {
  return {
    action: 'wait',
    reason: `(downgraded) ${reason}`,
    payload: {},
  };
}
