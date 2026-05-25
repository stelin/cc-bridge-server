/**
 * Supervisor tool registry.
 *
 * Defines the single tool the Supervisor LLM uses to emit an ACTION decision.
 * Using a tool (instead of a free-form ```ACTION JSON code block) makes the
 * schema enforced by the Anthropic API: tool_use inputs are validated against
 * the Zod-derived JSON Schema server-side, so the model cannot deliver
 * malformed JSON to us. This eliminates the
 * `(downgraded) invalid JSON in ACTION block` dead-lock path entirely.
 *
 * Flow per turn:
 *   1. SDK invokes the Anthropic API; model decides to call emit_action.
 *   2. The SDK invokes the handler defined here; we capture the validated
 *      action into the runtime via the onCapture callback.
 *   3. Handler returns a short ack so the model knows the call landed and
 *      can finish its turn.
 *   4. supervisor-channel reads runtime.lastCapturedAction after the turn
 *      ends and emits the SUPERVISOR_ACTION line to Java.
 *
 * If the handler's cross-field validation fails (e.g. inject_prompt with no
 * prompt), we return isError: true with a corrective hint; the model sees
 * the error and re-calls emit_action with the missing field.
 */

// zod is not statically imported here because it lives in the Claude SDK
// install dir (~/.codemoss/dependencies/claude-sdk/node_modules/zod), not in
// ai-bridge/node_modules. The caller passes a resolved zod module into
// buildSupervisorMcpServer; see ../../utils/sdk-loader.js#loadZod.

import { buildUpdateStateTool, UPDATE_STATE_TOOL_NAME } from './update-state-tool.js';
import { buildSavePlanTool, SAVE_PLAN_TOOL_NAME } from './save-plan-tool.js';
import { generateDirectiveId, DIRECTIVE_KINDS } from './protocol-v2.js';

export const SUPERVISOR_MCP_NAME = 'supervisor';
export const EMIT_ACTION_TOOL_NAME = 'emit_action';
/** Phase 3 (2026-05-24): re-exported so callers can list expected tool names. */
export { UPDATE_STATE_TOOL_NAME, SAVE_PLAN_TOOL_NAME };
/** Fully-qualified tool name the API sees (mcp__<server>__<tool>). */
export const QUALIFIED_EMIT_ACTION = `mcp__${SUPERVISOR_MCP_NAME}__${EMIT_ACTION_TOOL_NAME}`;
export const QUALIFIED_UPDATE_STATE = `mcp__${SUPERVISOR_MCP_NAME}__${UPDATE_STATE_TOOL_NAME}`;
export const QUALIFIED_SAVE_PLAN = `mcp__${SUPERVISOR_MCP_NAME}__${SAVE_PLAN_TOOL_NAME}`;

const ACTION_TYPES = [
    'inject_prompt',
    'retry_with_hint',
    'approve_and_continue',
    'escalate_to_human',  // deprecated: aliased to record_alert + category=C2
    'record_alert',       // Protocol v2 (2026-05-24): non-blocking alert
    'request_amendment',
    'wait',
];

const DIRECTIVE_KIND_LIST = Object.values(DIRECTIVE_KINDS);

/**
 * Build the Zod input schema given an injected zod module. All payload
 * fields are optional at the schema level; cross-field requirements are
 * enforced in {@link normalizeAction} so the model can self-correct via the
 * error path rather than having the SDK reject the call before we see it.
 */
function buildEmitActionSchema(z) {
    return {
        action: z.enum(ACTION_TYPES).describe(
            'Action type. Determines which other fields are required.'
        ),
        reason: z.string().optional().describe(
            'Short rationale (1-2 sentences) explaining this decision.'
        ),
        // Protocol v2 (2026-05-24): structured directive fields. When action is
        // inject_prompt, prefer the structured fields (kind/objective/...) over
        // raw `prompt`. Legacy `prompt` still works for one-off short messages.
        kind: z.enum(DIRECTIVE_KIND_LIST).optional().describe(
            'inject_prompt directive kind: task_assignment | review_feedback | acknowledgement | bootstrap.'
        ),
        objective: z.string().optional().describe(
            'inject_prompt: one-sentence task objective. Goes in the structured payload.'
        ),
        context: z.object({
            previousStep: z.string().optional(),
            relatedFiles: z.array(z.string()).optional(),
        }).optional().describe(
            'inject_prompt: optional context for the task (previous step summary, related file paths).'
        ),
        expectedDeliverables: z.array(z.string()).optional().describe(
            'inject_prompt: expected deliverable paths/descriptions for this task.'
        ),
        acceptanceCriteria: z.array(z.string()).optional().describe(
            'inject_prompt: acceptance criteria the main AI must meet.'
        ),
        prompt: z.string().optional().describe(
            'inject_prompt/retry_with_hint: free-form fallback prompt text. ' +
            'Either provide structured fields above OR `prompt`; if both, the structured fields take precedence and `prompt` becomes a hint.'
        ),
        wait_seconds: z.number().optional().describe(
            'Optional delay in seconds before injecting prompt. Only honored for retry_with_hint.'
        ),
        // record_alert fields (Protocol v2)
        severity: z.enum(['warn', 'alert']).optional().describe(
            'record_alert: severity level. warn = C1 soft alert, alert = C2 hard alert.'
        ),
        category: z.enum(['C1', 'C2']).optional().describe(
            'record_alert: decision category (C1 = auto-fallback with low confidence; C2 = skip step and continue).'
        ),
        fallback_choice: z.string().optional().describe(
            'record_alert: the fallback you decided to take instead of human intervention.'
        ),
        // Legacy escalate_to_human fields (aliased to record_alert internally)
        question: z.string().optional().describe(
            'Legacy escalate_to_human: question text. In autonomy mode this auto-aliases to record_alert with category=C2.'
        ),
        choices: z.array(z.string()).optional().describe(
            'Legacy escalate_to_human: optional choice list.'
        ),
        context_files: z.array(z.string()).optional().describe(
            'Legacy escalate_to_human: optional file paths attached as context.'
        ),
        proposal: z.string().optional().describe(
            'Used when action is request_amendment. The proposed plan change.'
        ),
        mark_step_complete: z.number().optional().describe(
            'Used when action is approve_and_continue. Step index to mark as done.'
        ),
        // v3 self-decision log. Can be attached to any action when supervisor
        // made A/B-level adjustments this turn. C-level must escalate, NOT be
        // recorded here — enforced by the `category` enum below.
        decisions: z.array(z.object({
            step: z.number().describe('Plan step number (0 for the discovery turn).'),
            category: z.enum(['A', 'B']).describe(
                'A=self-decidable detail; B=grey-zone (auto review_flag=true). C-level decisions must escalate, NOT be recorded here.'
            ),
            plan_excerpt: z.string().describe('Original plan text (one sentence).'),
            ambiguity: z.string().describe('The ambiguity or gap in the plan (one sentence).'),
            choice: z.string().describe('The choice you made (one sentence).'),
            rationale: z.string().describe('Why you chose this (one sentence).'),
            scope: z.string().describe('"local" | "this-file" | "cross-file".'),
            review_flag: z.boolean().optional().describe(
                'Mark for mandatory human review. Forced true for category B.'
            ),
        })).optional().describe(
            'Optional self-decision records. Attach when supervisor made any A/B-level adjustments this turn.'
        ),
    };
}

/**
 * Normalize the validated tool input into the {action, reason, payload}
 * wrapper that {@code ActionRouter.java} consumes. Performs cross-field
 * validation that Zod cannot express directly.
 *
 * @returns {{ action: {action: string, reason: string, payload: object}, error: string|null }}
 */
export function normalizeAction(args) {
    let action = args.action;
    const reason = typeof args.reason === 'string' ? args.reason : '';
    const payload = {};
    let error = null;
    let directiveId = null;

    // Protocol v2 (2026-05-24): escalate_to_human auto-aliases to record_alert
    // (category=C2) in autonomy mode. The legacy fields (question/choices/...)
    // are preserved in payload for backward-compatible UI rendering, but the
    // emitted action is record_alert so downstream Java treats it as
    // non-blocking.
    if (action === 'escalate_to_human') {
        action = 'record_alert';
        payload.legacyEscalate = true;
        if (typeof args.question === 'string' && args.question.length > 0) {
            payload.question = args.question;
            // Use the question as fallback_choice description if none provided
            if (typeof args.fallback_choice !== 'string') {
                payload.fallback_choice = '(legacy escalate, no fallback provided — please record next time)';
            }
        }
        if (Array.isArray(args.choices)) payload.choices = args.choices;
        if (Array.isArray(args.context_files)) payload.context_files = args.context_files;
        // Default category=C2 for legacy escalate so it's treated as an alert.
        payload.category = 'C2';
        payload.severity = 'alert';
    }

    switch (action) {
        case 'inject_prompt': {
            // Protocol v2: prefer structured payload. Fall back to legacy prompt-only.
            const hasStructured = (typeof args.objective === 'string' && args.objective.length > 0)
                || Array.isArray(args.expectedDeliverables);
            const hasInlinePrompt = typeof args.prompt === 'string' && args.prompt.length > 0;
            if (!hasStructured && !hasInlinePrompt) {
                error = 'inject_prompt requires either structured fields (objective + ...) or non-empty `prompt`';
                break;
            }
            payload.kind = typeof args.kind === 'string' ? args.kind : 'task_assignment';
            if (typeof args.objective === 'string') payload.objective = args.objective;
            if (args.context && typeof args.context === 'object') payload.context = args.context;
            if (Array.isArray(args.expectedDeliverables)) payload.expectedDeliverables = args.expectedDeliverables;
            if (Array.isArray(args.acceptanceCriteria)) payload.acceptanceCriteria = args.acceptanceCriteria;
            // Inline prompt becomes inlinePrompt in structured payload (or stays as `prompt` for legacy
            // consumers — both fields are written for transitional compatibility).
            if (hasInlinePrompt) {
                payload.inlinePrompt = args.prompt;
                payload.prompt = args.prompt;
            }
            directiveId = generateDirectiveId();
            break;
        }
        case 'retry_with_hint':
            if (typeof args.prompt !== 'string') {
                error = 'retry_with_hint requires `prompt`';
            } else {
                payload.prompt = args.prompt;
                payload.inlinePrompt = args.prompt;
                payload.kind = 'review_feedback';
            }
            if (typeof args.wait_seconds === 'number') {
                payload.wait_seconds = args.wait_seconds;
            }
            directiveId = generateDirectiveId();
            break;
        case 'record_alert':
            // category/severity may already be set by the escalate_to_human alias above.
            if (!payload.category) {
                payload.category = typeof args.category === 'string' ? args.category : 'C1';
            }
            if (!payload.severity) {
                payload.severity = typeof args.severity === 'string' ? args.severity : 'warn';
            }
            if (typeof args.fallback_choice === 'string') {
                payload.fallback_choice = args.fallback_choice;
            } else if (!payload.fallback_choice) {
                error = 'record_alert requires `fallback_choice` describing what you decided to do instead';
            }
            break;
        case 'request_amendment':
            if (typeof args.proposal === 'string') payload.proposal = args.proposal;
            break;
        case 'approve_and_continue':
            if (typeof args.mark_step_complete === 'number') {
                payload.mark_step_complete = args.mark_step_complete;
            }
            break;
        case 'wait':
        default:
            break;
    }

    // v3: decisions[] can ride along any action type. Force review_flag=true
    // for category B (grey-zone) so the UI always highlights them.
    if (Array.isArray(args.decisions) && args.decisions.length > 0) {
        payload.decisions = args.decisions.map((d) => ({
            step: typeof d.step === 'number' ? d.step : 0,
            category: d.category,
            plan_excerpt: String(d.plan_excerpt || ''),
            ambiguity: String(d.ambiguity || ''),
            choice: String(d.choice || ''),
            rationale: String(d.rationale || ''),
            scope: String(d.scope || 'local'),
            review_flag: d.category === 'B' ? true : (d.review_flag === true),
        }));
    }

    // Protocol v2: attach directiveId on inject_prompt/retry_with_hint so
    // downstream (ActionRouter + webview + DirectiveTracker) can correlate the
    // upcoming main-AI ack back to this directive.
    if (directiveId) {
        payload.directiveId = directiveId;
    }

    return {
        action: { action, reason, payload },
        error,
        directiveId,
    };
}

/**
 * Build the in-process MCP server that exposes emit_action. The supplied
 * onCapture callback receives the {action, reason, payload} wrapper on every
 * successful call.
 *
 * @param {object} sdk - resolved @anthropic-ai/claude-agent-sdk module
 * @param {object} zod - resolved zod module (loaded via sdk-loader.loadZod())
 * @param {(action: object) => void} onCapture
 * @param {{pairId: string, supervisorId: string}} [runtimeRef] - Phase 3:
 *        when provided, the {@code update_state} tool is also registered so
 *        the supervisor can commit L2 deltas. Without it (legacy callers /
 *        tests) only {@code emit_action} is exposed.
 * @returns {object} mcp server config compatible with the query() option
 */
export function buildSupervisorMcpServer(sdk, zod, onCapture, runtimeRef) {
    if (typeof sdk?.createSdkMcpServer !== 'function' || typeof sdk?.tool !== 'function') {
        throw new Error('Claude Agent SDK does not expose createSdkMcpServer/tool — please upgrade to >= 0.2.0');
    }
    const z = zod?.z ?? zod?.default?.z ?? zod;
    if (typeof z?.enum !== 'function' || typeof z?.string !== 'function') {
        throw new Error('zod module did not expose the expected z.* API');
    }

    const emitActionTool = sdk.tool(
        EMIT_ACTION_TOOL_NAME,
        'Emit your final ACTION decision for this turn. Call exactly once per turn; after a successful call, your turn is complete and you must not emit further text or tool calls.',
        buildEmitActionSchema(z),
        async (args) => {
            const result = normalizeAction(args);
            if (result.error) {
                return {
                    isError: true,
                    content: [{
                        type: 'text',
                        text: `Validation error: ${result.error}. Call emit_action again with the missing field.`,
                    }],
                };
            }
            // 2026-05-24 (Q4 trace): log inject_prompt captures so we can prove
            // the action made it OUT of the MCP handler (vs. being dropped on
            // SUPERVISOR_QUERY_TIMEOUT before normalizeAction). All inject_*
            // and retry_with_hint paths get a directiveId on payload.
            if (result.action && (result.action.action === 'inject_prompt'
                || result.action.action === 'retry_with_hint')) {
                const p = result.action.payload || {};
                const promptPreview = (p.inlinePrompt || p.prompt || '').slice(0, 80).replace(/\n/g, ' ');
                console.error(
                    `[INJECT_TRACE] daemon emit_action captured `
                    + `action=${result.action.action} directiveId=${p.directiveId || '(none)'} `
                    + `kind=${p.kind || '?'} objective=${(p.objective || '').slice(0, 60)} `
                    + `promptPreview="${promptPreview}"`
                );
            }
            try { onCapture(result.action); } catch { /* best-effort capture */ }
            return {
                content: [{ type: 'text', text: 'ACTION recorded. Turn complete.' }],
            };
        }
    );

    const tools = [emitActionTool];
    if (runtimeRef && typeof runtimeRef.pairId === 'string' && typeof runtimeRef.supervisorId === 'string') {
        tools.push(buildUpdateStateTool(sdk, zod, runtimeRef));
        // Protocol v2 (2026-05-24): save_plan lets the supervisor persist its
        // current step plan to .claude/pair/<pairId>/plan.md. Same runtime ref
        // contract as update_state.
        tools.push(buildSavePlanTool(sdk, zod, runtimeRef));
    }

    return sdk.createSdkMcpServer({
        name: SUPERVISOR_MCP_NAME,
        version: '1.0.0',
        tools,
    });
}
