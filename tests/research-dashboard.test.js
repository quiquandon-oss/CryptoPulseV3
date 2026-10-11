import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, renderOverview, renderPerformance, renderExperiments, renderFactors, pool, PERF_TABS } from '../ui/research-dashboard.js';

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const H = 3600000;
const p = (i, o = {}) => { const ts = Date.UTC(2026, 9, 1) + i * 3 * H; return { ts, target_ts: ts + 24 * H, direction: 'UP', p_up: 0.6, correct: i % 2 === 0, actualMove: i % 5 === 0 ? 4 : 0.5, ...o }; };
const ADAPT = { ok: true, mode: 'shadow', policy: { minFactor: 0.5, maxFactor: 1.5, maxStepPct: 10, maxSharePct: 20, minSamples: 30, minDeltaPts: 2, sampleSpacingHours: 6 },
  defaults: { fng: [2, 1], funding: [1, 1], hloi: [4, 0.3] }, default_shares_pct: { fng: 46.5, funding: 23.3, hloi: 30.2 }, latest: null,
  preview: { persisted: false, n_samples: 8, evidence: {}, reason: 'insufficient evidence: 8 of 30' }, evaluation: null, history: [] };
const FRESH = { ok: true, generated_ts: NOW - 60000, rows: ['BTC', 'ETH', 'LINK'].flatMap(coin => ['12', '24'].map(horizon => ({ coin, horizon, track: 'core', status: 'FRESH', latest_ts: NOW - H }))) };

function data(over = {}) {
  const charts = {};
  for (const c of ['BTC', 'ETH', 'LINK']) for (const h of [12, 24]) charts[`${c}-${h}`] = { ok: true, predictions: [...Array(40)].map((_, i) => p(i)) };
  return { charts, freshness: FRESH, registry: { ok: true, experiments: [
    { experiment_id: 'EXP-004', title: 'TimesFM', display_label: 'EXP-004 · TimesFM challenger', research_question: 'Does TimesFM beat k-NN? Second sentence here.', baseline: 'k-NN', next_action: 'Run the evaluation', status: 'ACCUMULATING', suggested_status: 'READY_FOR_ANALYSIS', progress_count: 34, required_sample: 30, eta: { estimable: true, reached: true }, confidence_evidence_maturity: 'LOW', current_measured_result: 'NOT_AVAILABLE', conclusion: null },
    { experiment_id: 'EXP-005', title: 'V1 Source / Coefficient Research', research_question: 'Which V1 sources help?', next_action: 'n', status: 'ACCUMULATING' },
    { experiment_id: 'EXP-011', title: 'Experiment 5 -- Agentic Market Evidence', display_label: 'EXP-011 · Experiment 5 — Agentic Market Evidence', research_question: 'Agentic?', next_action: 'n', status: 'BUILT_NOT_ACTIVATED' },
  ] }, v1Latest: { ok: true, ts: NOW, score: 52, sources: { fng: 60, funding: 40 } }, adaptation: ADAPT, hloi: { ok: true, status: 'INSUFFICIENT_HISTORY' }, ...over };
}

test('Overview renders sections A–E in order with no inner app identity', () => {
  const html = renderOverview(buildModel(data(), NOW));
  const order = ['Research outcome', 'Core metrics', 'What changed?', 'What should we do next?', 'Next milestone'].map(t => html.indexOf(t));
  assert.ok(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), `order ${order}`);
  assert.doesNotMatch(html, /CryptoPulse|rd-v3|Last refresh/);
  assert.match(html, /Insufficient data|Inconclusive|Improving|Not improving|Deteriorating/);
  assert.match(html, /Data quality<\/p><p class="rd-metric-v ">Healthy/);
  assert.match(html, /eligible for evaluation, not successful/);
});

test('stale ETH (best-effort) is Degraded, not a problem, and leaves the research outcome untouched', () => {
  const fr = { ...FRESH, rows: FRESH.rows.map(r => (r.coin === 'ETH' && r.horizon === '12' ? { ...r, status: 'STALE' } : r)) };
  const healthy = buildModel(data(), NOW);
  const m = buildModel(data({ freshness: fr }), NOW);
  assert.equal(m.dataQuality.status, 'DEGRADED');
  assert.equal(m.overall.status, healthy.overall.status);
  assert.ok(!m.actions.some(a => a.kind === 'blocker'));
  assert.match(renderOverview(m), /Degraded \(best-effort series\)/);
});

test('a stale required series (BTC/LINK) is a data quality problem with a blocker, research outcome unchanged', () => {
  const fr = { ...FRESH, rows: FRESH.rows.map(r => (r.coin === 'LINK' && r.horizon === '24' ? { ...r, status: 'STALE' } : r)) };
  const m = buildModel(data({ freshness: fr }), NOW);
  assert.equal(m.dataQuality.status, 'PROBLEM');
  assert.equal(m.overall.status, buildModel(data(), NOW).overall.status);
  assert.equal(m.actions[0].kind, 'blocker');
  assert.match(renderOverview(m), /Data quality problem/);
});

test('persistence check unavailable renders Unable to verify, not a fabricated count or Healthy', () => {
  const html = renderOverview(buildModel(data({ freshness: { ok: false, error: 'timeout' } }), NOW));
  assert.match(html, /Data quality<\/p><p class="rd-metric-v rd-muted">Unable to verify/);
  assert.doesNotMatch(html, /Healthy/);
});

test('every Performance sub-view renders; a failed series shows Unavailable; provenance is stated', () => {
  const d = data(); d.charts['ETH-12'] = { ok: false, error: 'HTTP 500' };
  const m = buildModel(d, NOW);
  for (const [k] of PERF_TABS) {
    const h = renderPerformance(m, k);
    assert.match(h, /ETH 12h<\/td><td colspan="\d"><span class="rd-muted">Unavailable/, k);
    assert.match(h, /Source: PulseWorkerV2/);
  }
  assert.doesNotMatch(renderPerformance(m, 'direction'), /V4|regime/i);
});

test('Experiment cards: one-sentence question, eligible badge, collapsed raw JSON, EXP-005 and EXP-011 kept distinct', () => {
  const html = renderExperiments(buildModel(data(), NOW));
  assert.match(html, /<p class="rd-sub">Does TimesFM beat k-NN\?<\/p>/);
  assert.match(html, /Eligible for evaluation/);
  assert.match(html, /Sample threshold met — eligible for evaluation, not a result/);
  assert.match(html, /<details class="rd-details"><summary>Technical details<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(html, /EXP-011 · Experiment 5 — Agentic Market Evidence/);
  assert.match(html, /EXP-005 · V1 Source \/ Coefficient Research/);
});

test('Factors: stacked source cards, hloi shown as Collecting with no contribution, no weight controls', () => {
  const html = renderFactors(buildModel(data(), NOW));
  assert.doesNotMatch(html, /<table/);
  assert.match(html, /class="rd-src-grid"/);
  const hloi = html.slice(html.indexOf('<p class="rd-src-t">hloi</p>'));
  const card = hloi.slice(0, hloi.indexOf('</article>'));
  assert.match(card, /Collecting/); assert.match(card, /0% — excluded/); assert.doesNotMatch(card, / pts <span/);
  assert.doesNotMatch(html, /<input|<button[^>]*apply|Apply proposed/i);
  assert.match(html, /V3: not measured/);
});

test('V1 adaptation outage shows Unavailable in Factors', () => {
  assert.match(renderFactors(buildModel(data({ adaptation: { ok: false, error: 'timeout' } }), NOW)), /Unavailable.*timeout/);
});

test('HTML from backend strings is escaped', () => {
  const d = data();
  d.registry.experiments[0].research_question = '<img src=x onerror=alert(1)>';
  assert.doesNotMatch(renderExperiments(buildModel(d, NOW)), /<img/);
});

test('pool sums counts and splits scheduled vs live-fallback', () => {
  const m = buildModel(data(), NOW);
  const pl = pool(m.cells.filter(c => c.ok));
  assert.equal(pl.n + pl.pending, 240); assert.equal(pl.scheduled.n + pl.live.n, pl.n);
});

test('accuracy is not shown as a result below the minimum resolved sample; pending is counted separately', () => {
  const d = data();
  for (const k of Object.keys(d.charts)) d.charts[k] = { ok: true, predictions: [...Array(10)].map((_, i) => p(i)).concat([p(10, { correct: null })]) };
  const m = buildModel(d, NOW);
  const perf = renderPerformance(m, 'direction');
  assert.match(perf, /Insufficient data<\/span> <span class="rd-muted">\(10 resolved of 20 needed · 1 pending\)/);
  assert.doesNotMatch(perf, /\d+\.\d%<br><span class="rd-muted">n=10/);
  // pooled across six series (60 resolved) the Overview does show a figure, with its n
  assert.match(renderOverview(m), /n=60 ·/);
});

test('status hero uses the plain-language label and Next milestone falls back to Not yet estimable', () => {
  const d = data(); d.registry.experiments = [];
  const html = renderOverview(buildModel({ ...d, charts: Object.fromEntries(Object.keys(d.charts).map(k => [k, { ok: true, predictions: [] }])) }, NOW));
  assert.match(html, /<p class="rd-status-v tone-info">Insufficient data<\/p>/);
  assert.match(html, /ETA: Not yet estimable/);
});
