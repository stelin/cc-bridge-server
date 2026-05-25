/**
 * Plan §9.1: SpillToFile contract.
 *
 * Verifies that:
 *   - Under threshold → inline (no file I/O).
 *   - Over threshold  → file written, returned path is POSIX-style + relative
 *     to the resolved project cwd.
 *   - PAIR_SPILL_THRESHOLD_BYTES env override actually changes the boundary.
 *   - mkdir/write failure degrades to inline mode without throwing.
 *
 * Each subtest uses a fresh tmp dir as IDEA_PROJECT_PATH and runs the spill
 * module in a child node process so the env override takes effect cleanly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SPILL_MODULE = path.resolve('ai-bridge/utils/spill-to-file.js');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spill-test-'));
}

function runSpill({ content, kind, pairId, name, env }) {
  const script = `
    import { maybeSpill } from ${JSON.stringify(SPILL_MODULE)};
    const out = maybeSpill(${JSON.stringify({ content, kind, pairId, name })});
    process.stdout.write(JSON.stringify(out));
  `;
  const stdout = execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: path.resolve('.'),
      env: { ...process.env, ...env },
      encoding: 'utf8',
    }
  );
  return JSON.parse(stdout);
}

test('under-threshold content stays inline', () => {
  const tmp = mkTmp();
  try {
    const result = runSpill({
      content: 'short payload',
      kind: 'directive',
      pairId: 'p1',
      name: 'dir_d_short',
      env: { IDEA_PROJECT_PATH: tmp },
    });
    assert.equal(result.inline, 'short payload');
    assert.equal(result.spilledPath, null);
    // No files written.
    assert.equal(fs.existsSync(path.join(tmp, '.claude')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('over-threshold content spills + returns posix relative path', () => {
  const tmp = mkTmp();
  try {
    const big = 'x'.repeat(10 * 1024); // 10KB, over default 8192
    const result = runSpill({
      content: big,
      kind: 'turn',
      pairId: 'p1',
      name: 'turn_007',
      env: { IDEA_PROJECT_PATH: tmp },
    });
    assert.equal(result.inline, null);
    // POSIX forward slashes regardless of OS.
    assert.equal(result.spilledPath, '.claude/pair/p1/main_turns/turn_007.md');
    // File actually exists with full content.
    const abs = path.join(tmp, '.claude', 'pair', 'p1', 'main_turns', 'turn_007.md');
    assert.equal(fs.existsSync(abs), true);
    assert.equal(fs.readFileSync(abs, 'utf8'), big);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('directive kind writes into directives/ subdir', () => {
  const tmp = mkTmp();
  try {
    const big = 'y'.repeat(10 * 1024);
    const result = runSpill({
      content: big,
      kind: 'directive',
      pairId: 'p2',
      name: 'dir_d_xyz',
      env: { IDEA_PROJECT_PATH: tmp },
    });
    assert.equal(result.spilledPath, '.claude/pair/p2/directives/dir_d_xyz.md');
    assert.ok(fs.existsSync(path.join(tmp, '.claude', 'pair', 'p2', 'directives', 'dir_d_xyz.md')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('PAIR_SPILL_THRESHOLD_BYTES env override changes the boundary', () => {
  const tmp = mkTmp();
  try {
    // Force a tiny threshold so even 100 bytes spills.
    const small = 'a'.repeat(100);
    const result = runSpill({
      content: small,
      kind: 'turn',
      pairId: 'p3',
      name: 'turn_001',
      env: {
        IDEA_PROJECT_PATH: tmp,
        PAIR_SPILL_THRESHOLD_BYTES: '32',
      },
    });
    assert.equal(result.inline, null);
    assert.equal(result.spilledPath, '.claude/pair/p3/main_turns/turn_001.md');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('write failure degrades to inline without throwing', () => {
  // Point IDEA_PROJECT_PATH at a file (not a directory) so mkdirSync fails.
  const tmp = mkTmp();
  const blockingFile = path.join(tmp, 'blocking');
  fs.writeFileSync(blockingFile, 'i am a file, not a dir');
  try {
    const big = 'z'.repeat(10 * 1024);
    const result = runSpill({
      content: big,
      kind: 'turn',
      pairId: 'p4',
      name: 'turn_fail',
      env: { IDEA_PROJECT_PATH: blockingFile },
    });
    // Degraded — we get the full content back inline, not an exception.
    assert.equal(result.inline, big);
    assert.equal(result.spilledPath, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('non-string content returns empty inline without spilling', () => {
  const tmp = mkTmp();
  try {
    const result = runSpill({
      content: null,
      kind: 'turn',
      pairId: 'p5',
      name: 'turn_null',
      env: { IDEA_PROJECT_PATH: tmp },
    });
    assert.equal(result.inline, '');
    assert.equal(result.spilledPath, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
