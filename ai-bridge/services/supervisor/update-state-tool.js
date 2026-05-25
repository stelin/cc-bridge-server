/**
 * Phase 3 (2026-05-24): `update_state` MCP tool.
 *
 * Lets the supervisor LLM commit structured facts ("step 5 in progress",
 * "edited a.go at mtime X", "discovered constraint Y") into the Pair's
 * L2 durable state. The Java side captures the emitted `[STATE_UPDATE]`
 * line and applies the delta through {@code L2Store.applyUpdateStateDelta}.
 *
 * <p>Design intent: the supervisor decides WHAT to record (it is the only
 * actor that observes the whole turn end-to-end); the Java side decides
 * HOW to persist + when to back up. Keeps the daemon stateless w.r.t. L2.
 *
 * <p>Tool semantics:
 *   - Call from any turn (not restricted to a particular event type).
 *   - Multiple calls per turn are allowed — they accumulate.
 *   - Each call emits exactly one `[STATE_UPDATE]` line, request-id-tagged.
 *   - Fields are sparse — only what changed needs to be included.
 *
 * <p>Schema mirrored Java-side at
 * {@code L2Store.applyUpdateStateDelta(JsonObject)}. Keep aligned when
 * fields evolve.
 */

export const UPDATE_STATE_TOOL_NAME = 'update_state';

/**
 * Build the Zod input schema for update_state. All branches are optional;
 * callers send only the fields they need to mutate.
 */
function buildUpdateStateSchema(z) {
    return {
        anchoredFactsDelta: z.object({
            currentStep: z.number().optional(),
            totalSteps: z.number().optional(),
            currentStepTitle: z.string().optional(),
            blockedOn: z.string().nullable().optional(),
            lastVerifyCmd: z.string().optional(),
            lastVerifyResult: z.string().optional(),
            lastVerifyAt: z.number().optional(),
        }).optional().describe(
            'Shallow-merge into the pair\'s anchoredFacts (currentStep, totalSteps, ' +
            'lastVerifyCmd/Result, blockedOn). Update only fields that changed this turn.'
        ),
        planProgressDelta: z.array(z.object({
            step: z.number(),
            status: z.enum(['todo', 'in_progress', 'done', 'blocked', 'skipped']).optional(),
            attempts: z.number().optional(),
            lastError: z.string().nullable().optional(),
            completedAt: z.number().optional(),
            filesChanged: z.array(z.string()).optional(),
        })).optional().describe(
            'Upsert plan-progress entries by step number. Each entry merges into ' +
            'the existing one (or creates it).'
        ),
        fileStateDelta: z.record(z.object({
            mtime: z.number().optional(),
            lastTouchedBy: z.string().optional(),
            linesChanged: z.number().optional(),
            confidence: z.enum(['high', 'medium', 'low']).optional(),
        })).optional().describe(
            'Per-file state changes keyed by cwd-relative path. Use after observing a ' +
            'main-AI Edit/Write event so the successor knows the file is in scope.'
        ),
        decisionAppend: z.object({
            ts: z.number().optional(),
            action: z.string(),
            reason: z.string().optional(),
            payload: z.any().optional(),
            result: z.string().optional(),
            confidence: z.enum(['high', 'medium', 'low']).optional(),
            // Protocol v2 (2026-05-24): autonomy-mode fields. All optional so
            // legacy callers stay compatible.
            category: z.enum(['A', 'B', 'C1', 'C2', 'C3']).optional().describe(
                'Decision class. A=trivial / B=meaningful-trace / ' +
                'C1=auto-fallback with low confidence / C2=record_alert + skip step / ' +
                'C3=hard block (truly pauses the plan). Defaults to A.'
            ),
            severity: z.enum(['info', 'warn', 'alert']).optional().describe(
                'For C2 use "alert"; for budget warnings use "warn"; default "info".'
            ),
            candidates: z.array(z.object({
                option: z.string(),
                score: z.number().optional(),
            })).optional().describe(
                'Options considered at this decision point; helpful for post-mortem audit.'
            ),
            chosenCandidate: z.string().optional().describe(
                'Which candidate was chosen (free-form text, usually mirrors candidates[i].option).'
            ),
            evidence: z.array(z.object({
                kind: z.enum(['file_read', 'subagent', 'main_turn', 'verification']),
                path: z.string().optional(),
                lines: z.string().optional(),
                agentId: z.string().optional(),
                turnId: z.string().optional(),
                output: z.string().optional().describe('<=500 char summary'),
            })).optional().describe(
                'Sources of evidence behind this decision (file reads, subagent results, ' +
                'main-AI turn reports, verification command outputs).'
            ),
            stepId: z.number().optional().describe('Plan step number this decision relates to.'),
            autoMode: z.boolean().optional().describe('True = autonomous self-decision; false = user-prompted.'),
        }).optional().describe(
            'Append a structured decision to the recent-decisions ring. Ring caps ' +
            'Java-side at 100 entries OR a 24h time window, whichever evicts first.'
        ),
        constraintAdd: z.string().optional().describe(
            'Add a hard constraint to knownConstraints (e.g. "must use langchaingo"). ' +
            'Deduplicated Java-side — sending the same string twice is a no-op.'
        ),
    };
}

/**
 * Build the {@code update_state} MCP tool descriptor.
 *
 * @param {object} sdk - resolved @anthropic-ai/claude-agent-sdk module
 * @param {object} zod - resolved zod module
 * @param {{pairId: string, supervisorId: string}} runtimeRef - the runtime
 *        whose pairId/supervisorId tag every emitted [STATE_UPDATE] line
 */
export function buildUpdateStateTool(sdk, zod, runtimeRef) {
    const z = zod?.z ?? zod?.default?.z ?? zod;
    return sdk.tool(
        UPDATE_STATE_TOOL_NAME,
        'Commit a structured state delta (anchored facts, plan progress, file state, ' +
        'a decision record, or a new constraint) to the Pair\'s durable L2 store. ' +
        'Use frequently — every meaningful observation should land here so the next ' +
        'generation (after rotation) can pick up where you left off without amnesia. ' +
        'Multiple calls per turn are allowed; fields are sparse-merged.',
        buildUpdateStateSchema(z),
        async (args) => {
            try {
                process.stdout.write('[STATE_UPDATE] ' + JSON.stringify({
                    pairId: runtimeRef.pairId,
                    supervisorId: runtimeRef.supervisorId,
                    ts: Date.now(),
                    delta: args,
                }) + '\n');
            } catch (_) { /* stdout closed during shutdown */ }
            return {
                content: [{
                    type: 'text',
                    text: 'state delta recorded',
                }],
            };
        }
    );
}
