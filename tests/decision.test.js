import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decisionView } from '../api/decision.js';
import { normalizeRegistryEntry } from '../api/normalize.js';

const base = { experiment_id: 'EXP-900', title: 't', research_question: 'q', purpose: 'p', experiment_type: 'TYPE_1',
  expected_result: 'e', success_criterion: 's', status: 'ACCUMULATING', baseline: 'b', next_action: 'n' };

test('a missing decision is "not reported", never inferred', () => {
  const v = decisionView({ experiment_id: 'EXP-900', status: 'ACCUMULATING', suggested_status: 'READY_FOR_ANALYSIS' });
  assert.equal(v.reported, false);
  assert.equal(v.decided, false);
  assert.match(v.label, /not reported/);
});

test('backend state and basis are shown as sent; owner decision pending', () => {
  const v = decisionView({ decision: { state: 'BLOCKED', label: 'Blocked', basis: 'no pre-registered test', owner_decided: false, owner_decision: null, proposal: null, production_use: null, model_version: 'decision-state-v1' } });
  assert.equal(v.state, 'BLOCKED');
  assert.equal(v.badge, 'status-error');
  assert.equal(v.basis, 'no pre-registered test');
  assert.match(v.owner, /pending with the owner/);
  assert.equal(v.scope, 'Research only');
});

test('a proposal is labelled as not a decision and never marks the entry decided', () => {
  const v = decisionView({ decision: { state: 'READY_FOR_EVALUATION', label: 'Ready for evaluation', owner_decided: false,
    proposal: { proposal: 'REJECT', basis: '7 of 40', evidence_ref: 'r.md' } } });
  assert.equal(v.decided, false);
  assert.equal(v.proposal.text, 'Proposed REJECT (not a decision)');
});

test('production use without a recorded decision is flagged and is not a production decision', () => {
  const v = decisionView({ decision: { state: 'PROPOSED', label: 'Proposed, not started', owner_decided: false,
    production_use: { where: 'V1 riskregime', since: '2026-10-12', decision_recorded: false } } });
  assert.equal(v.production.text, 'Used in production, no decision recorded');
  assert.equal(v.production.warn, true);
  assert.notEqual(v.scope, 'Production (owner decision)');
});

test('only an owner-decided state reads as decided', () => {
  const owner = { decision: 'IMPLEMENTED_RESEARCH_ONLY', decided_ts: Date.UTC(2026, 10, 2), decided_by: 'owner', rationale: 'ok' };
  assert.equal(decisionView({ decision: { state: 'IMPLEMENTED_RESEARCH_ONLY', owner_decided: true, owner_decision: owner } }).decided, true);
  assert.equal(decisionView({ decision: { state: 'IMPLEMENTED_RESEARCH_ONLY', owner_decided: false } }).decided, false);
});

test('normalizeRegistryEntry passes decision through unchanged; absent stays absent', () => {
  const d = { state: 'COLLECTING', label: 'Collecting' };
  assert.deepEqual(normalizeRegistryEntry({ ...base, decision: d }).decision, d);
  assert.equal('decision' in normalizeRegistryEntry(base), false);
  assert.equal('decision' in normalizeRegistryEntry({ ...base, decision: 'x' }), false);
});

test('experimentStage uses the backend decision state when present, legacy fields otherwise', async () => {
  const { experimentStage } = await import('../api/evaluation.js');
  assert.deepEqual(experimentStage({ status: 'ACCUMULATING', suggested_status: 'READY_FOR_ANALYSIS', decision: { state: 'BLOCKED', label: 'Blocked' } }),
    { key: 'blocked', label: 'Blocked', source: 'api' });
  assert.equal(experimentStage({ status: 'ACCUMULATING', suggested_status: 'READY_FOR_ANALYSIS' }).key, 'eligible');
  assert.equal(experimentStage({ live_error: 'HTTP 500', decision: { state: 'COLLECTING' } }).key, 'unavailable');
});

test('dashboard card shows the decision row, proposal and production use; old registry says not reported', async () => {
  const { renderExperimentCard } = await import('../ui/research-dashboard.js');
  const e = { ...base, experiment_id: 'EXP-003', status: 'ACCUMULATING', progress_count: 52, required_sample: 50,
    decision: { state: 'READY_FOR_EVALUATION', label: 'Ready for evaluation', basis: 'eligible, not a result', owner_decided: false,
      owner_decision: null, proposal: { proposal: 'REJECT', basis: '7 of 40' }, production_use: null } };
  const html = renderExperimentCard(e);
  assert.match(html, /Ready for evaluation/);
  assert.match(html, /Proposed REJECT \(not a decision\)/);
  assert.match(html, /pending with the owner/);
  assert.doesNotMatch(html, /Production \(owner decision\)/);
  const prod = renderExperimentCard({ ...base, experiment_id: 'EXP-027', status: 'PROPOSED',
    decision: { state: 'PROPOSED', label: 'Proposed, not started', owner_decided: false, production_use: { where: 'V1 riskregime', decision_recorded: false } } });
  assert.match(prod, /Used in production, no decision recorded/);
  assert.match(renderExperimentCard({ ...base, status: 'ACCUMULATING' }), /Not reported by API/);
});

test('recorded production decision cites its reference, and registry conflicts are listed', async () => {
  const v = decisionView({ decision: { state: 'BLOCKED', label: 'Blocked', owner_decided: false,
    production_use: { where: 'V1 composite (hloi)', since: '2026-10-11', decision_recorded: true, decision_ref: 'V1 changelog 2026-10-11-hloi' },
    conflicts: ['D1 registry status is PROPOSED, but collection has run since 2026-10-31.'] } });
  assert.equal(v.production.text, 'Used in production (owner decision)');
  assert.equal(v.production.warn, false);
  assert.equal(v.production.ref, 'V1 changelog 2026-10-11-hloi');
  assert.deepEqual(v.conflicts, ['D1 registry status is PROPOSED, but collection has run since 2026-10-31.']);
  assert.deepEqual(decisionView({}).conflicts, []);
  const { renderExperimentCard } = await import('../ui/research-dashboard.js');
  const html = renderExperimentCard({ id: 'EXP-008', name: 'x', decision: { state: 'COLLECTING', label: 'Collecting', owner_decided: false, conflicts: ['stale <PROPOSED>'] } });
  assert.match(html, /Registry conflict:/);
  assert.match(html, /stale &lt;PROPOSED&gt;/);
});

test('owner directives are listed per experiment, escaped, and never mark the experiment decided', async () => {
  const v = decisionView({ decision: { state: 'BLOCKED', label: 'Blocked', owner_decided: false,
    owner_directives: [{ id: 'H1', directive: 'STRUCTURAL_CHECK_ALLOWED', text: 'Structural checks only <b>', decided_ts: 1793404800000 }] } });
  assert.deepEqual(v.directives, [{ id: 'H1', directive: 'STRUCTURAL CHECK ALLOWED', text: 'Structural checks only <b>', decided_ts: 1793404800000 }]);
  assert.equal(v.decided, false);
  assert.deepEqual(decisionView({ decision: { state: 'COLLECTING' } }).directives, []);
  const { renderExperimentCard } = await import('../ui/research-dashboard.js');
  const html = renderExperimentCard({ id: 'EXP-009', name: 'x', decision: { state: 'BLOCKED', label: 'Blocked', owner_decided: false,
    owner_directives: [{ id: 'H1', directive: 'STRUCTURAL_CHECK_ALLOWED', text: 'Structural checks only <b>' }] } });
  assert.match(html, /Owner directive H1 \(STRUCTURAL CHECK ALLOWED, not a decided outcome\)/);
  assert.match(html, /Structural checks only &lt;b&gt;/);
});
