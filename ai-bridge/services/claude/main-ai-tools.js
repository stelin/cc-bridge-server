/**
 * Main-AI side MCP server. Exposes `report_turn_completion` which the main AI
 * must call before ending each turn in Pair mode. Emits a [TURN_REPORT] NDJSON
 * line tagged with sessionId / turnId / directiveId so the Java EventBus can
 * correlate the report back to the supervisor's outstanding directive.
 */

import { loadClaudeSdk, loadZod } from '../../utils/sdk-loader.js';
import { generateTurnId } from '../supervisor/protocol-v2.js';
import { maybeSpill } from '../../utils/spill-to-file.js';
import { buildQueryBugDetailsTool, buildReportBugFixTool } from '../supervisor/yunxiao-tools.js';

export const MAIN_MCP_NAME = 'main';
export const REPORT_TURN_COMPLETION_TOOL_NAME = 'report_turn_completion';

function buildSchema(z) {
  return {
    summary: z.string().describe('One- to two-sentence task-level summary of what was accomplished this turn.'),
    deliverables: z.array(z.object({
      path: z.string().describe('Project-root-relative POSIX path.'),
      change: z.string().describe('Short description of what changed in this file (<=200 chars).'),
      confidence: z.enum(['high', 'medium', 'low']).optional()
        .describe('Per-deliverable confidence; omit when unsure.'),
    })).describe('Files you created or modified this turn. Empty list if no file change (e.g. pure investigation turn).'),
    verifications: z.array(z.object({
      command: z.string(),
      pass: z.boolean(),
      stderrTail: z.string().optional().describe('Failure detail, <=1KB tail of stderr.'),
    })).optional().describe('Any verification commands you ran (build/test/lint).'),
    selfAssessment: z.object({
      confidence: z.enum(['high', 'medium', 'low'])
        .describe('Your overall confidence in this turn\'s correctness.'),
      concerns: z.array(z.string())
        .describe('Specific points you are unsure about. Empty list when fully confident.'),
      suggestedReview: z.string().optional()
        .describe('Optional: suggest where supervisor should focus review (e.g. "user_dao.go:42-58").'),
    }).describe('Required self-assessment. Supervisor uses this to triage whether to run extra review.'),
    durationMs: z.number().optional()
      .describe('Optional: this turn\'s wall-clock duration in milliseconds. ' +
        'If omitted, Java side will compute it from turn boundaries.'),
  };
}

export async function buildMainAiMcpServer(runtimeRef) {
  const [sdk, zod] = await Promise.all([loadClaudeSdk(), loadZod()]);
  const z = zod?.z ?? zod?.default?.z ?? zod;
  if (typeof sdk?.createSdkMcpServer !== 'function' || typeof sdk?.tool !== 'function') {
    throw new Error('Claude SDK does not expose createSdkMcpServer/tool');
  }

  const tools = [];

  // query_bug_details — 云效缺陷详情聚合工具。Available to the main AI in ALL modes
  // (normal chat + Pair), so the user can ask it to pull a bug's full context
  // directly. Credentials come from process.env.YUNXIAO_* (Java buildDaemonEnv).
  try {
    tools.push(buildQueryBugDetailsTool(sdk, zod));
  } catch (e) {
    console.error('[MAIN_AI_TOOLS] buildQueryBugDetailsTool failed:', e?.message || e);
  }

  // comment_bug_fix — 把修复结论(原因/修复/测试)评论回云效缺陷。All modes; auto-allowed
  // in permission-handler (write op the user authorized via the fix prompt).
  try {
    tools.push(buildReportBugFixTool(sdk, zod));
  } catch (e) {
    console.error('[MAIN_AI_TOOLS] buildReportBugFixTool failed:', e?.message || e);
  }

  // report_turn_completion — Pair mode only (needs a supervisor to report to).
  if (!runtimeRef || !runtimeRef.pairId) {
    return sdk.createSdkMcpServer({
      name: MAIN_MCP_NAME,
      version: '1.0.0',
      tools,
    });
  }

  const tool = sdk.tool(
    REPORT_TURN_COMPLETION_TOOL_NAME,
    'MUST be called by the main AI before ending each turn when running in Pair ' +
    'mode. Reports task-level outcome + self-assessment so the supervisor can ' +
    'triage review effort. Calling more than once per turn overwrites prior calls ' +
    '(last write wins).',
    buildSchema(z),
    async (args) => {
      const turnId = generateTurnId();
      const pairId = runtimeRef.pairId || 'unknown';

      const { inline: summaryInline, spilledPath } = maybeSpill({
        content: args.summary || '',
        kind: 'turn',
        pairId,
        name: turnId,
      });

      try {
        process.stdout.write('[TURN_REPORT] ' + JSON.stringify({
          type: 'turn_report',
          sessionId: runtimeRef.sessionId || null,
          turnId,
          directiveId: runtimeRef.activeDirectiveId || null,
          ts: Date.now(),
          payload: {
            summary: summaryInline ?? args.summary,
            deliverables: args.deliverables || [],
            verifications: args.verifications || [],
            selfAssessment: args.selfAssessment,
            subagentSummary: null,
            // Main AI may pass its own measurement; otherwise emit 0 and let
            // the Java side compute from turn boundaries (turnStartedAt).
            durationMs: typeof args.durationMs === 'number' && args.durationMs >= 0
              ? args.durationMs : 0,
            spilledPath,
          },
        }) + '\n');
      } catch (_) { /* stdout closed */ }

      return {
        content: [{
          type: 'text',
          text: 'turn completion reported (turnId=' + turnId + ')',
        }],
      };
    }
  );
  tools.push(tool);

  return sdk.createSdkMcpServer({
    name: MAIN_MCP_NAME,
    version: '1.0.0',
    tools,
  });
}
