import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeKnnStats, computeChallengerStats, computeTimesFmStats,
  computeDisagreementRate, buildComparison, MIN_ALIGNED_DAYS_FOR_DISAGREEMENT,
  cohortToleranceMs, dedupeByTargetTs, buildCommonCohort, computeCommonCohortStats,
  PRELIMINARY_SAMPLE_THRESHOLD, DIRECTION_CONVENTION_NOTE,
} from '../api/comparison.js';

// ---- computeKnnStats ----

test('computeKnnStats: empty input -> all null/zero, never fabricated', () => {
  const result = computeKnnStats([]);
  assert.equal(result.n, 0);
  assert.equal(result.directionalAccuracy, null);
  assert.equal(result.mae, null);
  assert.equal(result.rmse, null);
});

test('computeKnnStats: unresolved rows (correct === null) are excluded from n', () => {
  const predictions = [
    { ts: 1, correct: null, expectedMove: 1, actualMove: null },
    { ts: 2, correct: true, expectedMove: 2, actualMove: 1.5 },
  ];
  const result = computeKnnStats(predictions);
  assert.equal(result.n, 1);
  assert.equal(result.directionalAccuracy, 1);
});

test('computeKnnStats: directional accuracy is the fraction of correct===true among resolved', () => {
  const predictions = [
    { ts: 1, correct: true, expectedMove: 1, actualMove: 1 },
    { ts: 2, correct: false, expectedMove: 1, actualMove: -1 },
    { ts: 3, correct: true, expectedMove: 2, actualMove: 2 },
    { ts: 4, correct: false, expectedMove: 2, actualMove: -2 },
  ];
  const result = computeKnnStats(predictions);
  assert.equal(result.n, 4);
  assert.equal(result.directionalAccuracy, 0.5);
});

test('computeKnnStats: MAE/RMSE computed only from rows with both expectedMove and actualMove', () => {
  const predictions = [
    { ts: 1, correct: true, expectedMove: 2, actualMove: 1 }, // error 1
    { ts: 2, correct: true, expectedMove: 4, actualMove: 1 }, // error 3
    { ts: 3, correct: true, expectedMove: 5, actualMove: null }, // excluded from MAE/RMSE
  ];
  const result = computeKnnStats(predictions);
  assert.equal(result.n, 3);
  assert.equal(result.maeN, 2);
  assert.equal(result.mae, 2); // mean(|1|, |3|) = 2
  assert.equal(result.rmse, Math.sqrt((1 * 1 + 3 * 3) / 2));
});

test('computeKnnStats: MAE uses absolute error, not signed (a large negative miss is not a large positive one)', () => {
  const predictions = [
    { ts: 1, correct: false, expectedMove: -5, actualMove: 5 }, // error -10, |error|=10
  ];
  const result = computeKnnStats(predictions);
  assert.equal(result.mae, 10);
});

// ---- computeChallengerStats ----

test('computeChallengerStats: filters strictly by coin and horizon_hours', () => {
  const rows = [
    { coin: 'BTC', horizon_hours: 12, resolved_ts: 100, realized_up: 1, p_up_flat: 0.6, ts: 1 },
    { coin: 'BTC', horizon_hours: 24, resolved_ts: 100, realized_up: 1, p_up_flat: 0.6, ts: 1 }, // wrong horizon
    { coin: 'LINK', horizon_hours: 12, resolved_ts: 100, realized_up: 1, p_up_flat: 0.6, ts: 1 }, // wrong coin
  ];
  const result = computeChallengerStats(rows, 'BTC', 12);
  assert.equal(result.n, 1);
});

test('computeChallengerStats: unresolved rows (no resolved_ts/realized_up) excluded', () => {
  const rows = [
    { coin: 'BTC', horizon_hours: 12, resolved_ts: null, realized_up: null, p_up_flat: 0.6, ts: 1 },
    { coin: 'BTC', horizon_hours: 12, resolved_ts: 100, realized_up: 1, p_up_flat: 0.6, ts: 2 },
  ];
  const result = computeChallengerStats(rows, 'BTC', 12);
  assert.equal(result.n, 1);
});

test('computeChallengerStats: directional accuracy from p_up_flat threshold vs realized_up', () => {
  const rows = [
    { coin: 'BTC', horizon_hours: 12, resolved_ts: 1, realized_up: 1, p_up_flat: 0.6, ts: 1 }, // predicted UP, was UP -> correct
    { coin: 'BTC', horizon_hours: 12, resolved_ts: 2, realized_up: 1, p_up_flat: 0.4, ts: 2 }, // predicted DOWN, was UP -> wrong
    { coin: 'BTC', horizon_hours: 12, resolved_ts: 3, realized_up: 0, p_up_flat: 0.3, ts: 3 }, // predicted DOWN, was DOWN -> correct
  ];
  const result = computeChallengerStats(rows, 'BTC', 12);
  assert.equal(result.n, 3);
  assert.ok(Math.abs(result.directionalAccuracy - 2 / 3) < 1e-9);
});

test('computeChallengerStats: MAE/RMSE are always null with an explanatory note, never fabricated', () => {
  const rows = [{ coin: 'BTC', horizon_hours: 12, resolved_ts: 1, realized_up: 1, p_up_flat: 0.9, ts: 1 }];
  const result = computeChallengerStats(rows, 'BTC', 12);
  assert.equal(result.mae, null);
  assert.equal(result.rmse, null);
  assert.match(result.maeNote, /no return-magnitude forecast/);
});

// ---- computeTimesFmStats ----

test('computeTimesFmStats: unresolved forecasts excluded from n', () => {
  const forecasts = [
    { resolved: false, correct: null, absolute_error: null },
    { resolved: true, correct: true, absolute_error: 0.5 },
  ];
  const result = computeTimesFmStats(forecasts);
  assert.equal(result.n, 1);
});

test('computeTimesFmStats: MAE/RMSE reuse the backend absolute_error directly', () => {
  const forecasts = [
    { resolved: true, correct: true, absolute_error: 1 },
    { resolved: true, correct: false, absolute_error: 3 },
  ];
  const result = computeTimesFmStats(forecasts);
  assert.equal(result.maeN, 2);
  assert.equal(result.mae, 2);
  assert.equal(result.rmse, Math.sqrt((1 + 9) / 2));
});

// ---- computeDisagreementRate ----

const day = (n) => new Date(`2026-01-${String(n).padStart(2, '0')}T00:00:00Z`).getTime();

test('computeDisagreementRate: fewer than MIN_ALIGNED_DAYS_FOR_DISAGREEMENT aligned days -> null rate, not a number', () => {
  const knn = [{ ts: day(1), direction: 'UP' }];
  const challenger = [{ ts: day(1), direction: 'UP' }];
  const timesFm = [{ ts: day(1), direction: 'UP' }];
  const result = computeDisagreementRate(knn, challenger, timesFm);
  assert.ok(result.nDays < MIN_ALIGNED_DAYS_FOR_DISAGREEMENT);
  assert.equal(result.disagreementRate, null);
});

test('computeDisagreementRate: only days where all three models have an observation count', () => {
  const knn = [{ ts: day(1), direction: 'UP' }, { ts: day(2), direction: 'UP' }, { ts: day(3), direction: 'UP' }];
  const challenger = [{ ts: day(1), direction: 'UP' }, { ts: day(2), direction: 'UP' }]; // missing day 3
  const timesFm = [{ ts: day(1), direction: 'UP' }, { ts: day(2), direction: 'UP' }, { ts: day(3), direction: 'UP' }];
  const result = computeDisagreementRate(knn, challenger, timesFm);
  assert.equal(result.nDays, 2); // day 3 excluded -- Challenger has no observation that day
});

test('computeDisagreementRate: full agreement across all three every day -> rate 0', () => {
  const days = [1, 2, 3, 4];
  const obs = days.map(d => ({ ts: day(d), direction: 'UP' }));
  const result = computeDisagreementRate(obs, obs, obs);
  assert.equal(result.nDays, 4);
  assert.equal(result.disagreementRate, 0);
});

test('computeDisagreementRate: a day where any one model differs counts as disagreement', () => {
  const knn = [1, 2, 3, 4].map(d => ({ ts: day(d), direction: 'UP' }));
  const challenger = [1, 2, 3, 4].map(d => ({ ts: day(d), direction: 'UP' }));
  const timesFm = [
    { ts: day(1), direction: 'UP' },
    { ts: day(2), direction: 'DOWN' }, // disagrees
    { ts: day(3), direction: 'UP' },
    { ts: day(4), direction: 'DOWN' }, // disagrees
  ];
  const result = computeDisagreementRate(knn, challenger, timesFm);
  assert.equal(result.nDays, 4);
  assert.equal(result.disagreementRate, 0.5);
});

test('computeDisagreementRate: takes the LATEST observation per day, not the first', () => {
  // k-NN flips from DOWN to UP within the same UTC day -- the later one
  // should be what's compared, matching the ~3h-cadence reality where
  // multiple predictions can land on the same calendar day.
  const knn = [
    { ts: day(1) + 1000, direction: 'DOWN' },
    { ts: day(1) + 5000, direction: 'UP' }, // later same day
    { ts: day(2), direction: 'UP' },
    { ts: day(3), direction: 'UP' },
  ];
  const challenger = [1, 2, 3].map(d => ({ ts: day(d), direction: 'UP' }));
  const timesFm = [1, 2, 3].map(d => ({ ts: day(d), direction: 'UP' }));
  const result = computeDisagreementRate(knn, challenger, timesFm);
  assert.equal(result.disagreementRate, 0); // day 1 resolves to UP (the later obs), agrees with the rest
});

test('computeDisagreementRate: observations missing direction or ts are ignored, not treated as a stand-in day', () => {
  const knn = [{ ts: day(1), direction: null }, { ts: day(2), direction: 'UP' }, { ts: day(3), direction: 'UP' }];
  const challenger = [1, 2, 3].map(d => ({ ts: day(d), direction: 'UP' }));
  const timesFm = [1, 2, 3].map(d => ({ ts: day(d), direction: 'UP' }));
  const result = computeDisagreementRate(knn, challenger, timesFm);
  assert.equal(result.nDays, 2); // day 1 excluded: k-NN has no usable direction that day
});

// ---- buildComparison ----

test('buildComparison: bundles all three model stats plus disagreement for one coin/horizon', () => {
  const knnPredictions = [
    { ts: day(1), direction: 'UP', correct: true, expectedMove: 1, actualMove: 1 },
    { ts: day(2), direction: 'UP', correct: true, expectedMove: 1, actualMove: 1 },
    { ts: day(3), direction: 'DOWN', correct: false, expectedMove: -1, actualMove: 1 },
  ];
  const challengerRows = [1, 2, 3].map(d => ({
    coin: 'BTC', horizon_hours: 12, ts: day(d), resolved_ts: day(d) + 1, realized_up: 1, p_up_flat: 0.7,
  }));
  const timesFmForecasts = [1, 2, 3].map(d => ({
    ts: day(d), direction: 'UP', resolved: true, correct: true, absolute_error: 0.2,
  }));
  const result = buildComparison('BTC', 12, { knnPredictions, challengerRows, timesFmForecasts });
  assert.equal(result.coin, 'BTC');
  assert.equal(result.horizonHours, 12);
  assert.equal(result.models.length, 3);
  assert.deepEqual(result.models.map(m => m.model), ['k-NN', 'Challenger', 'TimesFM']);
  assert.equal(result.disagreement.nDays, 3);
  // day 3: k-NN says DOWN, Challenger/TimesFM say UP -> 1 of 3 days disagrees
  assert.ok(Math.abs(result.disagreement.disagreementRate - 1 / 3) < 1e-9);
});

test('buildComparison: Challenger rows for a different horizon never leak into this horizon\'s stats', () => {
  const knnPredictions = [];
  const challengerRows = [
    { coin: 'BTC', horizon_hours: 24, ts: day(1), resolved_ts: day(1) + 1, realized_up: 1, p_up_flat: 0.9 },
  ];
  const timesFmForecasts = [];
  const result = buildComparison('BTC', 12, { knnPredictions, challengerRows, timesFmForecasts });
  const challengerStats = result.models.find(m => m.model === 'Challenger');
  assert.equal(challengerStats.n, 0);
});

// ---- cohortToleranceMs ----

test('cohortToleranceMs: 20% of the horizon, matching the backend\'s own resolution tolerance', () => {
  assert.equal(cohortToleranceMs(12), 12 * 3600000 * 0.2);
  assert.equal(cohortToleranceMs(24), 24 * 3600000 * 0.2);
});

// ---- dedupeByTargetTs ----

test('dedupeByTargetTs: no duplicates -> all rows pass through, duplicatesRemoved 0', () => {
  const rows = [{ target_ts: 1 }, { target_ts: 2 }, { target_ts: 3 }];
  const result = dedupeByTargetTs(rows);
  assert.equal(result.rows.length, 3);
  assert.equal(result.duplicatesRemoved, 0);
});

test('dedupeByTargetTs: keeps the first-seen row per target_ts, drops the rest', () => {
  const first = { target_ts: 5, tag: 'first' };
  const rows = [first, { target_ts: 5, tag: 'second' }, { target_ts: 6, tag: 'third' }];
  const result = dedupeByTargetTs(rows);
  assert.equal(result.rows.length, 2);
  assert.equal(result.duplicatesRemoved, 1);
  assert.equal(result.rows[0].tag, 'first');
});

test('dedupeByTargetTs: a row with no target_ts is passed through, never discarded for lacking one', () => {
  const rows = [{ target_ts: null, tag: 'no-key' }, { target_ts: 1 }];
  const result = dedupeByTargetTs(rows);
  assert.equal(result.rows.length, 2);
  assert.equal(result.duplicatesRemoved, 0);
});

// ---- buildCommonCohort ----

function knnRow(targetTs, overrides = {}) {
  return { target_ts: targetTs, correct: true, expectedMove: 1, actualMove: 1, ...overrides };
}
function challengerRow(targetTs, overrides = {}) {
  return { target_ts: targetTs, p_up_flat: 0.7, realized_up: 1, resolved_ts: targetTs + 1, ...overrides };
}
function timesFmRow(targetTs, overrides = {}) {
  return { target_ts: targetTs, correct: true, absolute_error: 0.1, ...overrides };
}

test('buildCommonCohort: exact target_ts matches produce a triple', () => {
  const knn = [knnRow(1000)];
  const challenger = [challengerRow(1000)];
  const timesFm = [timesFmRow(1000)];
  const triples = buildCommonCohort(knn, challenger, timesFm, 12);
  assert.equal(triples.length, 1);
  assert.equal(triples[0].targetTs, 1000);
});

test('buildCommonCohort: a match within tolerance but not exact still counts', () => {
  const toleranceMs = cohortToleranceMs(12);
  const knn = [knnRow(1000 + toleranceMs / 2)];
  const challenger = [challengerRow(1000 - toleranceMs / 2)];
  const timesFm = [timesFmRow(1000)];
  const triples = buildCommonCohort(knn, challenger, timesFm, 12);
  assert.equal(triples.length, 1);
});

test('buildCommonCohort: a match just outside tolerance is excluded, not force-matched', () => {
  const toleranceMs = cohortToleranceMs(12);
  const knn = [knnRow(1000 + toleranceMs + 1)]; // 1ms past the tolerance boundary
  const challenger = [challengerRow(1000)];
  const timesFm = [timesFmRow(1000)];
  const triples = buildCommonCohort(knn, challenger, timesFm, 12);
  assert.equal(triples.length, 0);
});

test('buildCommonCohort: missing Challenger match excludes the anchor entirely (never a 2-of-3 triple)', () => {
  const knn = [knnRow(1000)];
  const challenger = []; // no Challenger observation at all
  const timesFm = [timesFmRow(1000)];
  const triples = buildCommonCohort(knn, challenger, timesFm, 12);
  assert.equal(triples.length, 0);
});

test('buildCommonCohort: each k-NN/Challenger row is used by at most one anchor', () => {
  const knn = [knnRow(1000)]; // only one k-NN row
  const challenger = [challengerRow(1000), challengerRow(1005)];
  const timesFm = [timesFmRow(999), timesFmRow(1001)]; // two anchors both near the same single k-NN row
  const triples = buildCommonCohort(knn, challenger, timesFm, 12);
  assert.equal(triples.length, 1); // the second anchor cannot also claim the same k-NN row
});

test('buildCommonCohort: unresolved rows (no target_ts) never anchor or match', () => {
  const knn = [knnRow(1000)];
  const challenger = [challengerRow(1000)];
  const timesFm = [{ target_ts: null, correct: true, absolute_error: 0.1 }];
  const triples = buildCommonCohort(knn, challenger, timesFm, 12);
  assert.equal(triples.length, 0);
});

// ---- computeCommonCohortStats ----

test('computeCommonCohortStats: empty cohort -> n 0, all model blocks null, not fabricated', () => {
  const result = computeCommonCohortStats([]);
  assert.equal(result.n, 0);
  assert.equal(result.knn, null);
  assert.equal(result.challenger, null);
  assert.equal(result.timesFm, null);
  assert.equal(result.allThreeCorrectRate, null);
});

test('computeCommonCohortStats: all three models correct on every triple -> accuracy 1 for each, allThreeCorrectRate 1', () => {
  const triples = [1, 2, 3].map(ts => ({
    targetTs: ts, knn: knnRow(ts), challenger: challengerRow(ts), timesFm: timesFmRow(ts),
  }));
  const result = computeCommonCohortStats(triples);
  assert.equal(result.n, 3);
  assert.equal(result.knn.directionalAccuracy, 1);
  assert.equal(result.challenger.directionalAccuracy, 1);
  assert.equal(result.timesFm.directionalAccuracy, 1);
  assert.equal(result.allThreeCorrectRate, 1);
});

test('computeCommonCohortStats: same n (denominator) for every model -- the whole point of the shared cohort', () => {
  const triples = [1, 2, 3, 4, 5].map(ts => ({
    targetTs: ts,
    knn: knnRow(ts, { correct: ts % 2 === 0 }),
    challenger: challengerRow(ts, { realized_up: ts % 2 === 0 ? 1 : 0 }), // p_up_flat 0.7 -> predicts UP; correct iff realized_up===1
    timesFm: timesFmRow(ts, { correct: ts % 3 === 0 }),
  }));
  const result = computeCommonCohortStats(triples);
  // Each model's accuracy denominator is n=5, even though each model
  // disagrees on which specific rows it got right.
  assert.equal(result.n, 5);
  assert.equal(Math.round(result.knn.directionalAccuracy * 5), 2); // ts=2,4 -> 2 correct
  assert.equal(Math.round(result.timesFm.directionalAccuracy * 5), 1); // ts=3 -> 1 correct
});

test('computeCommonCohortStats: allThreeCorrectRate is stricter than any single model\'s own accuracy', () => {
  const triples = [
    { targetTs: 1, knn: knnRow(1, { correct: true }), challenger: challengerRow(1, { realized_up: 1 }), timesFm: timesFmRow(1, { correct: false }) },
    { targetTs: 2, knn: knnRow(2, { correct: true }), challenger: challengerRow(2, { realized_up: 1 }), timesFm: timesFmRow(2, { correct: true }) },
  ];
  const result = computeCommonCohortStats(triples);
  assert.equal(result.knn.directionalAccuracy, 1); // k-NN got both right
  assert.equal(result.allThreeCorrectRate, 0.5); // but only 1 of 2 had all three right together
});

test('computeCommonCohortStats: Challenger MAE/RMSE remain N/A even inside the common cohort', () => {
  const triples = [{ targetTs: 1, knn: knnRow(1), challenger: challengerRow(1), timesFm: timesFmRow(1) }];
  const result = computeCommonCohortStats(triples);
  assert.equal(result.challenger.mae, null);
  assert.equal(result.challenger.rmse, null);
});

test('computeCommonCohortStats: k-NN and TimesFM MAE/RMSE only use rows where a magnitude actually exists', () => {
  const triples = [
    { targetTs: 1, knn: knnRow(1, { expectedMove: null }), challenger: challengerRow(1), timesFm: timesFmRow(1) },
    { targetTs: 2, knn: knnRow(2, { expectedMove: 3, actualMove: 1 }), challenger: challengerRow(2), timesFm: timesFmRow(2, { absolute_error: null }) },
  ];
  const result = computeCommonCohortStats(triples);
  assert.equal(result.knn.maeN, 1); // only triple 2 has both expectedMove and actualMove
  assert.equal(result.knn.mae, 2);
  assert.equal(result.timesFm.maeN, 1); // only triple 1 has a non-null absolute_error
});

// ---- buildComparison: common-cohort integration ----

test('buildComparison exposes commonCohort and dataIntegrity alongside the existing per-model stats', () => {
  const knnPredictions = [knnRow(1000, { ts: 900, direction: 'UP' })];
  const challengerRows = [{ coin: 'BTC', horizon_hours: 12, ts: 900, ...challengerRow(1000) }];
  const timesFmForecasts = [{ ...timesFmRow(1000), ts: 900, direction: 'UP', resolved: true }];
  const result = buildComparison('BTC', 12, { knnPredictions, challengerRows, timesFmForecasts });
  assert.equal(result.commonCohort.n, 1);
  assert.equal(result.commonCohort.knn.directionalAccuracy, 1);
  assert.deepEqual(result.dataIntegrity, {
    knnDuplicatesRemoved: 0, challengerDuplicatesRemoved: 0, timesFmDuplicatesRemoved: 0,
  });
});

test('buildComparison\'s common cohort dedupes duplicate target_ts rows before matching', () => {
  const knnPredictions = [knnRow(1000, { ts: 900 }), knnRow(1000, { ts: 901 })]; // duplicate target_ts
  const challengerRows = [{ coin: 'BTC', horizon_hours: 12, ts: 900, ...challengerRow(1000) }];
  const timesFmForecasts = [{ ...timesFmRow(1000), ts: 900, direction: 'UP', resolved: true }];
  const result = buildComparison('BTC', 12, { knnPredictions, challengerRows, timesFmForecasts });
  assert.equal(result.dataIntegrity.knnDuplicatesRemoved, 1);
  assert.equal(result.commonCohort.n, 1); // still exactly one triple, not two
});

// ---- exported constants sanity ----

test('PRELIMINARY_SAMPLE_THRESHOLD is a positive number the UI can compare n against', () => {
  assert.ok(PRELIMINARY_SAMPLE_THRESHOLD > 0);
});

test('DIRECTION_CONVENTION_NOTE documents both the shared realized-outcome definition and the per-model predicted-direction difference', () => {
  assert.match(DIRECTION_CONVENTION_NOTE, /realized return > 0/);
  assert.match(DIRECTION_CONVENTION_NOTE, /p_up/);
  assert.match(DIRECTION_CONVENTION_NOTE, /TimesFM/);
});
