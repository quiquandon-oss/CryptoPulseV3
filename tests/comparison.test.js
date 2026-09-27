import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeKnnStats, computeChallengerStats, computeTimesFmStats,
  computeDisagreementRate, buildComparison, MIN_ALIGNED_DAYS_FOR_DISAGREEMENT,
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
