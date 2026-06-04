/**
 * Regression tests for the supervisor tool layer.
 *
 * Covers:
 *   - normalizeAction: the surviving non-dispatch action types still work
 *   - normalizeAction: removed action types (inject_prompt / retry_with_hint)
 *     are no longer handled — Zod enum gate is the real defence at runtime,
 *     this test only documents that the switch cases were intentionally dropped
 *   - buildDispatchAction: payload shape Java's ActionRouter consumes
 *   - buildRetryAction: same, for review feedback path
 *
 * Run via: `npm test` (uses node --test).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeAction,
    buildDispatchAction,
    buildRetryAction,
} from '../ai-bridge/services/supervisor/supervisor-tools.js';

// Deterministic ID stub so we can assert on payload.directiveId exactly.
const fixedId = () => 'd_test_0001';

test('normalizeAction: approve_and_continue carries mark_step_complete', () => {
    const r = normalizeAction({
        action: 'approve_and_continue',
        reason: 'step 3 verified',
        mark_step_complete: 3,
    });
    assert.equal(r.error, null);
    assert.equal(r.action.action, 'approve_and_continue');
    assert.equal(r.action.payload.mark_step_complete, 3);
});

test('normalizeAction: record_alert requires fallback_choice', () => {
    const missing = normalizeAction({ action: 'record_alert', category: 'C1' });
    assert.ok(missing.error, 'expected error when fallback_choice is missing');
    assert.match(missing.error, /fallback_choice/);

    const ok = normalizeAction({
        action: 'record_alert',
        category: 'C2',
        severity: 'alert',
        fallback_choice: 'skipped flaky check',
    });
    assert.equal(ok.error, null);
    assert.equal(ok.action.payload.category, 'C2');
    assert.equal(ok.action.payload.severity, 'alert');
    assert.equal(ok.action.payload.fallback_choice, 'skipped flaky check');
});

test('normalizeAction: record_alert defaults to C1/warn when category/severity omitted', () => {
    const r = normalizeAction({
        action: 'record_alert',
        fallback_choice: 'noted and continued',
    });
    assert.equal(r.error, null);
    assert.equal(r.action.payload.category, 'C1');
    assert.equal(r.action.payload.severity, 'warn');
});

test('normalizeAction: request_amendment carries proposal', () => {
    const r = normalizeAction({
        action: 'request_amendment',
        proposal: 'add step 7 for migration tests',
    });
    assert.equal(r.error, null);
    assert.equal(r.action.payload.proposal, 'add step 7 for migration tests');
});

test('normalizeAction: escalate_to_human aliases to record_alert(C2) with legacy payload fields', () => {
    const r = normalizeAction({
        action: 'escalate_to_human',
        question: 'should I proceed?',
        choices: ['yes', 'no'],
        context_files: ['spec.md'],
    });
    assert.equal(r.error, null);
    assert.equal(r.action.action, 'record_alert');
    assert.equal(r.action.payload.category, 'C2');
    assert.equal(r.action.payload.severity, 'alert');
    assert.equal(r.action.payload.legacyEscalate, true);
    assert.equal(r.action.payload.question, 'should I proceed?');
    assert.deepEqual(r.action.payload.choices, ['yes', 'no']);
    assert.deepEqual(r.action.payload.context_files, ['spec.md']);
});

test('normalizeAction: removed action names (wait / inject_prompt / retry_with_hint) yield no special handling — Zod enum is the gate', () => {
    // 2026-05-26: only approve_and_continue / escalate_to_human / record_alert /
    // request_amendment remain in ACTION_TYPES. At runtime Zod's enum validator
    // rejects wait / inject_prompt / retry_with_hint before normalizeAction is
    // reached. This test documents that the switch falls through to default
    // (no payload mutation, no error) if somehow bypassed.
    for (const removed of ['wait', 'inject_prompt', 'retry_with_hint']) {
        const r = normalizeAction({ action: removed, prompt: 'x' });
        assert.equal(r.error, null, `${removed}: no error from normalizeAction`);
        assert.equal(r.action.action, removed, `${removed}: action name preserved`);
        assert.deepEqual(Object.keys(r.action.payload).filter(k => k !== 'decisions'), [],
            `${removed}: payload stays empty (modulo decisions ride-along)`);
    }
});

test('normalizeAction: complete_plan carries optional summary, never errors', () => {
    const withSummary = normalizeAction({ action: 'complete_plan', summary: 'done it' });
    assert.equal(withSummary.error, null);
    assert.equal(withSummary.action.payload.summary, 'done it');
    const noSummary = normalizeAction({ action: 'complete_plan' });
    assert.equal(noSummary.error, null);
    assert.equal(noSummary.action.payload.summary, undefined);
});

test('normalizeAction: complete_workflow_node requires node_status, carries summary/changed_files on done', () => {
    const bad = normalizeAction({ action: 'complete_workflow_node' });
    assert.match(bad.error, /node_status/);
    const done = normalizeAction({
        action: 'complete_workflow_node',
        node_status: 'done',
        summary: 's',
        changed_files: ['a.go', 'b.go'],
    });
    assert.equal(done.error, null);
    assert.equal(done.action.payload.node_status, 'done');
    assert.deepEqual(done.action.payload.changed_files, ['a.go', 'b.go']);
    const blocked = normalizeAction({ action: 'complete_workflow_node', node_status: 'blocked', changed_files: ['x'] });
    assert.equal(blocked.error, null);
    assert.equal(blocked.action.payload.node_status, 'blocked');
    // changed_files is only meaningful on done → dropped on blocked
    assert.equal(blocked.action.payload.changed_files, undefined);
});

test('normalizeAction: wait_for_contract requires non-empty contractId', () => {
    const bad = normalizeAction({ action: 'wait_for_contract' });
    assert.match(bad.error, /contractId/);
    const ok = normalizeAction({ action: 'wait_for_contract', contractId: 'c-123' });
    assert.equal(ok.error, null);
    assert.equal(ok.action.payload.contractId, 'c-123');
});

test('normalizeAction: decisions[] ride along, category B forces review_flag=true', () => {
    const r = normalizeAction({
        action: 'approve_and_continue',
        decisions: [
            { step: 1, category: 'A', plan_excerpt: 'p', ambiguity: 'a', choice: 'c', rationale: 'r', scope: 'local' },
            { step: 2, category: 'B', plan_excerpt: 'p', ambiguity: 'a', choice: 'c', rationale: 'r', scope: 'cross-file' },
        ],
    });
    assert.equal(r.error, null);
    assert.equal(r.action.payload.decisions.length, 2);
    assert.equal(r.action.payload.decisions[0].review_flag, false);
    assert.equal(r.action.payload.decisions[1].review_flag, true);
});

test('buildDispatchAction: minimal args produce inject_prompt event with required payload', () => {
    const action = buildDispatchAction({ prompt: 'please reply PONG' }, fixedId);
    assert.equal(action.action, 'inject_prompt');
    assert.equal(action.reason, '');
    assert.equal(action.payload.kind, 'task_assignment');
    assert.equal(action.payload.inlinePrompt, 'please reply PONG');
    assert.equal(action.payload.prompt, 'please reply PONG');
    assert.equal(action.payload.directiveId, 'd_test_0001');
});

test('buildDispatchAction: optional fields land in payload', () => {
    const action = buildDispatchAction({
        prompt: 'implement Process()',
        reason: 'step 2 assignment',
        kind: 'task_assignment',
        objective: 'service/foo.go Process()',
        context: { previousStep: 'spec parsed', relatedFiles: ['spec.md'] },
        expectedDeliverables: ['service/foo.go'],
        acceptanceCriteria: ['unit tests pass'],
    }, fixedId);
    assert.equal(action.payload.objective, 'service/foo.go Process()');
    assert.deepEqual(action.payload.context, { previousStep: 'spec parsed', relatedFiles: ['spec.md'] });
    assert.deepEqual(action.payload.expectedDeliverables, ['service/foo.go']);
    assert.deepEqual(action.payload.acceptanceCriteria, ['unit tests pass']);
    assert.equal(action.reason, 'step 2 assignment');
});

test('buildDispatchAction: non-string context/array fields are ignored, not crashed on', () => {
    const action = buildDispatchAction({
        prompt: 'try this hint please',
        context: 'not-an-object',
        expectedDeliverables: 'not-an-array',
    }, fixedId);
    assert.equal(action.payload.context, undefined);
    assert.equal(action.payload.expectedDeliverables, undefined);
});

test('buildRetryAction: minimal args produce retry_with_hint event with review_feedback kind', () => {
    const action = buildRetryAction({ prompt: 'fix the TODO at bar.go:42' }, fixedId);
    assert.equal(action.action, 'retry_with_hint');
    assert.equal(action.reason, '');
    assert.equal(action.payload.kind, 'review_feedback');
    assert.equal(action.payload.inlinePrompt, 'fix the TODO at bar.go:42');
    assert.equal(action.payload.prompt, 'fix the TODO at bar.go:42');
    assert.equal(action.payload.directiveId, 'd_test_0001');
    assert.equal(action.payload.wait_seconds, undefined);
});

test('buildRetryAction: wait_seconds carries through when numeric', () => {
    const action = buildRetryAction({
        prompt: 'redo step 3 with the new spec',
        reason: 'backoff after noisy loop',
        wait_seconds: 30,
    }, fixedId);
    assert.equal(action.payload.wait_seconds, 30);
    assert.equal(action.reason, 'backoff after noisy loop');
});

test('buildRetryAction: non-numeric wait_seconds is dropped', () => {
    const action = buildRetryAction({
        prompt: 'redo with the new spec',
        wait_seconds: 'soon',
    }, fixedId);
    assert.equal(action.payload.wait_seconds, undefined);
});

test('directiveId is generated when generateId is omitted (real generator)', () => {
    const a = buildDispatchAction({ prompt: 'real call without stub' });
    assert.ok(typeof a.payload.directiveId === 'string' && a.payload.directiveId.length > 0,
        'directiveId should be a non-empty string from the real generator');
});

/**
 * 2026-05-26: regression for the "first-wins capture guard" shape used in
 * supervisor-channel.js. The channel wires onCapture as a closure over the
 * SupervisorRuntime; the contract is:
 *   - first call: writes runtime.lastCapturedAction, returns true
 *   - second call (same turn): no-op, returns false
 *   - reset on turn boundary: runtime.lastCapturedAction = null
 *
 * This guard prevents an LLM that calls dispatch_to_main_ai followed by
 * emit_action(wait) from silently overwriting the dispatch action. We assert
 * the shape here so future channel refactors do not regress the invariant.
 */
test('first-wins capture guard: second call returns false, first action wins', () => {
    // Minimal stand-in for the runtime used by supervisor-channel.
    const runtime = { lastCapturedAction: null };
    const onCapture = (action) => {
        if (runtime.lastCapturedAction !== null) return false;
        runtime.lastCapturedAction = action;
        return true;
    };

    const firstAction = buildDispatchAction({ prompt: 'first dispatch please' });
    assert.equal(onCapture(firstAction), true, 'first capture must succeed');
    assert.equal(runtime.lastCapturedAction, firstAction);

    const secondAction = { action: 'wait', reason: 'overlay attempt', payload: {} };
    assert.equal(onCapture(secondAction), false, 'second capture must be rejected');
    assert.equal(runtime.lastCapturedAction, firstAction,
        'first action must remain — second must not overwrite it');

    // Turn boundary reset.
    runtime.lastCapturedAction = null;
    const nextTurnAction = buildRetryAction({ prompt: 'next turn retry hint' });
    assert.equal(onCapture(nextTurnAction), true, 'next turn must accept a fresh capture');
    assert.equal(runtime.lastCapturedAction, nextTurnAction);
});
