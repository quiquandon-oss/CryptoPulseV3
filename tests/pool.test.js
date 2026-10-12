// Standalone vs pool contribution (api/pool.js).
// ALL records and protocols in this file are TEST DATA for software behaviour only --
// labelled "TEST" and never scientific evaluation evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  standaloneView, poolView, normalizePoolRecord, decideUnderProtocol, summarizePool, eligibilityText,
  APPROVED_POOL_PROTOCOLS, POOL_STATE_LABEL,
} from '../api/pool.js';
import { normalizeRegistryEntry } from '../api/normalize.js';

const SHA = 'a'.repeat(64), SHA2 = 'b'.repeat(64);
// TEST protocol: injected into the functions; the real APPROVED_POOL_PROTOCOLS is empty.
const TEST_PROTOCOLS = { 'TEST-protocol': { sha256: SHA, pool_id: 'TEST-pool', pool_version: 'v1', metric: 'accuracy', higher_is_better: true,
  min_effect: 0.01, equivalence_margin: 0.01, min_sample: 30, ci_level: 0.95 } };

const standalone = (o = {}) => ({ record_id: 'TEST-s1', evaluation_version: 'TEST-v1', spec_ref: 'TEST spec', evaluation_status: 'EVALUATED',
  scientific_outcome: 'NOT_SUPPORTED', reason: 'TEST DATA', evidence_refs: ['test://standalone'], recorded_ts: 1, recorded_by: 'TEST', ...o });
const conclusive = (state, base, cand, lo, hi, o = {}) => ({ record_id: `TEST-p-${state}`, pool_state: state, reason: 'TEST DATA',
  pool: { pool_id: 'TEST-pool', version: 'v1' }, protocol: { protocol_id: 'TEST-protocol', sha256: SHA }, evaluator_version: 'TEST-eval-1',
  window: { start_ts: 1000, end_ts: 2000 }, out_of_sample: true, eligible: { baseline_n: 60, candidate_n: 60, overlap_n: 60 },
  baseline_metrics: { accuracy: base }, candidate_metrics: { accuracy: cand }, incremental: { accuracy: cand - base },
  uncertainty: { ci: { lo, hi }, level: 0.95 }, evidence_refs: ['test://pool'], evidence_sha256: SHA2, recorded_ts: 5, recorded_by: 'TEST', ...o });
const candidate = (o = {}) => ({ record_id: 'TEST-c', pool_state: 'CANDIDATE', reason: 'TEST DATA designation', recorded_ts: 2, recorded_by: 'TEST', ...o });

const VALID = conclusive('VALIDATED_INCREMENTAL_VALUE', 0.50, 0.56, 0.03, 0.09);
const REDUNDANT = conclusive('REDUNDANT', 0.50, 0.502, -0.005, 0.009);
const DEGRADING = conclusive('DEGRADING', 0.50, 0.44, -0.09, -0.03);
const INCONCL = conclusive('INCONCLUSIVE', 0.50, 0.51, -0.04, 0.06);

test('1. a standalone failure stays a standalone failure when marked as a pool candidate', () => {
  const e = { experiment_id: 'TEST-1', standalone_evaluations: [standalone()], pool_evaluations: [candidate()] };
  assert.equal(standaloneView(e).outcome, 'NOT_SUPPORTED');
  assert.equal(standaloneView(e).status, 'EVALUATED');
  assert.equal(poolView(e, TEST_PROTOCOLS).state, 'CANDIDATE');
  assert.equal(standaloneView({ ...e, pool_evaluations: [] }).outcome, 'NOT_SUPPORTED');
});

test('2. candidate is never validated incremental value', () => {
  const v = poolView({ pool_evaluations: [candidate()] }, TEST_PROTOCOLS);
  assert.equal(v.state, 'CANDIDATE');
  assert.notEqual(v.state, 'VALIDATED_INCREMENTAL_VALUE');
  assert.match(POOL_STATE_LABEL.CANDIDATE, /not evidence of value/);
  assert.match(eligibilityText('CANDIDATE'), /designation only/);
  const s = summarizePool([{ experiment_id: 'A', pool_evaluations: [candidate()] }], TEST_PROTOCOLS);
  assert.equal(s.counts.CANDIDATE, 1);
  assert.equal(s.counts.VALIDATED_INCREMENTAL_VALUE, 0);
});

test('3. a standalone success does not imply pool success', () => {
  const e = { standalone_evaluations: [standalone({ scientific_outcome: 'SUPPORTED' })] };
  assert.equal(standaloneView(e).outcome, 'SUPPORTED');
  assert.equal(poolView(e, TEST_PROTOCOLS).state, 'NOT_REPORTED');
  assert.equal(poolView({ ...e, pool_evaluations: [] }, TEST_PROTOCOLS).state, 'NOT_TESTED');
});

test('4. pool can conclude validated / redundant / degrading / inconclusive / blocked without rewriting standalone', () => {
  const s = standalone({ scientific_outcome: 'NOT_SUPPORTED' });
  for (const [rec, want] of [[VALID, 'VALIDATED_INCREMENTAL_VALUE'], [REDUNDANT, 'REDUNDANT'], [DEGRADING, 'DEGRADING'], [INCONCL, 'INCONCLUSIVE'],
    [{ ...candidate(), pool_state: 'BLOCKED', reason: 'TEST blocked: dependency missing' }, 'BLOCKED']]) {
    const e = { standalone_evaluations: [s], pool_evaluations: [candidate(), rec] };
    const before = JSON.stringify(e.standalone_evaluations);
    assert.equal(poolView(e, TEST_PROTOCOLS).state, want, want);
    assert.equal(standaloneView(e).outcome, 'NOT_SUPPORTED', want);
    assert.equal(JSON.stringify(e.standalone_evaluations), before, 'input not mutated');
  }
});

test('5. missing evidence never produces a validated conclusion', () => {
  for (const drop of ['evidence_sha256', 'evidence_refs', 'evaluator_version', 'uncertainty', 'baseline_metrics', 'candidate_metrics', 'protocol', 'window', 'eligible']) {
    const r = { ...VALID }; delete r[drop];
    const v = poolView({ pool_evaluations: [r] }, TEST_PROTOCOLS);
    assert.equal(v.state, 'BLOCKED', drop);
    assert.equal(v.current.claimed_state, 'VALIDATED_INCREMENTAL_VALUE', drop);
  }
  // With the real (empty) approved-protocol list nothing can be conclusive at all.
  assert.deepEqual(Object.keys(APPROVED_POOL_PROTOCOLS), []);
  assert.equal(poolView({ pool_evaluations: [VALID] }).state, 'BLOCKED');
  assert.match(poolView({ pool_evaluations: [VALID] }).current.reason, /not an approved pool protocol/);
});

test('6. invalid counts, mismatched windows, missing provenance and incompatible pool versions are blocked or rejected', () => {
  const cases = {
    'invalid count': { eligible: { baseline_n: -1, candidate_n: 60, overlap_n: 60 } },
    'fractional count': { eligible: { baseline_n: 60.5, candidate_n: 60, overlap_n: 60 } },
    'overlap too large': { eligible: { baseline_n: 60, candidate_n: 60, overlap_n: 61 } },
    'below protocol min sample': { eligible: { baseline_n: 20, candidate_n: 20, overlap_n: 20 } },
    'unquantified composition change': { eligible: { baseline_n: 60, candidate_n: 55, overlap_n: 55 } },
    'inverted window': { window: { start_ts: 2000, end_ts: 1000 } },
    'not out of sample': { out_of_sample: false },
    'incompatible pool version': { pool: { pool_id: 'TEST-pool', version: 'v2' } },
    'wrong pool': { pool: { pool_id: 'OTHER', version: 'v1' } },
    'protocol hash mismatch': { protocol: { protocol_id: 'TEST-protocol', sha256: SHA2 } },
    'unknown protocol': { protocol: { protocol_id: 'nope', sha256: SHA } },
  };
  for (const [name, o] of Object.entries(cases)) {
    const v = poolView({ pool_evaluations: [{ ...VALID, ...o }] }, TEST_PROTOCOLS);
    assert.equal(v.state, 'BLOCKED', name);
  }
  // A quantified composition change is acceptable.
  assert.equal(poolView({ pool_evaluations: [{ ...VALID, eligible: { baseline_n: 60, candidate_n: 55, overlap_n: 55, composition_change: 'TEST: 5 rows lack the component' } }] }, TEST_PROTOCOLS).state, 'VALIDATED_INCREMENTAL_VALUE');
  // Missing provenance: rejected outright (kept in `rejected`, never current).
  const noProv = { ...VALID }; delete noProv.recorded_by;
  const v = poolView({ pool_evaluations: [candidate(), noProv] }, TEST_PROTOCOLS);
  assert.equal(v.state, 'CANDIDATE');
  assert.equal(v.rejected.length, 1);
  assert.match(v.rejected[0].reason, /provenance/);
  // Unknown state and missing reason become explicit BLOCKED entries.
  assert.equal(normalizePoolRecord({ ...candidate(), pool_state: 'USEFUL' }).record.pool_state, 'BLOCKED');
  assert.equal(normalizePoolRecord({ ...candidate(), reason: '' }).record.pool_state, 'BLOCKED');
  // Standalone: invalid sample count / EVALUATED without evidence are rejected.
  assert.equal(standaloneView({ standalone_evaluations: [standalone({ sample: { count: -3 } })] }).rejected.length, 1);
  assert.equal(standaloneView({ standalone_evaluations: [standalone({ evidence_refs: [] })] }).status, 'NOT_RUN');
  assert.equal(standaloneView({ standalone_evaluations: [standalone({ evaluation_status: 'BLOCKED', scientific_outcome: 'SUPPORTED' })] }).rejected.length, 1);
});

test('7. baseline and candidate are compared under the protocol rule; inconsistent claims are blocked', () => {
  const p = TEST_PROTOCOLS['TEST-protocol'];
  assert.equal(decideUnderProtocol(p, 0.5, 0.56, { lo: 0.03, hi: 0.09 }).state, 'VALIDATED_INCREMENTAL_VALUE');
  assert.equal(decideUnderProtocol(p, 0.5, 0.44, { lo: -0.09, hi: -0.03 }).state, 'DEGRADING');
  assert.equal(decideUnderProtocol(p, 0.5, 0.502, { lo: -0.005, hi: 0.009 }).state, 'REDUNDANT');
  assert.equal(decideUnderProtocol(p, 0.5, 0.51, { lo: -0.04, hi: 0.06 }).state, 'INCONCLUSIVE');
  // Lower-is-better metric: a drop in error is an improvement.
  const q = { ...p, higher_is_better: false };
  assert.equal(decideUnderProtocol(q, 1.0, 0.9, { lo: -0.15, hi: -0.05 }).state, 'VALIDATED_INCREMENTAL_VALUE');
  // A claim the rule does not give is blocked, keeping the claim.
  const wrong = { ...INCONCL, pool_state: 'VALIDATED_INCREMENTAL_VALUE' };
  const v = poolView({ pool_evaluations: [wrong] }, TEST_PROTOCOLS);
  assert.equal(v.state, 'BLOCKED');
  assert.match(v.current.reason, /rule gives INCONCLUSIVE/);
  // Incremental that is not candidate - baseline, and a CI not containing the difference, are blocked.
  assert.equal(poolView({ pool_evaluations: [{ ...VALID, incremental: { accuracy: 0.2 } }] }, TEST_PROTOCOLS).state, 'BLOCKED');
  assert.equal(poolView({ pool_evaluations: [{ ...VALID, uncertainty: { ci: { lo: 0.07, hi: 0.09 } } }] }, TEST_PROTOCOLS).state, 'BLOCKED');
  // Only the protocol's metric counts, not an attractive other one.
  assert.equal(poolView({ pool_evaluations: [{ ...VALID, baseline_metrics: { sharpe: 1 }, candidate_metrics: { sharpe: 2 } }] }, TEST_PROTOCOLS).state, 'BLOCKED');
});

test('8. historical evaluations stay available and ordered; a later record does not erase an earlier one', () => {
  const e = { standalone_evaluations: [standalone({ record_id: 'TEST-s2', recorded_ts: 9, evaluation_status: 'BLOCKED', scientific_outcome: null }), standalone()],
    pool_evaluations: [VALID, candidate(), { ...DEGRADING, record_id: 'TEST-p-late', recorded_ts: 50 }] };
  const s = standaloneView(e);
  assert.deepEqual(s.history.map(h => h.record_id), ['TEST-s1', 'TEST-s2']);
  assert.equal(s.status, 'BLOCKED');
  const p = poolView(e, TEST_PROTOCOLS);
  assert.deepEqual(p.history.map(h => h.record_id), ['TEST-c', 'TEST-p-VALIDATED_INCREMENTAL_VALUE', 'TEST-p-late']);
  assert.equal(p.state, 'DEGRADING');
  assert.ok(p.history.every(h => h.recorded_by && Number.isFinite(h.recorded_ts)));
});

test('9. old registry records and payloads stay compatible', () => {
  const old = { experiment_id: 'EXP-002', title: 't', research_question: 'q', purpose: 'p', experiment_type: 'X', expected_result: 'e',
    success_criterion: 's', status: 'ACCUMULATING', baseline: 'b', next_action: 'n', conclusion: 'Legacy text conclusion' };
  const n = normalizeRegistryEntry(old);
  assert.equal(n.available, true);
  assert.equal('standalone_evaluations' in n, false);
  assert.equal('pool_evaluations' in n, false);
  assert.equal(standaloneView(n).status, 'NOT_REPORTED');
  assert.equal(standaloneView(n).legacy_conclusion, 'Legacy text conclusion');
  assert.equal(poolView(n).state, 'NOT_REPORTED');
  const nw = normalizeRegistryEntry({ ...old, standalone_evaluations: [standalone()], pool_evaluations: [candidate()], pool_component: { component_id: 'TEST' } });
  assert.equal(nw.standalone_evaluations.length, 1);
  assert.equal(nw.pool_component.component_id, 'TEST');
  // Malformed dimension fields are dropped, never coerced.
  const bad = normalizeRegistryEntry({ ...old, standalone_evaluations: 'x', pool_evaluations: {}, pool_component: [] });
  assert.equal(standaloneView(bad).status, 'NOT_REPORTED');
  assert.equal(poolView(bad).state, 'NOT_REPORTED');
  // Malformed pool evidence cannot overwrite valid standalone evidence.
  assert.equal(standaloneView({ ...nw, pool_evaluations: [null, 42, { pool_state: 'VALIDATED_INCREMENTAL_VALUE' }] }).outcome, 'NOT_SUPPORTED');
});

test('summarizePool keeps candidates apart and counts rejected claims', () => {
  const s = summarizePool([
    { experiment_id: 'A', pool_evaluations: [candidate()] },
    { experiment_id: 'B', pool_evaluations: [VALID] },               // real protocol list: rejected -> BLOCKED
    { experiment_id: 'C', pool_evaluations: [] },
    { experiment_id: 'D' },
  ]);
  assert.deepEqual([s.counts.CANDIDATE, s.counts.BLOCKED, s.counts.NOT_TESTED, s.counts.NOT_REPORTED, s.counts.VALIDATED_INCREMENTAL_VALUE], [1, 1, 1, 1, 0]);
  assert.equal(s.rejected, 1);
  assert.equal(s.approvedProtocols, 0);
});
