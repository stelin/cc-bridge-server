/**
 * `save_plan` MCP tool. Supervisor calls this to persist the current plan to
 * .claude/pair/<pairId>/plan.md. Each call auto-backs-up the previous version
 * to plan_v<n>.md.bak so re-plans don't lose history.
 */

import fs from 'node:fs';
import path from 'node:path';

export const SAVE_PLAN_TOOL_NAME = 'save_plan';

function buildSavePlanSchema(z) {
  return {
    content: z.string().describe('Full plan.md content as a markdown string.'),
    reason: z.string().describe('Why generating/regenerating the plan now (e.g. "initial bootstrap from design.md", "re-plan after step 5").'),
    source: z.enum(['design_doc', 'replan', 'manual']).describe(
      'Origin: design_doc = first-time extraction from design; replan = T1 periodic re-plan; manual = misc'
    ),
  };
}

function resolveProjectCwd() {
  return process.env.IDEA_PROJECT_PATH || process.env.PROJECT_PATH || process.cwd();
}

function nextVersion(pairDir) {
  let max = 0;
  try {
    for (const f of fs.readdirSync(pairDir)) {
      const m = f.match(/^plan_v(\d+)\.md\.bak$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  } catch (_) { /* dir does not exist yet */ }
  return max + 1;
}

export function buildSavePlanTool(sdk, zod, runtimeRef) {
  const z = zod?.z ?? zod?.default?.z ?? zod;
  return sdk.tool(
    SAVE_PLAN_TOOL_NAME,
    'Persist the current step plan to .claude/pair/<pairId>/plan.md. Previous ' +
    'versions are auto-backed-up to plan_v<n>.md.bak. Use after extracting steps ' +
    'from a design doc, or after a periodic re-plan revises the plan.',
    buildSavePlanSchema(z),
    async (args) => {
      const cwd = resolveProjectCwd();
      const pairDir = path.join(cwd, '.claude', 'pair', runtimeRef.pairId);
      fs.mkdirSync(pairDir, { recursive: true });

      const planPath = path.join(pairDir, 'plan.md');
      if (fs.existsSync(planPath)) {
        const version = nextVersion(pairDir);
        const bakPath = path.join(pairDir, `plan_v${version}.md.bak`);
        try { fs.copyFileSync(planPath, bakPath); } catch (_) { /* best-effort */ }
      }
      fs.writeFileSync(planPath, args.content, 'utf8');

      const relPath = path.posix.join('.claude', 'pair', runtimeRef.pairId, 'plan.md');
      try {
        process.stdout.write('[PLAN_SAVED] ' + JSON.stringify({
          pairId: runtimeRef.pairId,
          supervisorId: runtimeRef.supervisorId,
          ts: Date.now(),
          path: relPath,
          source: args.source,
          reason: args.reason,
          bytes: Buffer.byteLength(args.content, 'utf8'),
        }) + '\n');
      } catch (_) { /* stdout closed */ }

      return {
        content: [{
          type: 'text',
          text: `plan saved to ${relPath} (source=${args.source})`,
        }],
      };
    }
  );
}
