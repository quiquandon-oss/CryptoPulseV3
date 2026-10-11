import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, renderOverview, renderPerformance, renderExperiments, renderFactors, pool } from '../ui/research-dashboard.js';
import { DAY_MS } from '../api/evaluation.js';

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const p = (i, o = {}) => ({ ts: Date.UTC(2026, 9, 1) + i * 3 * 3600000, direction: 'UP', p_up: 0.6, correct: i % 2 === 0, actualMove: i % 5 === 0 ? 4 : 0.5, ...o });
const ADAPT = { ok: true, mode: 'shadow', policy: { minFactor: 0.5, maxFactor: 1.5, maxStepPct: 10, maxSharePct: 20, minSamples: 30, minDeltaPts: 2, sampleSpacingHours: 6 },
  defaults: { fng: [2, 1], funding: [1, 1] }, default_shares_pct: { fng: 66.7, funding: 33.3 }, latest: null,
  preview: { persisted: false, n_samples: 8, evidence: {}, reason: 'insufficient evidence: 8 of 30' }, evaluation: null, history: [] };

function data(over = {}) {
  const charts = {};
  for (const c of ['BTC', 'ETH', 'LINK']) for (const h of [12, 24]) charts[`${c}-${h}`] = { ok: true, predictions: [...Array(40)].map((_, i) => p(i)) };
  return { charts, freshness: { ok: true, rows: [] }, registry: { ok: true, experiments: [
    { experiment_id: 'EXP-004', title: 'TimesFM', research_question: 'Q?', next_action: 'collect', status: 'ACCUMULATING', suggested_status: 'READY_FOR_ANALYSIS', progress_count: 34, required_sample: 30 },
  ] }, v1Latest: { ok: true, ts: NOW, score: 52, sources: { fng: 60 } }, adaptation: ADAPT, hloi: { status: 'INSUFFICIENT_HISTORY' }, v4: { ok: true, rows: [] }, ...over };
}

test('buildModel + every view renders from live-shaped data without invented numbers', () => {
  const m = buildModel(data(), NOW);
  assert.equal(m.cells.length, 6);
  const ov = renderOverview(m, ['x']);
  assert.match(ov, /Inconclusive|Improving|Not improving|Blocked/);
  assert.match(ov, /↓ —/); // no down moves: gated, not 0%
  for (const sub of ['direction', 'large', 'calibration', 'origin', 'regime']) assert.ok(renderPerformance(m, sub).length > 100);
  assert.match(renderPerformance(m, 'regime'), /unavailable/);
  const ex = renderExperiments(m);
  assert.match(ex, /EXP-004/); assert.match(ex, /Combined factors/); assert.match(ex, /Ready for analysis/);
  const fa = renderFactors(m);
  assert.match(fa, /Shadow mode/); assert.match(fa, /not measured/); assert.match(fa, /No scheduled run yet/);
});

test('a failed V2 series renders Unavailable and the overall status is BLOCKED when nothing loads', () => {
  const d = data();
  d.charts['ETH-12'] = { ok: false, error: 'HTTP 500' };
  const m = buildModel(d, NOW);
  assert.match(renderPerformance(m, 'direction'), /ETH 12h<\/td><td colspan="4"><span class="rd-muted">Unavailable/);
  const none = buildModel({ ...d, charts: {} }, NOW);
  assert.equal(none.overall.status, 'BLOCKED');
});

test('V1 adaptation outage shows Unavailable in Factors, not a fabricated table', () => {
  const m = buildModel(data({ adaptation: { ok: false, error: 'timeout' } }), NOW);
  assert.match(renderFactors(m), /Unavailable.*timeout/);
});

test('HTML from backend strings is escaped', () => {
  const d = data();
  d.registry.experiments[0].research_question = '<img src=x onerror=alert(1)>';
  assert.doesNotMatch(renderExperiments(buildModel(d, NOW)), /<img/);
});

test('pool sums counts rather than averaging averages', () => {
  const m = buildModel(data(), NOW);
  const pl = pool(m.cells.filter(c => c.ok));
  assert.equal(pl.n, 240); assert.equal(pl.resolved + pl.pending, 240);
});
