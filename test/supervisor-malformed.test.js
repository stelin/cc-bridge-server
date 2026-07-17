/**
 * L1 self-heal regression tests (2026-06-26).
 *
 * Covers the "supervisor resume → malformed/truncated closing tool call →
 * silent wedge" failure: the SDK injects an error tool_result like
 *   "Your tool call was malformed and could not be parsed. Please retry."
 * when a closing tool's input JSON is unparseable (typically a
 * dispatch_to_main_ai whose prompt truncated mid-JSON). Previously this was
 * dropped on the floor and the turn downgraded to a bare `wait` — a permanent
 * wedge. These tests pin:
 *   - isMalformedToolResult: detects the SDK signal WITHOUT false-positiving on
 *     ordinary failing tools (a Read ENOENT must NOT trip it).
 *   - buildActionWrapper: a malformed downgrade carries the distinct
 *     parseError='tool_malformed' (so Java can re-prompt instead of treating it
 *     as a hallucinated wait), while a plain no-tool turn keeps 'no_tool_use'.
 *
 * Run via: `npm test` (uses node --test).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    isMalformedToolResult,
    buildActionWrapper,
} from '../ai-bridge/channels/supervisor-channel.js';

test('isMalformedToolResult: detects SDK "could not be parsed" error (string content)', () => {
    const block = {
        type: 'tool_result',
        is_error: true,
        content: 'Your tool call was malformed and could not be parsed. Please retry.',
    };
    assert.equal(isMalformedToolResult(block), true);
});

test('isMalformedToolResult: detects "was malformed" in array content blocks', () => {
    const block = {
        type: 'tool_result',
        is_error: true,
        content: [{ type: 'text', text: 'The tool input was malformed (invalid JSON).' }],
    };
    assert.equal(isMalformedToolResult(block), true);
});

test('isMalformedToolResult: does NOT trip on a normal failing tool (Read ENOENT)', () => {
    const block = {
        type: 'tool_result',
        is_error: true,
        content: 'Error: ENOENT: no such file or directory, open "/tmp/nope.go"',
    };
    assert.equal(isMalformedToolResult(block), false);
});

test('isMalformedToolResult: ignores non-error tool_results and non-blocks', () => {
    assert.equal(isMalformedToolResult({ type: 'tool_result', is_error: false, content: 'ok' }), false);
    assert.equal(isMalformedToolResult({ type: 'tool_result', content: 'no is_error field' }), false);
    assert.equal(isMalformedToolResult(null), false);
    assert.equal(isMalformedToolResult(undefined), false);
});

test('buildActionWrapper: malformed downgrade → parseError=tool_malformed', () => {
    const w = buildActionWrapper({
        pairId: 'p1',
        supervisorId: 's1',
        assistantText: 'I will dispatch the next step…',
        reasoningText: '',
        capturedAction: null,
        toolMalformed: true,
    });
    assert.equal(w.parseError, 'tool_malformed');
    assert.equal(w.action.action, 'wait');
    assert.match(w.action.reason, /malformed|could not be parsed|truncated/i);
});

test('buildActionWrapper: plain no-tool turn keeps parseError=no_tool_use', () => {
    const w = buildActionWrapper({
        pairId: 'p1',
        supervisorId: 's1',
        assistantText: 'just some prose, no tool',
        reasoningText: '',
        capturedAction: null,
        toolMalformed: false,
    });
    assert.equal(w.parseError, 'no_tool_use');
    assert.equal(w.action.action, 'wait');
});

test('buildActionWrapper: a captured action is passed through with no parseError', () => {
    const captured = { action: 'dispatch_to_main_ai', reason: 'go', payload: { directiveId: 'd1', prompt: 'do step 6' } };
    const w = buildActionWrapper({
        pairId: 'p1',
        supervisorId: 's1',
        assistantText: '',
        reasoningText: '',
        capturedAction: captured,
        toolMalformed: false,
    });
    assert.equal(w.parseError, null);
    assert.equal(w.action.action, 'dispatch_to_main_ai');
    assert.equal(w.directiveId, 'd1');
});
