import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isScheduled, realizedUp, wilson, originSplit, directionalStats, calibrationStats, trendStats,
  largeMoveStats, overallStatus, groupExperiments, evidenceStatus, factorRows, combinedFactorCard,
  adaptationEvidence, snapshotOf, diffSnapshots, dailyFindings, HOUR_MS, DAY_MS,
} from '../api/evaluation.js';
import { latestV1Reading, normalizeV4Performance } from '../api/sources.js';

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const pred = (o) => ({ ts: NOW - DAY_MS, direction: 'UP', p_up: 0.6, correct: true, actualMove: 1, ...o });

test('isScheduled: within 5 min after a 3h grid tick only', () => {
  assert.equal(isScheduled(Date.UTC(2026, 9, 11, 9, 1, 6)), true);
  assert.equal(isScheduled(Date.UTC(2026, 9, 11, 10, 1, 0)), false);
  assert.equal(isScheduled(Date.UTC(2026, 9, 11, 9, 6, 0)), false);
});

test('realizedUp derives the outcome from direction + correct; pending is null', () => {
  assert.equal(realizedUp(pred({ direction: 'UP', correct: true })), 1);
  assert.equal(realizedUp(pred({ direction: 'UP', correct: false })), 0);
  assert.equal(realizedUp(pred({ direction: 'DOWN', correct: false })), 1);
  assert.equal(realizedUp(pred({ correct: null })), null);
});

test('wilson interval brackets the point estimate', () => {
  const w = wilson(60, 100);
  assert.ok(w.lo < 0.6 && w.hi > 0.6 && w.lo > 0.49 && w.hi < 0.7);
  assert.deepEqual(wilson(0, 0), { lo: null, hi: null });
});

test('originSplit counts scheduled vs live and resolved vs pending', () => {
  const s = originSplit([pred({ ts: Date.UTC(2026, 9, 10, 3, 1) }), pred({ ts: Date.UTC(2026, 9, 10, 4, 30), correct: null })]);
  assert.deepEqual(s, { scheduled: 1, live: 1, resolved: 1, pending: 1 });
});

test('directionalStats: always-up market gives a 100% baseline, so 60% accuracy is BELOW', () => {
  // all outcomes up: correct when called UP
  const preds = [...Array(60)].map(() => pred({ direction: 'UP', correct: true })).concat([...Array(40)].map(() => pred({ direction: 'DOWN', correct: false })));
  const s = directionalStats(preds);
  assert.equal(s.n, 100); assert.equal(s.accuracy, 0.6); assert.equal(s.baseline, 1); assert.equal(s.verdict, 'BELOW_BASELINE');
});

test('directionalStats: balanced market, strong accuracy BEATS, coin-flip is WITHIN_NOISE, empty is NO_DATA', () => {
  const mk = (hitUp, missUp, hitDown, missDown) => [
    ...Array(hitUp).fill(0).map(() => pred({ direction: 'UP', correct: true })),
    ...Array(missUp).fill(0).map(() => pred({ direction: 'UP', correct: false })),
    ...Array(hitDown).fill(0).map(() => pred({ direction: 'DOWN', correct: true })),
    ...Array(missDown).fill(0).map(() => pred({ direction: 'DOWN', correct: false })),
  ];
  assert.equal(directionalStats(mk(80, 20, 80, 20)).verdict, 'BEATS_BASELINE');
  assert.equal(directionalStats(mk(26, 24, 26, 24)).verdict, 'WITHIN_NOISE');
  assert.equal(directionalStats([pred({ correct: null })]).verdict, 'NO_DATA');
});

test('calibrationStats needs 10 resolved; perfect calibration has positive skill', () => {
  assert.equal(calibrationStats([pred({})]).brier, null);
  const preds = [...Array(10)].map(() => pred({ p_up: 0.9, direction: 'UP', correct: true }))
    .concat([...Array(10)].map(() => pred({ p_up: 0.1, direction: 'DOWN', correct: true })));
  const c = calibrationStats(preds);
  assert.ok(c.brier < 0.02 && c.skill > 0.9);
});

test('trendStats: insufficient per window, then significant improvement', () => {
  assert.equal(trendStats([pred({})], NOW).verdict, 'INSUFFICIENT_DATA');
  const recent = [...Array(60)].map((_, i) => pred({ ts: NOW - (i + 1) * HOUR_MS * 6, correct: i % 10 !== 0 }));   // 90%
  const prior = [...Array(60)].map((_, i) => pred({ ts: NOW - 31 * DAY_MS - i * HOUR_MS * 6, correct: i % 2 === 0 })); // 50%
  assert.equal(trendStats([...recent, ...prior], NOW).verdict, 'IMPROVING');
});

test('largeMoveStats: reports insufficient below 10 large moves, recall at or above', () => {
  const few = largeMoveStats([pred({ actualMove: 4, direction: 'UP' })]);
  assert.equal(few.up.status, 'INSUFFICIENT_DATA'); assert.equal(few.up.recall, null); assert.equal(few.up.moves, 1);
  const many = largeMoveStats([...Array(10)].map((_, i) => pred({ actualMove: -5, direction: i < 7 ? 'DOWN' : 'UP', correct: i < 7 })));
  assert.equal(many.down.recall, 0.7);
});

test('overallStatus: BLOCKED on a stale core series, INCONCLUSIVE with no data or noise', () => {
  const fr = { ok: true, rows: [{ coin: 'BTC', horizon: '24', track: 'core', status: 'STALE' }, { coin: 'ETH', horizon: '24', track: 'challenger', status: 'NONE' }] };
  const b = overallStatus([], fr);
  assert.equal(b.status, 'BLOCKED'); assert.match(b.reason, /BTC 24h/); assert.doesNotMatch(b.reason, /ETH/);
  assert.equal(overallStatus([], { ok: true, rows: [] }).status, 'INCONCLUSIVE');
  const cell = { coin: 'BTC', horizon: 24, stats: { n: 50, hits: 26, verdict: 'WITHIN_NOISE' }, trend: { verdict: 'INSUFFICIENT_DATA' } };
  assert.equal(overallStatus([cell], null).status, 'INCONCLUSIVE');
  assert.equal(overallStatus([{ ...cell, trend: { verdict: 'DECLINING' } }], null).status, 'NOT_IMPROVING');
  assert.equal(overallStatus([{ ...cell, stats: { ...cell.stats, verdict: 'BEATS_BASELINE' }, trend: { verdict: 'IMPROVING' } }], null).status, 'IMPROVING');
});

test('groupExperiments keeps every id; unknown ids land in Other', () => {
  const g = groupExperiments([{ experiment_id: 'EXP-004' }, { experiment_id: 'EXP-099' }]);
  assert.equal(g.find(x => x.key === 'models').items.length, 1);
  assert.deepEqual(g.find(x => x.key === 'other').ids, ['EXP-099']);
});

test('evidenceStatus separates scientific evidence from operational status', () => {
  assert.equal(evidenceStatus({ status: 'ACCUMULATING', suggested_status: 'READY_FOR_ANALYSIS' }).key, 'ready');
  assert.equal(evidenceStatus({ status: 'ACCUMULATING' }).key, 'insufficient');
  assert.equal(evidenceStatus({ status: 'ACCUMULATING', conclusion: 'Did not replicate out of sample' }).key, 'negative');
  assert.equal(evidenceStatus({ live_error: 'HTTP 500' }).key, 'unavailable');
});

const ADAPT = {
  mode: 'shadow', policy: { minSamples: 30, minDeltaPts: 2, sampleSpacingHours: 6 },
  defaults: { fng: [2, 1], funding: [1, 1], hloi: [4, 0.3] },
  default_shares_pct: { fng: 50, funding: 25, hloi: 30 },
  latest: null,
  preview: { persisted: false, n_samples: 12, evidence: { fng: { samples: 12, decision: 'insufficient_samples' } } },
  evaluation: null,
};

test('factorRows keeps raw score, weight, share, composite points and incremental value separate', () => {
  const cats = factorRows(ADAPT, { fng: 60 }, { funding: { delta_pts: 3, samples: 40 } });
  const rows = cats.flatMap(c => c.rows);
  const fng = rows.find(r => r.id === 'fng');
  assert.equal(fng.rawScore, 60); assert.equal(fng.configuredWeight, 2); assert.equal(fng.effectiveSharePct, 50); assert.equal(fng.compositePoints, 30);
  assert.equal(fng.v3IncrementalValue, null);
  const funding = rows.find(r => r.id === 'funding');
  assert.equal(funding.rawScore, null); assert.equal(funding.compositePoints, null); assert.deepEqual(funding.v1LeaveOneOut, { deltaPts: 3, samples: 40 });
});

test('combinedFactorCard: insufficient samples gives an ETA projection and no claimed effect', () => {
  const c = combinedFactorCard(ADAPT, NOW);
  assert.equal(c.evidence.key, 'insufficient');
  assert.match(c.finding, /12 of 30/);
  assert.equal(c.eta, '2026-10-16'); // 18 samples at 4/day -> 5 days
  assert.match(c.v3, /Not measured/);
  assert.equal(adaptationEvidence(ADAPT).persisted, false);
});

test('combinedFactorCard: tested factors are in-sample until the out-of-sample verdict', () => {
  const a = { ...ADAPT, preview: null, latest: { run_ts: NOW, n_samples: 40, evidence: { fng: { delta_pts: 3 }, funding: { delta_pts: -2.5 }, hloi: { delta_pts: 0.5 } } } };
  const c = combinedFactorCard(a, NOW);
  assert.equal(c.evidence.key, 'inconclusive'); assert.match(c.finding, /1 add .*fng.*1 subtract .*funding/);
  assert.equal(combinedFactorCard({ ...a, evaluation: { verdict: 'WORSE' } }, NOW).evidence.key, 'negative');
  assert.equal(combinedFactorCard(null).evidence.key, 'unavailable');
});

test('snapshot diff reports status, resolution and readiness changes', () => {
  const base = { now: NOW, overall: { status: 'INCONCLUSIVE' }, cells: [{ stats: { n: 10 } }], experiments: [{ experiment_id: 'EXP-004', status: 'ACCUMULATING' }] };
  const a = snapshotOf(base);
  const b = snapshotOf({ ...base, overall: { status: 'BLOCKED' }, cells: [{ stats: { n: 13 } }], experiments: [{ experiment_id: 'EXP-004', status: 'ACCUMULATING', suggested_status: 'READY_FOR_ANALYSIS' }] });
  const d = diffSnapshots(a, b);
  assert.ok(d.some(x => /blocked/.test(x)) && d.some(x => /3 more/.test(x)) && d.some(x => /EXP-004 now/.test(x)));
  assert.match(diffSnapshots(null, b)[0], /First visit/);
  assert.match(diffSnapshots(a, a)[0], /No meaningful change/);
});

test('dailyFindings: at most two actions, milestone from the earliest estimable ETA', () => {
  const exps = [
    { experiment_id: 'EXP-004', title: 'A', suggested_status: 'READY_FOR_ANALYSIS' },
    { experiment_id: 'EXP-005', title: 'B', suggested_status: 'READY_FOR_ANALYSIS' },
    { experiment_id: 'EXP-009', title: 'C', suggested_status: 'READY_FOR_ANALYSIS' },
    { experiment_id: 'EXP-011', eta: { estimable: true, reached: false, eta_date: '2026-11-01', progress: 5, required: 30 } },
  ];
  const f = dailyFindings({ overall: { status: 'INCONCLUSIVE', reason: 'r' }, cells: [], experiments: exps, hloi: { status: 'INSUFFICIENT_HISTORY' }, adaptation: ADAPT });
  assert.equal(f.actions.length, 2); assert.match(f.finding, /EXP-004/); assert.match(f.limitation, /Hyperliquid/);
  assert.equal(f.milestone.date, '2026-11-01');
});

test('latestV1Reading keeps only numeric source scores from the newest row', () => {
  const r = latestV1Reading({ history: [{ ts: 1, score: 40, sources_json: '{}' }, { ts: 2, score: 55, sources_json: '{"fng":60,"x":"n/a"}' }] });
  assert.deepEqual(r, { ok: true, ts: 2, score: 55, sources: { fng: 60 }, rows: 2 });
  assert.equal(latestV1Reading({ history: [] }).ok, false);
});

test('normalizeV4Performance filters to V3 coins and renames without deriving', () => {
  const r = normalizeV4Performance({ performance: [{ asset_id: 'BTC', horizon: '24h', regime: 'ALL', status: 'OK', samples: 25, win_rate: 0.56 }, { asset_id: 'SOL', samples: 3 }] });
  assert.deepEqual(r.rows, [{ coin: 'BTC', horizon: '24h', regime: 'ALL', status: 'OK', samples: 25, winRate: 0.56 }]);
  assert.equal(normalizeV4Performance({}).ok, false);
});
