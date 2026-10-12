// UI: standalone and pool contribution rendered as two independent dimensions.
// All registry rows here are TEST DATA (ids prefixed TEST- or labelled "TEST") for software behaviour only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, renderExperimentCard, renderExperiments, renderOverview, renderFactors, renderPoolOverview, refLink } from '../ui/research-dashboard.js';

const NOW = Date.UTC(2026, 9, 12, 12);
const SHA = 'a'.repeat(64), SHA2 = 'b'.repeat(64);
const TEST_PROTOCOLS = { 'TEST-protocol': { sha256: SHA, pool_id: 'TEST-pool', pool_version: 'v1', metric: 'accuracy', higher_is_better: true,
  min_effect: 0.01, equivalence_margin: 0.01, min_sample: 30 } };
const base = (o = {}) => ({ experiment_id: 'TEST-EXP', title: 'TEST experiment', research_question: 'TEST question?', baseline: 'TEST baseline',
  next_action: 'TEST next', status: 'ACCUMULATING', success_criterion: 'TEST frozen criterion', ...o });
const sa = (o = {}) => ({ record_id: 'TEST-s', evaluation_version: 'TEST-v1', spec_ref: 'TEST spec', evaluation_status: 'EVALUATED',
  scientific_outcome: 'NOT_SUPPORTED', reason: 'TEST standalone reason.', evidence_refs: ['test://e'], recorded_ts: NOW - 86400000, recorded_by: 'TEST', ...o });
const cand = { record_id: 'TEST-c', pool_state: 'CANDIDATE', reason: 'TEST designation.', recorded_ts: NOW - 3600000, recorded_by: 'TEST' };
const conclusive = (state, b, c, lo, hi) => ({ record_id: `TEST-${state}`, pool_state: state, reason: `TEST ${state}.`, pool: { pool_id: 'TEST-pool', version: 'v1' },
  protocol: { protocol_id: 'TEST-protocol', sha256: SHA }, evaluator_version: 'TEST-eval', window: { start_ts: NOW - 9e8, end_ts: NOW - 1e8 }, out_of_sample: true,
  eligible: { baseline_n: 60, candidate_n: 60, overlap_n: 60 }, baseline_metrics: { accuracy: b }, candidate_metrics: { accuracy: c },
  uncertainty: { ci: { lo, hi } }, evidence_refs: ['test://pool'], evidence_sha256: SHA2, recorded_ts: NOW - 1000, recorded_by: 'TEST' });

const dims = (html) => {
  const s = html.indexOf('aria-label="Standalone evaluation"'), p = html.indexOf('aria-label="Pool contribution"');
  assert.ok(s > 0 && p > s, 'both dimension panels present, standalone first');
  return { standalone: html.slice(s, p), pool: html.slice(p, html.indexOf('</section>', p)) };
};

test('10. card and detail view show the two dimensions independently (standalone failure + pool candidate)', () => {
  const html = renderExperimentCard(base({ standalone_evaluations: [sa()], pool_evaluations: [cand] }));
  const d = dims(html);
  assert.match(d.standalone, /Evaluated/);
  assert.match(d.standalone, /Not supported/);
  assert.doesNotMatch(d.standalone, /Candidate/);
  assert.match(d.pool, /Candidate — not evidence of value/);
  assert.doesNotMatch(d.pool, /Not supported|Validated/);
  for (const t of ['Standalone evaluation', 'Pool contribution', 'History &amp; governance']) assert.match(html, new RegExp(`<summary>${t}</summary>`));
  assert.match(html, /There is no run action/);
  assert.doesNotMatch(html, /<button/); // no evaluation can be launched from a card
});

test('standalone success with pool not tested', () => {
  const d = dims(renderExperimentCard(base({ standalone_evaluations: [sa({ scientific_outcome: 'SUPPORTED' })], pool_evaluations: [] })));
  assert.match(d.standalone, /Supported/);
  assert.match(d.pool, /Not tested/);
  assert.doesNotMatch(d.pool, /Validated/);
});

test('no standalone evaluation, and an old registry payload, read as not reported', () => {
  const d = dims(renderExperimentCard(base()));
  assert.match(d.standalone, /Not reported/);
  assert.match(d.pool, /Not reported/);
  const legacy = dims(renderExperimentCard(base({ conclusion: 'TEST legacy text.' })));
  assert.match(legacy.standalone, /Text assessment only: TEST legacy text\./);
});

test('validated / redundant / degrading / inconclusive / blocked render as such, standalone untouched', () => {
  const cases = [[conclusive('VALIDATED_INCREMENTAL_VALUE', 0.5, 0.56, 0.03, 0.09), /Validated incremental value/],
    [conclusive('REDUNDANT', 0.5, 0.502, -0.005, 0.009), /Redundant/], [conclusive('DEGRADING', 0.5, 0.44, -0.09, -0.03), /Degrading/],
    [conclusive('INCONCLUSIVE', 0.5, 0.51, -0.04, 0.06), /Inconclusive/], [{ ...cand, record_id: 'TEST-b', pool_state: 'BLOCKED', reason: 'TEST dependency missing.', recorded_ts: NOW - 10 }, /Blocked/]];
  for (const [rec, re] of cases) {
    const html = renderExperimentCard(base({ standalone_evaluations: [sa()], pool_evaluations: [cand, rec] }), { protocols: TEST_PROTOCOLS });
    const d = dims(html);
    assert.match(d.pool, re, rec.pool_state);
    assert.match(d.standalone, /Not supported/, rec.pool_state);
  }
  // Measured numbers appear only for measured states.
  const v = renderExperimentCard(base({ pool_evaluations: [conclusive('VALIDATED_INCREMENTAL_VALUE', 0.5, 0.56, 0.03, 0.09)] }), { protocols: TEST_PROTOCOLS });
  assert.match(v, /Measured under the cited protocol/);
  assert.match(v, /0\.56/);
  assert.doesNotMatch(renderExperimentCard(base({ pool_evaluations: [cand] })), /Measured under/);
});

test('missing or malformed evidence: a validated claim without an approved protocol renders as Blocked with the rejected claim', () => {
  const html = renderExperimentCard(base({ pool_evaluations: [conclusive('VALIDATED_INCREMENTAL_VALUE', 0.5, 0.56, 0.03, 0.09)] }));
  const d = dims(html);
  assert.match(d.pool, /status-error">Blocked</);
  assert.doesNotMatch(d.pool, /status-ok/);
  assert.match(d.pool, /Rejected Validated incremental value claim/);
  assert.match(html, /Rejected claim/);
  const bad = renderExperimentCard(base({ standalone_evaluations: [sa(), { evaluation_status: 'EVALUATED' }], pool_evaluations: [cand, 'junk'] }));
  assert.match(bad, /2 malformed records ignored/);
  assert.match(dims(bad).standalone, /Not supported/);
});

test('long ids, missing metrics and uncertainty render without breaking; text is escaped', () => {
  const long = 'TEST-' + 'X'.repeat(180);
  const html = renderExperimentCard(base({ experiment_id: long, title: '<script>alert(1)</script>', standalone_evaluations: [sa({ metrics: null, uncertainty: null })], pool_evaluations: [cand] }));
  assert.match(html, new RegExp(long));
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /Not measured/);
});

test('references: repo paths and GitHub URLs become links; anything else stays text', () => {
  assert.match(refLink('.ai/migrations/0010_research_experiment_registry.sql (EXP-004 success_criterion)'), /href="https:\/\/github\.com\/quiquandon-oss\/PulseWorkerV2\/blob\/main\/\.ai\/migrations\/0010/);
  assert.match(refLink('https://github.com/quiquandon-oss/PulseWorkerV2/actions/runs/1'), /<a /);
  assert.doesNotMatch(refLink('javascript:alert(1)'), /<a /);
  assert.doesNotMatch(refLink('../../etc/passwd'), /<a /);
  assert.doesNotMatch(refLink('https://evil.example/x'), /<a /);
});

// ---- Overview / Factors / states -------------------------------------------------------------

const ADAPT = { ok: true, mode: 'shadow', policy: { minFactor: 0.5, maxFactor: 1.5, maxStepPct: 10, maxSharePct: 20, minSamples: 30, minDeltaPts: 2, sampleSpacingHours: 6 },
  defaults: { fng: [2, 1] }, default_shares_pct: { fng: 100 }, latest: null, preview: { persisted: false, n_samples: 0, evidence: {} }, evaluation: null, history: [] };
const data = (registry) => ({ charts: {}, freshness: null, registry, v1Latest: null, adaptation: ADAPT, hloi: null });
const reg = (experiments, extra = {}) => ({ ok: true, experiments, ...extra });

test('11. Overview: candidates never counted as validated; empty registry, API failure and partial data', () => {
  const m = buildModel(data(reg([base({ experiment_id: 'TEST-A', standalone_evaluations: [sa({ evaluation_status: 'BLOCKED', scientific_outcome: null })], pool_evaluations: [cand], pool_component: { component_id: 'TEST comp', provenance: 'TEST prov' } }),
    base({ experiment_id: 'TEST-B', pool_evaluations: [] })], { evaluation_dimensions: { tables: 'NOT_PRESENT', error: null } })), NOW);
  const ov = renderPoolOverview(m);
  assert.match(ov, /0 validated/);
  assert.match(ov, /1 candidate \(not evidence of value\)/);
  assert.match(ov, /1 blocked · 0 incomplete · 0 not run · 1 not reported/);
  assert.match(ov, /incomplete evidence/);
  assert.match(ov, /No pool protocol is approved/);
  assert.match(ov, /migration 0022\) are not applied/);
  assert.match(renderOverview(m), /Standalone vs pool contribution/);
  // Factors lists the relationship without ranking or value.
  const f = renderFactors(m);
  assert.match(f, /Pool relationships/);
  assert.match(f, /TEST comp/);
  assert.match(f, /not ranked/);
  // Empty registry: the section is omitted, Experiments says so per group.
  const empty = buildModel(data(reg([])), NOW);
  assert.equal(renderPoolOverview(empty), '');
  assert.match(renderExperiments(empty), /No registered experiment in this group/);
  // API failure: explicit unavailable, no pool section.
  const failed = buildModel(data({ ok: false, error: 'HTTP 503' }), NOW);
  assert.match(renderExperiments(failed), /Unavailable.*HTTP 503/);
  assert.equal(renderPoolOverview(failed), '');
  // Partial: stored records unreadable -> stated, code records still shown.
  const partial = buildModel(data(reg([base({ pool_evaluations: [cand] })], { evaluation_dimensions: { tables: 'UNAVAILABLE', error: 'D1 timeout' } })), NOW);
  assert.match(renderPoolOverview(partial), /could not be read \(D1 timeout\)/);
  // Older registry (no dimension fields at all).
  const old = buildModel(data(reg([base()])), NOW);
  assert.match(renderPoolOverview(old), /does not report pool contribution yet/);
});

test('stale record: new data since the standalone record is stated, not silently re-scored', () => {
  const html = renderExperimentCard(base({ data_last_updated: NOW, standalone_evaluations: [sa({ evaluation_status: 'BLOCKED', scientific_outcome: null })] }));
  assert.match(html, /New data has arrived since this record/);
});
