/**
 * Auto-spill payloads larger than 8KB (configurable via env) to project-level
 * .claude/pair/<pairId>/ directory. Used by inject_prompt and report_turn_completion
 * to keep IPC lines small while preserving full artifacts on disk.
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_THRESHOLD = 8192;

function getThreshold() {
  const raw = process.env.PAIR_SPILL_THRESHOLD_BYTES;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_THRESHOLD;
}

function resolveProjectCwd() {
  return process.env.IDEA_PROJECT_PATH || process.env.PROJECT_PATH || process.cwd();
}

/**
 * @param {object} args
 * @param {string} args.content
 * @param {'turn' | 'directive'} args.kind
 * @param {string} args.pairId
 * @param {string} args.name  filename without extension
 * @returns {{ inline: string|null, spilledPath: string|null }}
 *   Failure modes:
 *   - mkdir/write throws (disk full, permission denied, etc.) → degrade to
 *     inline mode (caller still gets the full content via .inline).
 *   - non-string content → returns empty inline, no spill.
 */
export function maybeSpill({ content, kind, pairId, name }) {
  if (typeof content !== 'string') {
    return { inline: '', spilledPath: null };
  }
  const threshold = getThreshold();
  if (Buffer.byteLength(content, 'utf8') <= threshold) {
    return { inline: content, spilledPath: null };
  }

  const subdir = kind === 'turn' ? 'main_turns' : 'directives';
  const cwd = resolveProjectCwd();
  const absDir = path.join(cwd, '.claude', 'pair', pairId, subdir);
  const filename = `${name}.md`;
  const absPath = path.join(absDir, filename);

  try {
    fs.mkdirSync(absDir, { recursive: true });
    fs.writeFileSync(absPath, content, 'utf8');
  } catch (err) {
    // Disk full / permission denied / other I/O failure — degrade to inline
    // so the caller still ships the full payload (just bigger IPC line).
    // Log once to stderr so operators can investigate without spamming.
    process.stderr.write(`[spill-to-file] degrade to inline (${err?.code || 'unknown'}): ${err?.message || String(err)}\n`);
    return { inline: content, spilledPath: null };
  }

  // Always emit POSIX-style relative path so it round-trips identically across
  // platforms (Java consumers on Windows / macOS / Linux all see forward slashes).
  // path.posix.join is fine here since none of the components contain backslashes.
  const relPath = path.posix.join('.claude', 'pair', pairId, subdir, filename);
  return { inline: null, spilledPath: relPath };
}
