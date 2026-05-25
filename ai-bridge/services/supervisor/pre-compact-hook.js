/**
 * Phase 3 (2026-05-24): PreCompact hook for supervisor runtimes.
 *
 * Fires immediately before the SDK auto-compacts a supervisor's
 * conversation. We emit a `[PRE_COMPACT]` line so the Java side can
 * dump the current L2 state to a timestamped snapshot file BEFORE the
 * SDK rewrites its in-memory history.
 *
 * <p>This is the safety net for the rotation pipeline:
 * <ul>
 *   <li>Normal rotation: producer prompt drives a clean handoff. The
 *       snapshot here is not used.</li>
 *   <li>Crash mid-rotation / handoff-producer fails: the rotation
 *       coordinator falls back to L2; the most recent precompact
 *       snapshot is at most one compaction old, much fresher than
 *       relying on `state.json` being current.</li>
 * </ul>
 *
 * <p>The hook returns `{}` (proceed with compaction). It does not block;
 * the daemon does not wait for Java to acknowledge the snapshot, so a
 * slow IDE side cannot stall the supervisor's auto-compact path.
 *
 * <p>HookInput contract (sdk.d.ts):
 *   trigger: 'manual' | 'auto'
 *   custom_instructions: string | null
 */

/**
 * Build the PreCompact hook callback for a given supervisor runtime.
 *
 * @param {{pairId: string, supervisorId: string}} runtimeRef
 * @returns {function(object, string|undefined, {signal: AbortSignal}): Promise<object>}
 */
export function buildPreCompactHook(runtimeRef) {
    return async function preCompactHook(input, _toolUseId, _options) {
        try {
            process.stdout.write('[PRE_COMPACT] ' + JSON.stringify({
                pairId: runtimeRef.pairId,
                supervisorId: runtimeRef.supervisorId,
                ts: Date.now(),
                trigger: input?.trigger || 'auto',
                customInstructions: input?.custom_instructions || null,
            }) + '\n');
        } catch (_) { /* stdout closed during shutdown */ }
        return {};
    };
}
