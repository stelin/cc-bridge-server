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
export const DISPATCH_TO_MAIN_AI_TOOL_NAME = 'dispatch_to_main_ai';
export const RETRY_MAIN_AI_WITH_HINT_TOOL_NAME = 'retry_main_ai_with_hint';
/** Phase 3 (2026-05-24): re-exported so callers can list expected tool names. */
export { UPDATE_STATE_TOOL_NAME, SAVE_PLAN_TOOL_NAME };
/** Fully-qualified tool name the API sees (mcp__<server>__<tool>). */
export const QUALIFIED_EMIT_ACTION = `mcp__${SUPERVISOR_MCP_NAME}__${EMIT_ACTION_TOOL_NAME}`;
export const QUALIFIED_DISPATCH_TO_MAIN_AI = `mcp__${SUPERVISOR_MCP_NAME}__${DISPATCH_TO_MAIN_AI_TOOL_NAME}`;
export const QUALIFIED_RETRY_MAIN_AI_WITH_HINT = `mcp__${SUPERVISOR_MCP_NAME}__${RETRY_MAIN_AI_WITH_HINT_TOOL_NAME}`;
export const QUALIFIED_UPDATE_STATE = `mcp__${SUPERVISOR_MCP_NAME}__${UPDATE_STATE_TOOL_NAME}`;
export const QUALIFIED_SAVE_PLAN = `mcp__${SUPERVISOR_MCP_NAME}__${SAVE_PLAN_TOOL_NAME}`;
// Plan A (2026-06-10): structured plan generator. Replaces save_plan as the
// canonical plan mechanism — feeds PlanStateMachine.onPlanCreated (structured
// steps + acceptance criteria), while plan.md becomes a Java-side projection.
export const EMIT_PLAN_TOOL_NAME = 'emit_plan';
export const QUALIFIED_EMIT_PLAN = `mcp__${SUPERVISOR_MCP_NAME}__${EMIT_PLAN_TOOL_NAME}`;

// 2026-05-26: inject_prompt and retry_with_hint moved to dedicated tools
// (dispatch_to_main_ai / retry_main_ai_with_hint) with schema-enforced required
// `prompt` fields. emit_action is strictly for non-dispatch flow control.
//
// 2026-05-26 (later): pruned `wait` — LLM kept calling it as a second tool
// after dispatch_to_main_ai, overwriting lastCapturedAction. No legitimate
// LLM use — turn-end IS the wait; the server-side downgrade in
// buildActionWrapper synthesises a wait wrapper when no closing tool was
// called, so "do nothing" is still expressible.
//
// `escalate_to_human` stays: in autonomy mode normalizeAction aliases it to
// record_alert(C2), but the UI / Java side still consume the legacy payload
// fields (question / choices / context_files / legacyEscalate). Non-autonomy
// deployments may also need a blocking human-in-the-loop path.
const ACTION_TYPES = [
    'approve_and_continue',
    'escalate_to_human',  // autonomy mode: aliased to record_alert + category=C2
    'record_alert',       // C1 = warn / C2 = alert
    'request_amendment',
    // v3.1 (2026-05-26): typed completion + typed wait. The Java ActionRouter
    // has handled these since the Contract State Machine v3 refactor, but this
    // (remote) schema never exposed them — so the supervisor was forced to fake
    // completion via `approve_and_continue + mark_step_complete=last`, which
    // never transitions the plan to DONE (workflow nodes then stall at 0/N).
    'complete_plan',
    'wait_for_contract',
    'complete_workflow_node',
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
            'Non-dispatch flow-control action. Dispatching to the main AI uses '
            + '`dispatch_to_main_ai` / `retry_main_ai_with_hint`, NOT this tool.'
        ),
        reason: z.string().optional().describe(
            'Short rationale (1-2 sentences) explaining this decision.'
        ),
        // record_alert fields
        severity: z.enum(['warn', 'alert']).optional().describe(
            'record_alert: severity level. warn = C1 soft alert, alert = C2 hard alert.'
        ),
        category: z.enum(['C1', 'C2']).optional().describe(
            'record_alert: decision category (C1 = auto-fallback with low confidence; C2 = skip step and continue).'
        ),
        fallback_choice: z.string().optional().describe(
            'record_alert: required — describes the fallback you took instead of human intervention.'
        ),
        // escalate_to_human fields (autonomy mode aliases to record_alert(C2), but
        // the UI / Java side still render these for the legacy escalate card)
        question: z.string().optional().describe(
            'escalate_to_human: question text shown to the human. In autonomy mode this aliases to record_alert(C2).'
        ),
        choices: z.array(z.string()).optional().describe(
            'escalate_to_human: optional choice list shown to the human.'
        ),
        context_files: z.array(z.string()).optional().describe(
            'escalate_to_human: optional file paths attached as context for the human.'
        ),
        blocking: z.boolean().optional().describe(
            'escalate_to_human: set true when you genuinely need the human to decide before '
            + 'work can continue — the UI then shows a blocking modal the user must answer '
            + '(even in autonomy mode, where escalate otherwise aliases to a non-blocking '
            + 'record_alert). An escalation carrying a `choices` list is treated as blocking '
            + 'automatically.'
        ),
        proposal: z.string().optional().describe(
            'request_amendment: the proposed plan change.'
        ),
        mark_step_complete: z.number().optional().describe(
            'approve_and_continue: step index to mark as done. NOTE: for a NON-FINAL '
            + 'step passing review. When the LAST step is done and the whole plan is '
            + 'complete, use action=complete_plan (or complete_workflow_node) instead.'
        ),
        // v3.1 typed-completion fields
        summary: z.string().optional().describe(
            'Used when action is complete_plan / complete_workflow_node. A short wrap-up '
            + 'of what the plan accomplished; becomes the COMPLETION_REPORT.md header.'
        ),
        node_status: z.enum(['done', 'blocked']).optional().describe(
            'Required when action is complete_workflow_node.'
        ),
        changed_files: z.array(z.string()).optional().describe(
            'complete_workflow_node + done: files this node created/modified.'
        ),
        contractId: z.string().optional().describe(
            'Required when action is wait_for_contract. The id of the OPEN contract you are '
            + 'waiting on (e.g. a previously-issued dispatch still in flight).'
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

    // Autonomy-mode alias: escalate_to_human → record_alert(C2). Legacy fields
    // (question / choices / context_files) preserved so the UI's escalate card
    // still renders correctly.
    if (action === 'escalate_to_human') {
        action = 'record_alert';
        payload.legacyEscalate = true;
        if (typeof args.question === 'string' && args.question.length > 0) {
            payload.question = args.question;
            if (typeof args.fallback_choice !== 'string') {
                payload.fallback_choice = '(legacy escalate, no fallback provided — please record next time)';
            }
        }
        if (Array.isArray(args.choices)) payload.choices = args.choices;
        if (Array.isArray(args.context_files)) payload.context_files = args.context_files;
        // Preserve the blocking intent through the alias so the Java ActionRouter
        // can promote a genuine human-decision back to a modal (vs. the default
        // non-blocking toast). A choices[] list is itself treated as blocking
        // downstream, so explicit blocking is only needed for choice-less asks.
        if (args.blocking === true) payload.blocking = true;
        payload.category = 'C2';
        payload.severity = 'alert';
    }

    switch (action) {
        case 'record_alert':
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
        case 'complete_plan':
            // summary is optional — the Java side classifies completion severity
            // from Plan.steps[] regardless, so a missing summary is not an error.
            if (typeof args.summary === 'string') payload.summary = args.summary;
            break;
        case 'complete_workflow_node':
            // node_status is mandatory; summary is optional, and changed_files is
            // only meaningful on a `done` completion.
            if (args.node_status !== 'done' && args.node_status !== 'blocked') {
                error = 'complete_workflow_node requires node_status = done|blocked';
            } else {
                payload.node_status = args.node_status;
                if (typeof args.summary === 'string') payload.summary = args.summary;
                if (args.node_status === 'done' && Array.isArray(args.changed_files)) {
                    payload.changed_files = args.changed_files;
                }
            }
            break;
        case 'wait_for_contract':
            if (typeof args.contractId === 'string' && args.contractId.length > 0) {
                payload.contractId = args.contractId;
            } else {
                error = 'wait_for_contract requires non-empty `contractId`';
            }
            break;
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

    return {
        action: { action, reason, payload },
        error,
    };
}

/**
 * 2026-05-26: schema for `dispatch_to_main_ai`. The `prompt` field is REQUIRED
 * at the API level — the Anthropic API rejects tool_use inputs that fail the
 * Zod-derived JSON Schema before the call ever reaches us. This is the
 * structural safety net replacing the legacy emit_action(inject_prompt) path
 * where prompt was optional and forgettable.
 */
function buildDispatchToMainAiSchema(z) {
    return {
        prompt: z.string().min(10).describe(
            'REQUIRED. The instruction text that will be injected as the main AI\'s '
            + 'next user message. Must be >= 10 chars. Write a direct instruction the '
            + 'main AI can act on — for ping/echo tests, write the exact reply text '
            + 'you want back. The main AI sees this verbatim; it does NOT see reason / objective.'
        ),
        reason: z.string().optional().describe(
            'Short rationale (1-2 sentences) for UI/log only. The main AI does NOT see this.'
        ),
        kind: z.enum(DIRECTIVE_KIND_LIST).optional().describe(
            'Directive kind: task_assignment | review_feedback | acknowledgement | bootstrap. '
            + 'Defaults to task_assignment.'
        ),
        objective: z.string().optional().describe(
            'One-sentence task objective for the structured payload (optional, supplements prompt).'
        ),
        context: z.object({
            previousStep: z.string().optional(),
            relatedFiles: z.array(z.string()).optional(),
        }).optional().describe(
            'Optional context: previous step summary, related file paths.'
        ),
        expectedDeliverables: z.array(z.string()).optional().describe(
            'Expected deliverable paths/descriptions for this task.'
        ),
        acceptanceCriteria: z.array(z.string()).optional().describe(
            'Acceptance criteria the main AI must meet.'
        ),
    };
}

/**
 * 2026-05-26: schema for `retry_main_ai_with_hint`. Same schema-level prompt
 * enforcement as dispatch_to_main_ai. Semantically distinct: this is for
 * asking the main AI to retry/adjust a previous attempt (review_feedback kind),
 * not for new task assignment.
 */
function buildRetryMainAiWithHintSchema(z) {
    return {
        prompt: z.string().min(10).describe(
            'REQUIRED. The hint / correction text the main AI will receive verbatim. '
            + 'Must be >= 10 chars. Write what specifically the main AI must change '
            + 'or redo — reference file:line or section if applicable.'
        ),
        reason: z.string().optional().describe(
            'Short rationale (1-2 sentences) for UI/log only. The main AI does NOT see this.'
        ),
        wait_seconds: z.number().optional().describe(
            'Optional delay in seconds before injecting the hint. Honors backoff for noisy retry loops.'
        ),
    };
}

/**
 * Pure builder for the dispatch_to_main_ai action wrapper. Extracted from the
 * tool handler so unit tests can exercise the payload shape without needing a
 * full SDK. The `generateId` parameter is injectable for deterministic tests.
 */
export function buildDispatchAction(args, generateId = generateDirectiveId) {
    const payload = {
        kind: typeof args.kind === 'string' ? args.kind : 'task_assignment',
        inlinePrompt: args.prompt,
        prompt: args.prompt,
    };
    if (typeof args.objective === 'string') payload.objective = args.objective;
    if (args.context && typeof args.context === 'object') payload.context = args.context;
    if (Array.isArray(args.expectedDeliverables)) payload.expectedDeliverables = args.expectedDeliverables;
    if (Array.isArray(args.acceptanceCriteria)) payload.acceptanceCriteria = args.acceptanceCriteria;
    payload.directiveId = generateId();

    return {
        action: 'inject_prompt',
        reason: typeof args.reason === 'string' ? args.reason : '',
        payload,
    };
}

/**
 * Pure builder for the retry_main_ai_with_hint action wrapper. See
 * buildDispatchAction for rationale.
 */
export function buildRetryAction(args, generateId = generateDirectiveId) {
    const payload = {
        kind: 'review_feedback',
        inlinePrompt: args.prompt,
        prompt: args.prompt,
    };
    if (typeof args.wait_seconds === 'number') payload.wait_seconds = args.wait_seconds;
    payload.directiveId = generateId();

    return {
        action: 'retry_with_hint',
        reason: typeof args.reason === 'string' ? args.reason : '',
        payload,
    };
}

/**
 * Plan A (2026-06-10): emit_plan — the structured-plan generator. The supervisor
 * calls this ONCE, on its first turn for a task ([PLANNING_REQUIRED]), to turn
 * the task into ordered steps, each with acceptance criteria it later verifies
 * real artifacts against. Replaces save_plan (freeform plan.md) as the canonical
 * plan mechanism: Java seeds PlanStateMachine.onPlanCreated from the emitted
 * [SUPERVISOR_PLAN] line, and renders plan.md as a projection. NOT a closing tool
 * (it precedes the step-1 dispatch in the same turn), so it captures via a
 * separate onCapturePlan callback, bypassing the closing-tool guard.
 */
function buildEmitPlanSchema(z) {
    return {
        steps: z.array(z.object({
            title: z.string().describe('步骤标题（一句话，命令式）。'),
            owner: z.enum(['MAIN_AI', 'SUPERVISOR']).optional().describe('默认 MAIN_AI。'),
            acceptanceCriteria: z.array(z.string()).optional().describe(
                '该步验收标准（可多条）。你之后据此 Read 真实产物逐条核验，不是听主 AI 自述。'
            ),
        })).describe('结构化步骤列表，按执行顺序。把外部任务拆解为可执行步骤，**不要发明目标**。'),
        rationale: z.string().optional().describe('可选：拆解思路（1-3 句）。'),
    };
}

/** Cross-field-validate emit_plan input → {plan:{steps,rationale}, error}. */
export function normalizePlan(args) {
    let error = null;
    const rationale = typeof args.rationale === 'string' ? args.rationale : '';
    const rawSteps = Array.isArray(args.steps) ? args.steps : [];
    if (rawSteps.length === 0) {
        return { plan: { steps: [], rationale }, error: 'emit_plan requires a non-empty `steps` array' };
    }
    const steps = [];
    for (let i = 0; i < rawSteps.length; i++) {
        const s = rawSteps[i] || {};
        const title = typeof s.title === 'string' ? s.title.trim() : '';
        if (!title) { error = `step #${i} is missing a non-empty \`title\``; break; }
        const owner = s.owner === 'SUPERVISOR' ? 'SUPERVISOR' : 'MAIN_AI';
        const acceptanceCriteria = Array.isArray(s.acceptanceCriteria)
            ? s.acceptanceCriteria.filter((c) => typeof c === 'string' && c.trim().length > 0)
            : [];
        steps.push({ index: i, title, owner, acceptanceCriteria });
    }
    return { plan: { steps, rationale }, error };
}

function buildEmitPlanTool(sdk, z, onCapturePlan) {
    return sdk.tool(
        EMIT_PLAN_TOOL_NAME,
        'Emit the structured plan for the current task. Call EXACTLY ONCE, on your '
        + 'first turn after a [PLANNING_REQUIRED] marker, BEFORE dispatching. Break the '
        + 'task into ordered steps, each with acceptance criteria you will later verify. '
        + 'This is NOT a closing tool — after emit_plan you still call dispatch_to_main_ai '
        + 'to send step 1. The plan is then LOCKED — change it via '
        + 'emit_action(request_amendment), not by calling emit_plan again.',
        buildEmitPlanSchema(z),
        async (args) => {
            const result = normalizePlan(args);
            if (result.error) {
                return {
                    isError: true,
                    content: [{ type: 'text', text: `Validation error: ${result.error}. Call emit_plan again with corrected steps.` }],
                };
            }
            try { onCapturePlan(result.plan); } catch { /* best-effort capture */ }
            return {
                content: [{
                    type: 'text',
                    text: `Plan recorded (${result.plan.steps.length} steps). Now dispatch step 1 via `
                        + `dispatch_to_main_ai. Use emit_action(request_amendment) to change the plan later.`,
                }],
            };
        }
    );
}

/**
 * Build the in-process MCP server that exposes emit_action and
 * dispatch_to_main_ai. The supplied onCapture callback receives the
 * {action, reason, payload} wrapper on every successful call from either tool.
 *
 * @param {object} sdk - resolved @anthropic-ai/claude-agent-sdk module
 * @param {object} zod - resolved zod module (loaded via sdk-loader.loadZod())
 * @param {(action: object) => boolean} onCapture
 * @param {{pairId: string, supervisorId: string}} [runtimeRef] - Phase 3:
 *        when provided, the {@code update_state} tool is also registered so
 *        the supervisor can commit L2 deltas. Without it (legacy callers /
 *        tests) only {@code emit_action} is exposed.
 * @param {(plan: object) => void} [onCapturePlan] - Plan A: when provided, the
 *        {@code emit_plan} tool is registered and captures the structured plan
 *        via this callback (separate from onCapture — emit_plan is non-closing).
 * @returns {object} mcp server config compatible with the query() option
 */
export function buildSupervisorMcpServer(sdk, zod, onCapture, runtimeRef, onCapturePlan, extraTools = []) {
    if (typeof sdk?.createSdkMcpServer !== 'function' || typeof sdk?.tool !== 'function') {
        throw new Error('Claude Agent SDK does not expose createSdkMcpServer/tool — please upgrade to >= 0.2.0');
    }
    const z = zod?.z ?? zod?.default?.z ?? zod;
    if (typeof z?.enum !== 'function' || typeof z?.string !== 'function') {
        throw new Error('zod module did not expose the expected z.* API');
    }

    const emitActionTool = sdk.tool(
        EMIT_ACTION_TOOL_NAME,
        'Emit a NON-DISPATCH flow-control action for this turn (wait / approve_and_continue / '
            + 'record_alert / request_amendment / escalate_to_human). '
            + 'For dispatching tasks to the main AI, use `dispatch_to_main_ai`. '
            + 'For asking the main AI to retry with a hint, use `retry_main_ai_with_hint`. '
            + 'Call exactly one closing tool per turn (this OR a dispatch tool, not both); '
            + 'after a successful call, your turn is complete.',
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
            let captured = false;
            try { captured = onCapture(result.action) === true; } catch { captured = false; }
            if (!captured) {
                return {
                    isError: true,
                    content: [{
                        type: 'text',
                        text: 'Closing-tool guard: another closing tool (dispatch_to_main_ai / '
                            + 'retry_main_ai_with_hint / emit_action) was already called this turn. '
                            + 'Exactly ONE closing tool per turn. Your turn is already complete — do not call another. '
                            + 'If you intended to dispatch AND then wait, just call the dispatch tool — '
                            + 'the system automatically waits for the main AI ack on the next turn.',
                    }],
                };
            }
            return {
                content: [{ type: 'text', text: 'ACTION recorded. Turn complete.' }],
            };
        }
    );

    // 2026-05-26: dispatch_to_main_ai is the schema-enforced replacement for
    // emit_action(action='inject_prompt'). The prompt field is required by
    // schema (z.string().min(10)), so the API blocks malformed calls before
    // they reach the handler. Internally it normalises to the same
    // {action: 'inject_prompt', payload: {inlinePrompt, ...}} wrapper the
    // Java ActionRouter consumes — no IPC protocol change needed.
    const dispatchToMainAiTool = sdk.tool(
        DISPATCH_TO_MAIN_AI_TOOL_NAME,
        'Dispatch a task to the main AI. This is the ONLY way to give the main AI '
            + 'work. The `prompt` field is required and is what the main AI actually '
            + 'reads — write it as a direct instruction. Call this exactly once per '
            + 'turn; after a successful call your turn is complete.',
        buildDispatchToMainAiSchema(z),
        async (args) => {
            const action = buildDispatchAction(args);
            const promptPreview = args.prompt.slice(0, 80).replace(/\n/g, ' ');
            console.error(
                `[INJECT_TRACE] daemon dispatch_to_main_ai captured `
                + `directiveId=${action.payload.directiveId} `
                + `kind=${action.payload.kind} objective=${(action.payload.objective || '').slice(0, 60)} `
                + `promptPreview="${promptPreview}"`
            );
            let captured = false;
            try { captured = onCapture(action) === true; } catch { captured = false; }
            if (!captured) {
                return {
                    isError: true,
                    content: [{
                        type: 'text',
                        text: 'Closing-tool guard: another closing tool was already called this turn. '
                            + 'Exactly ONE closing tool per turn. Your turn is already complete — do not call another.',
                    }],
                };
            }
            return {
                content: [{
                    type: 'text',
                    text: 'Dispatched. Main AI will receive your prompt. Turn complete. '
                        + 'Do NOT call emit_action(wait) — the system automatically waits for the main AI ack on the next turn.',
                }],
            };
        }
    );

    // 2026-05-26: retry_main_ai_with_hint replaces emit_action(action='retry_with_hint')
    // with the same schema-enforced prompt requirement. Internally normalises to
    // {action: 'retry_with_hint', payload: {inlinePrompt, ...}} so the Java
    // ActionRouter sees no protocol change.
    const retryMainAiWithHintTool = sdk.tool(
        RETRY_MAIN_AI_WITH_HINT_TOOL_NAME,
        'Ask the main AI to retry / adjust its previous attempt with a corrective '
            + 'hint. Use this for review feedback. The `prompt` field is required and '
            + 'is what the main AI reads verbatim — write the specific change you want. '
            + 'Call this exactly once per turn; after a successful call your turn is complete.',
        buildRetryMainAiWithHintSchema(z),
        async (args) => {
            const action = buildRetryAction(args);
            const promptPreview = args.prompt.slice(0, 80).replace(/\n/g, ' ');
            console.error(
                `[INJECT_TRACE] daemon retry_main_ai_with_hint captured `
                + `directiveId=${action.payload.directiveId} `
                + `wait_seconds=${action.payload.wait_seconds ?? '-'} `
                + `promptPreview="${promptPreview}"`
            );
            let captured = false;
            try { captured = onCapture(action) === true; } catch { captured = false; }
            if (!captured) {
                return {
                    isError: true,
                    content: [{
                        type: 'text',
                        text: 'Closing-tool guard: another closing tool was already called this turn. '
                            + 'Exactly ONE closing tool per turn. Your turn is already complete — do not call another.',
                    }],
                };
            }
            return {
                content: [{
                    type: 'text',
                    text: 'Retry hint dispatched. Main AI will receive your hint. Turn complete. '
                        + 'Do NOT call emit_action(wait) — the system automatically waits for the main AI ack on the next turn.',
                }],
            };
        }
    );

    const tools = [emitActionTool, dispatchToMainAiTool, retryMainAiWithHintTool];
    if (runtimeRef && typeof runtimeRef.pairId === 'string' && typeof runtimeRef.supervisorId === 'string') {
        tools.push(buildUpdateStateTool(sdk, zod, runtimeRef));
    }
    // Plan A (2026-06-10): emit_plan replaces save_plan as the canonical plan
    // mechanism (structured steps → PlanStateMachine, plan.md = Java projection).
    // save_plan is no longer registered. emit_plan captures via onCapturePlan,
    // NOT the closing-tool guard, so it can precede the step-1 dispatch.
    if (typeof onCapturePlan === 'function') {
        tools.push(buildEmitPlanTool(sdk, z, onCapturePlan));
    }

    if (Array.isArray(extraTools) && extraTools.length > 0) {
        tools.push(...extraTools);
    }

    return sdk.createSdkMcpServer({
        name: SUPERVISOR_MCP_NAME,
        version: '1.0.0',
        tools,
    });
}
