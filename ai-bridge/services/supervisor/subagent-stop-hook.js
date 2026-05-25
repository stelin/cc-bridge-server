/**
 * SubagentStop hook for the MAIN AI runtime. Forwards the SDK's SubagentStop
 * event (fired when a Task subagent finishes) as a [SUBAGENT_STOP] NDJSON line
 * so the Java EventBus can publish it into the supervisor's compositer stream.
 * Bound only to main-AI runtimes since supervisor's own subagents are already
 * visible directly in supervisor's SDK stream.
 */

export function buildSubagentStopHook(ctx) {
  return async function subagentStopHook(input) {
    try {
      process.stdout.write('[SUBAGENT_STOP] ' + JSON.stringify({
        type: 'subagent_stop',
        sessionId: ctx.sessionId || null,
        turnId: ctx.currentTurnId || null,
        ts: Date.now(),
        payload: {
          agentId: input?.agent_id ?? null,
          agentType: input?.agent_type ?? null,
          taskSubject: input?.task_subject ?? null,
          lastAssistantMessage: input?.last_assistant_message ?? null,
          transcriptPath: input?.agent_transcript_path ?? null,
          parentToolUseId: input?.parent_tool_use_id ?? null,
          durationMs: typeof input?.duration_ms === 'number' ? input.duration_ms : 0,
        },
      }) + '\n');
    } catch (_) { /* stdout closed during shutdown */ }
    return { continue: true };
  };
}
