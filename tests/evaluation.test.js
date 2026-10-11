import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isScheduled, realizedUp, wilson, originSplit, directionalStats, calibrationStats, trendStats,
  largeMoveStats, overallStatus, groupExperiments, experimentStage, factorRows, combinedFactorCard,
  adaptationEvidence, predictionsAsOf, trendReadyDate, nextReview, whatChanged, recommendations,
  reconstructedComposite, HOUR_MS, DAY_MS,
} from '../api/evaluation.js';
import { latestV1Reading } from '../api/sources.js';

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

test('overallStatus: DATA_QUALITY on a stale core series or a failed series', () => {
  const fr = { ok: true, rows: [{ coin: 'BTC', horizon: '24', track: 'core', status: 'STALE' }, { coin: 'ETH', horizon: '24', track: 'challenger', status: 'NONE' }] };
  const b = overallStatus([], fr);
  assert.equal(b.status, 'DATA_QUALITY'); assert.match(b.reason, /BTC 24h/); assert.doesNotMatch(b.reason, /ETH/);
  assert.equal(overallStatus([{ coin: 'ETH', horizon: 12, ok: false, error: 'HTTP 500' }], null).status, 'DATA_QUALITY');
});

test('overallStatus: INSUFFICIENT_DATA without resolved rows or without a testable 30-day trend', () => {
  assert.equal(overallStatus([], { ok: true, rows: [] }).status, 'INSUFFICIENT_DATA');
  const cell = { coin: 'BTC', horizon: 24, stats: { n: 50, hits: 26, verdict: 'WITHIN_NOISE' }, trend: { verdict: 'INSUFFICIENT_DATA' } };
  const s = overallStatus([cell], null);
  assert.equal(s.status, 'INSUFFICIENT_DATA'); assert.match(s.reason, /cannot be measured yet/);
});

test('overallStatus: INCONCLUSIVE / DETERIORATING / NOT_IMPROVING / IMPROVING from evaluation results only', () => {
  const cell = { coin: 'BTC', horizon: 24, stats: { n: 50, hits: 26, verdict: 'WITHIN_NOISE' }, trend: { verdict: 'NO_SIGNIFICANT_CHANGE' } };
  assert.equal(overallStatus([cell], null).status, 'INCONCLUSIVE');
  assert.equal(overallStatus([{ ...cell, trend: { verdict: 'DECLINING' } }], null).status, 'DETERIORATING');
  assert.equal(overallStatus([{ ...cell, stats: { ...cell.stats, verdict: 'BELOW_BASELINE' } }], null).status, 'NOT_IMPROVING');
  assert.equal(overallStatus([{ ...cell, stats: { ...cell.stats, verdict: 'BEATS_BASELINE' }, trend: { verdict: 'IMPROVING' } }], null).status, 'IMPROVING');
  // beating the baseline without a measured improvement over time is not "Improving"
  assert.notEqual(overallStatus([{ ...cell, stats: { ...cell.stats, verdict: 'BEATS_BASELINE' } }], null).status, 'IMPROVING');
});

test('predictionsAsOf drops later rows and un-resolves rows whose target had not passed', () => {
  const T = NOW - DAY_MS;
  const r = predictionsAsOf([pred({ ts: T - 2 * DAY_MS, target_ts: T - DAY_MS }), pred({ ts: T - HOUR_MS, target_ts: T + 11 * HOUR_MS }), pred({ ts: T + HOUR_MS })], T);
  assert.equal(r.length, 2); assert.equal(r[0].correct, true); assert.equal(r[1].correct, null);
});

test('trendReadyDate: date when the prior window first holds 20 rows; null without history or rate', () => {
  // 30 scheduled rows, one every 6h starting 20 days ago (cron-aligned)
  const start = Math.floor((NOW - 20 * DAY_MS) / (3 * HOUR_MS)) * 3 * HOUR_MS;
  const rows = [...Array(80)].map((_, i) => pred({ ts: start + i * 6 * HOUR_MS }));
  const d = trendReadyDate(rows, NOW);
  assert.equal(d, rows[19].ts + 30 * DAY_MS);
  assert.equal(trendReadyDate(rows.slice(0, 5), NOW), null);
});

test('nextReview: earliest projectable event, else Not yet estimable with a reason', () => {
  const none = nextReview({ cells: [], experiments: [], now: NOW });
  assert.equal(none.date, null); assert.equal(none.text, 'Not yet estimable'); assert.ok(none.why.length > 20);
  const r = nextReview({ cells: [], experiments: [{ experiment_id: 'EXP-003', eta: { estimable: true, reached: false, eta_date: '2026-11-12', progress: 16, required: 50 } },
    { experiment_id: 'EXP-010', eta: { estimable: true, reached: false, eta_date: '2026-10-18', progress: 3, required: 4 } }], now: NOW });
  assert.equal(r.date, '2026-10-18'); assert.match(r.text, /EXP-010/); assert.equal(r.later[0].date, '2026-11-12');
});

test('whatChanged reports resolutions and verdict changes, or no meaningful change', () => {
  const c = (n, verdict, acc) => ({ coin: 'BTC', horizon: 24, ok: true, stats: { n, verdict, accuracy: acc }, preds: [] });
  const out = whatChanged({ cells: [c(60, 'BEATS_BASELINE', 0.6)], prevCells: [c(52, 'WITHIN_NOISE', 0.55)], overall: { status: 'INCONCLUSIVE' }, prevOverall: { status: 'INCONCLUSIVE' }, experiments: [], now: NOW });
  assert.match(out[0], /8 prediction\(s\) resolved \(BTC 24h \+8\)/); assert.ok(out.some(x => /within noise → beats baseline/.test(x)));
  const same = whatChanged({ cells: [c(52, 'WITHIN_NOISE', 0.55)], prevCells: [c(52, 'WITHIN_NOISE', 0.55)], overall: { status: 'INCONCLUSIVE' }, prevOverall: { status: 'INCONCLUSIVE' }, experiments: [], now: NOW });
  assert.deepEqual(same, ['No meaningful change in the last 24 hours.']);
});

test('recommendations: blockers first, eligible experiments framed as eligible not successful, max three', () => {
  const overall = { status: 'DATA_QUALITY', problems: ['ETH 12h core predictions are stale (not saving on schedule)'] };
  const exps = ['EXP-004', 'EXP-005', 'EXP-009'].map(id => ({ experiment_id: id, suggested_status: 'READY_FOR_ANALYSIS', progress_count: 4, required_sample: 4 }));
  const r = recommendations({ overall, cells: [], experiments: exps, adaptation: null, review: null });
  assert.equal(r.length, 3); assert.equal(r[0].kind, 'blocker'); assert.match(r[1].text, /eligible for evaluation, not successful/);
  assert.deepEqual(recommendations({ overall: { status: 'INCONCLUSIVE' }, cells: [], experiments: [], adaptation: null, review: null }), []);
});

test('groupExperiments keeps every id; unknown ids land in Other', () => {
  const g = groupExperiments([{ experiment_id: 'EXP-004' }, { experiment_id: 'EXP-099' }]);
  assert.equal(g.find(x => x.key === 'models').items.length, 1);
  assert.deepEqual(g.find(x => x.key === 'other').ids, ['EXP-099']);
});

test('experimentStage uses registry fields only; a met threshold is eligibility, not success', () => {
  assert.deepEqual(experimentStage({ status: 'ACCUMULATING', suggested_status: 'READY_FOR_ANALYSIS' }), { key: 'eligible', label: 'Eligible for evaluation' });
  assert.equal(experimentStage({ status: 'ACCUMULATING' }).key, 'collecting');
  assert.equal(experimentStage({ status: 'ACCUMULATING', conclusion: 'anything' }).key, 'evaluated');
  assert.equal(experimentStage({ live_error: 'HTTP 500' }).key, 'unavailable');
  assert.equal(experimentStage({ status: 'BUILT_NOT_ACTIVATED' }).key, 'inactive');
});

test('EXP-005 (V1 source research) and EXP-011 (agentic evidence) land in different groups', () => {
  const g = groupExperiments([{ experiment_id: 'EXP-005' }, { experiment_id: 'EXP-011' }]);
  assert.equal(g.find(x => x.key === 'sentiment').items[0].experiment_id, 'EXP-005');
  assert.equal(g.find(x => x.key === 'signals').items[0].experiment_id, 'EXP-011');
});

const ADAPT = {
  mode: 'shadow', policy: { minSamples: 30, minDeltaPts: 2, sampleSpacingHours: 6 },
  defaults: { fng: [2, 1], funding: [1, 1], hloi: [4, 0.3] },
  default_shares_pct: { fng: 50, funding: 25, hloi: 30 },
  latest: null,
  preview: { persisted: false, n_samples: 12, evidence: { fng: { samples: 12, decision: 'insufficient_samples' } } },
  evaluation: null,
};

test('factorRows: effective share renormalises over present sources; hloi excluded while collecting', () => {
  const reading = { ok: true, ts: NOW, score: 55, sources: { fng: 60, funding: 40, hloi: 70 } };
  const cats = factorRows(ADAPT, reading, { funding: { delta_pts: 3, samples: 40 }, fng: { samples: 12 } }, { status: 'INSUFFICIENT_HISTORY' });
  const rows = cats.flatMap(c => c.rows);
  const fng = rows.find(r => r.id === 'fng'), funding = rows.find(r => r.id === 'funding'), hloi = rows.find(r => r.id === 'hloi');
  // present: fng (2x1) + funding (1x1) -> 2/3 and 1/3
  assert.ok(Math.abs(fng.effectiveSharePct - 66.667) < 0.01); assert.ok(Math.abs(fng.contributionPts - 40) < 0.01);
  assert.equal(fng.configuredWeight, 2); assert.equal(fng.configuredSharePct, 50);
  assert.equal(fng.predictive.status, 'insufficient'); assert.equal(fng.predictive.samples, 12);
  assert.equal(funding.predictive.status, 'helps');
  assert.equal(hloi.contributing, false); assert.equal(hloi.effectiveSharePct, null); assert.equal(hloi.contributionPts, null); assert.equal(hloi.rawScore, null);
  assert.match(hloi.excludedReason, /Collecting history/);
  assert.ok(Math.abs(reconstructedComposite(cats) - (60 * 2 / 3 + 40 / 3)) < 1e-9);
  assert.equal(rows.every(r => r.v3IncrementalValue === null), true);
});

test('factorRows: hloi contributes only when /hl-oi is OK and the reading has it; missing sources are excluded', () => {
  const cats = factorRows(ADAPT, { ok: true, sources: { hloi: 70 } }, {}, { status: 'OK' });
  const rows = cats.flatMap(c => c.rows);
  assert.equal(rows.find(r => r.id === 'hloi').contributing, true);
  assert.equal(rows.find(r => r.id === 'hloi').effectiveSharePct, 100);
  assert.match(rows.find(r => r.id === 'fng').excludedReason, /No value in the latest V1 reading/);
});

test('combinedFactorCard: insufficient samples gives an ETA projection and no claimed effect', () => {
  const c = combinedFactorCard(ADAPT);
  assert.equal(c.evidence.key, 'insufficient');
  assert.match(c.finding, /12 of 30/);
  assert.equal(c.eta, null); assert.match(c.etaWhy, /not recorded on a fixed schedule/); // no guaranteed accrual rate
  assert.match(c.v3, /Not measured/);
  assert.equal(adaptationEvidence(ADAPT).persisted, false);
});

test('combinedFactorCard: tested factors are in-sample until the out-of-sample verdict', () => {
  const a = { ...ADAPT, preview: null, latest: { run_ts: NOW, n_samples: 40, evidence: { fng: { delta_pts: 3 }, funding: { delta_pts: -2.5 }, hloi: { delta_pts: 0.5 } } } };
  const c = combinedFactorCard(a);
  assert.equal(c.evidence.key, 'inconclusive'); assert.match(c.finding, /1 add .*fng.*1 subtract .*funding/);
  assert.equal(combinedFactorCard({ ...a, evaluation: { verdict: 'WORSE' } }).evidence.key, 'negative');
  assert.equal(combinedFactorCard(null).evidence.key, 'unavailable');
});

test('latestV1Reading keeps only numeric source scores from the newest row', () => {
  const r = latestV1Reading({ history: [{ ts: 1, score: 40, sources_json: '{}' }, { ts: 2, score: 55, sources_json: '{"fng":60,"x":"n/a"}' }] });
  assert.deepEqual(r, { ok: true, ts: 2, score: 55, sources: { fng: 60 }, rows: 2 });
  assert.equal(latestV1Reading({ history: [] }).ok, false);
});

