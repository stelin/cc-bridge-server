/**
 * Supervisor session-resume integration test (session-resume-plan.md §9.2).
 *
 * Drives the REAL supervisor channel end-to-end to verify the one runtime
 * unknown the plan flagged (SR5 / "2a"): can a streaming-input supervisor
 * session — which uses a custom string systemPrompt, NOT the claude_code
 * preset — be transcript-resumed by session_id?
 *
 * Flow:
 *   1. start a supervisor whose plan embeds a unique passphrase
 *   2. drive one turn (transcript gets content) → capture session_id (sid1)
 *   3. stop the session
 *   4. start again with { resumeSessionId: sid1 }
 *   5. drive one turn asking it to recall the passphrase → capture sid2
 *   6. PASS iff sid2 === sid1 (SDK continued the SAME session = resume honoured)
 *      and (soft) the recall turn echoed the passphrase (history really loaded).
 *
 * HOW TO RUN (needs the SAME environment the daemon runs in):
 *   - the Claude Agent SDK installed/resolvable (same as the daemon), and
 *   - auth configured the same way the daemon authenticates
 *     (a logged-in `claude` CLI, or ANTHROPIC_API_KEY in the env).
 *
 *     cd ai-bridge
 *     node test/supervisor-resume.test.mjs
 *
 *   Expected on success:
 *     [SUPERVISOR_SESSION] ... (sid1)
 *     [SUPERVISOR_SESSION] ... (sid2 === sid1)   ← no [SUPERVISOR_RESUME_MISS]
 *     RESULT: PASS  resume=ok  recall=ok|unknown
 *
 *   If you see [SUPERVISOR_RESUME_MISS] or sid2 !== sid1 → the SDK did NOT honour
 *   resume for custom-systemPrompt streaming sessions → trigger plan SR6
 *   (supervisor falls back to "fresh + handoff summary"; main AI still resumes).
 *
 * This is a live-LLM test (costs a few tokens, ~1-2 turns). It is NOT wired into
 * CI; run it by hand when validating the resume path.
 */

import {
  startSupervisorSession,
  postEventToSupervisor,
  stopSupervisorSession,
  getSupervisorSessionId,
} from '../channels/supervisor-channel.js';
import { isClaudeSdkAvailable } from '../utils/sdk-loader.js';

const PAIR_ID = 'resume-spike-pair';
const SUP_ID = 'resume-spike-supervisor';
const PASSPHRASE = 'BANANA-42-' + Math.random().toString(36).slice(2, 7).toUpperCase();
const TURN_TIMEOUT_MS = 120_000;

/** Capture the daemon's stdout marker lines while still echoing them. */
const captured = [];
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  try {
    const s = typeof chunk === 'string' ? chunk : chunk?.toString?.() ?? '';
    for (const line of s.split('\n')) {
      if (line.startsWith('[SUPERVISOR_SESSION]')
        || line.startsWith('[SUPERVISOR_RESUME_MISS]')
        || line.startsWith('[SUPERVISOR_ACTION]')) {
        captured.push(line);
      }
    }
  } catch { /* ignore */ }
  return realWrite(chunk, ...rest);
};

function lastAction() {
  for (let i = captured.length - 1; i >= 0; i -= 1) {
    if (captured[i].startsWith('[SUPERVISOR_ACTION]')) {
      try { return JSON.parse(captured[i].slice('[SUPERVISOR_ACTION]'.length).trim()); }
      catch { return null; }
    }
  }
  return null;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label} (${ms}ms)`)), ms)),
  ]);
}

async function driveTurn(text) {
  return withTimeout(
    postEventToSupervisor({
      pairId: PAIR_ID,
      supervisorId: SUP_ID,
      event: { type: 'user_input', payload: { text } },
    }),
    TURN_TIMEOUT_MS,
    'postEventToSupervisor',
  );
}

async function startSession(resumeSessionId) {
  return startSupervisorSession({
    pairId: PAIR_ID,
    supervisorId: SUP_ID,
    name: 'ResumeSpike',
    description: '你是恢复测试用的协调者。收到指令就用 emit_action(wait,{reason}) 回应即可,'
      + '把要说的话写进 reason。不需要派单、不需要读文件。',
    planContent: `恢复测试任务。重要口令(必须记住,后面会让你复述): ${PASSPHRASE}`,
    model: process.env.SUPERVISOR_TEST_MODEL || undefined,
    ...(resumeSessionId && { resumeSessionId }),
  });
}

async function main() {
  if (!isClaudeSdkAvailable()) {
    console.log('SKIP: Claude SDK not available in this environment.');
    console.log('  → run from a machine where the daemon can run (SDK installed + auth configured).');
    process.exitCode = 0;
    return;
  }

  console.log(`[spike] passphrase = ${PASSPHRASE}`);

  // ── Round 1: fresh session, plant the passphrase, capture sid1 ──
  console.log('[spike] round 1: start fresh + drive one turn …');
  await startSession(null);
  await driveTurn('确认收到方案。请用 emit_action(wait) 回应,reason 写「已记住口令」。');
  const sid1 = getSupervisorSessionId(PAIR_ID, SUP_ID);
  console.log(`[spike] sid1 = ${sid1 || '(none captured!)'}`);
  await stopSupervisorSession({ pairId: PAIR_ID, supervisorId: SUP_ID });

  if (!sid1) {
    finish(false, 'no session_id captured on round 1 — SDK never emitted one (transcript may not persist)');
    return;
  }

  // ── Round 2: resume sid1, ask it to recall, capture sid2 ──
  console.log('[spike] round 2: start with resume + drive one turn …');
  captured.length = 0;           // clear so lastAction() reads round-2's reply
  await startSession(sid1);
  await driveTurn('请复述你之前记住的口令(就是方案里那个),用 emit_action(wait) 回应,reason 写出口令。');
  const sid2 = getSupervisorSessionId(PAIR_ID, SUP_ID);
  console.log(`[spike] sid2 = ${sid2 || '(none)'}`);
  await stopSupervisorSession({ pairId: PAIR_ID, supervisorId: SUP_ID });

  const resumeMiss = captured.some((l) => l.startsWith('[SUPERVISOR_RESUME_MISS]'));
  const resumeOk = !!sid2 && sid2 === sid1 && !resumeMiss;

  const action = lastAction();
  const replyText = action
    ? JSON.stringify(action.action || action) + ' ' + (action.naturalText || '') + ' ' + (action.reasoningText || '')
    : '';
  const recall = replyText.includes(PASSPHRASE) ? 'ok'
    : (action ? 'unknown(passphrase not echoed — persona may have refused)' : 'unknown(no action parsed)');

  finish(resumeOk, resumeOk
    ? `resume honoured (sid2===sid1)`
    : (resumeMiss ? `[SUPERVISOR_RESUME_MISS] emitted` : `sid2(${sid2}) !== sid1(${sid1})`), recall);
}

function finish(resumeOk, detail, recall = 'n/a') {
  console.log('────────────────────────────────────────');
  console.log(`RESULT: ${resumeOk ? 'PASS' : 'FAIL'}  resume=${resumeOk ? 'ok' : 'no'}  recall=${recall}`);
  console.log(`  detail: ${detail}`);
  if (!resumeOk) {
    console.log('  → SR5/2a NOT met for supervisor. Plan SR6: supervisor falls back to');
    console.log('    "fresh session + handoff summary"; main AI still transcript-resumes.');
  }
  process.stdout.write = realWrite;   // restore
  process.exitCode = resumeOk ? 0 : 1;
}

main().catch((err) => {
  console.error('[spike] ERROR:', err?.stack || err?.message || String(err));
  try { process.stdout.write = realWrite; } catch { /* ignore */ }
  process.exitCode = 2;
});
