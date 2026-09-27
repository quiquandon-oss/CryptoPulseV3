// Pure metric computation for the "Comparison · k-NN vs Challenger vs
// TimesFM (BTC)" research panel. Every function here takes rows this
// session already fetched and validated (Prediction[] from
// normalizePrediction, raw challenger_predictions rows, TimesFmForecast[]
// from normalizeTimesFmForecast) and returns only what that data
// actually supports -- never a fabricated MAE/RMSE for a model that only
// ever predicts a direction, and never a disagreement rate built from a
// handful of coincidental overlaps. See V3_ALIGNMENT_AUDIT.md's guiding
// rule: this file must never invent a value the backend didn't provide.

// Below this many UTC-day-aligned observations across all three models,
// computeDisagreementRate reports "not enough aligned days" rather than
// a number -- a deliberately conservative round number, same reasoning
// as TIMESFM_MIN_RESOLVED_FOR_EVAL in index.html.
export const MIN_ALIGNED_DAYS_FOR_DISAGREEMENT = 3;

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/**
 * k-NN (the production core model, `predictions` table via /chart-data).
 * Directional accuracy uses Prediction.correct (already resolved against
 * realized_up by normalizePrediction). MAE/RMSE compare
 * expectedMove (median_analog_return, the model's own predicted percent
 * move) against actualMove (realized_return) -- both real backend
 * fields, never derived from p_up alone.
 */
export function computeKnnStats(predictions) {
  const resolved = (predictions || []).filter(p => p.correct === true || p.correct === false);
  const magnitudeRows = resolved.filter(p => p.expectedMove != null && p.actualMove != null);
  const errors = magnitudeRows.map(p => p.expectedMove - p.actualMove);
  return {
    model: 'k-NN',
    n: resolved.length,
    directionalAccuracy: resolved.length ? resolved.filter(p => p.correct === true).length / resolved.length : null,
    maeN: magnitudeRows.length,
    mae: magnitudeRows.length ? mean(errors.map(Math.abs)) : null,
    rmse: magnitudeRows.length ? Math.sqrt(mean(errors.map(e => e * e))) : null,
    maeNote: null,
  };
}

/**
 * Challenger (challenger_predictions, the always-present p_up_flat
 * baseline -- NOT p_up_momentum, which is only populated on the small
 * subset of momentum-triggered cycles EXP-003 tracks separately).
 * Challenger only ever predicts a directional probability, never a
 * return magnitude, so MAE/RMSE are genuinely inapplicable here -- null
 * with maeNote explaining why, never 0 or an invented figure.
 */
export function computeChallengerStats(rows, coin, horizonHours) {
  const resolved = (rows || []).filter(r =>
    r.coin === coin && r.horizon_hours === horizonHours &&
    r.resolved_ts != null && r.realized_up != null && r.p_up_flat != null
  );
  const correctCount = resolved.filter(r => (r.p_up_flat >= 0.5) === (Number(r.realized_up) === 1)).length;
  return {
    model: 'Challenger',
    n: resolved.length,
    directionalAccuracy: resolved.length ? correctCount / resolved.length : null,
    maeN: 0,
    mae: null,
    rmse: null,
    maeNote: 'Challenger predicts a direction probability only (p_up_flat) -- it has no return-magnitude forecast, so MAE/RMSE cannot be computed.',
  };
}

/**
 * TimesFM (experiment_4_timesfm via /research/timesfm-recent). Reuses
 * the backend's own per-row absolute_error rather than recomputing it
 * client-side from predicted/actual returns.
 */
export function computeTimesFmStats(forecasts) {
  const resolved = (forecasts || []).filter(f => f.resolved && (f.correct === true || f.correct === false));
  const magnitudeRows = resolved.filter(f => f.absolute_error != null);
  return {
    model: 'TimesFM',
    n: resolved.length,
    directionalAccuracy: resolved.length ? resolved.filter(f => f.correct === true).length / resolved.length : null,
    maeN: magnitudeRows.length,
    mae: magnitudeRows.length ? mean(magnitudeRows.map(f => f.absolute_error)) : null,
    rmse: magnitudeRows.length ? Math.sqrt(mean(magnitudeRows.map(f => f.absolute_error ** 2))) : null,
    maeNote: null,
  };
}

function utcDateKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

// Reduces a list of {ts, direction} observations to one per UTC
// calendar day (the LATEST that day). k-NN/Challenger run on a shared
// ~3h cron cadence but TimesFM runs on its own independent GitHub
// Actions schedule -- there is no shared origin timestamp to align all
// three models on exactly, so the UTC day is the coarsest granularity
// they can be honestly compared at. This is a disclosed simplification,
// not a claim that same-day predictions were made at the same moment.
function latestDirectionPerDay(observations) {
  const byDay = new Map();
  for (const o of observations || []) {
    if (o.direction == null || o.ts == null) continue;
    const day = utcDateKey(o.ts);
    const existing = byDay.get(day);
    if (!existing || o.ts > existing.ts) byDay.set(day, o);
  }
  return byDay;
}

/**
 * Three-way disagreement rate across k-NN, Challenger and TimesFM,
 * aligned by UTC calendar day (see latestDirectionPerDay). Only days
 * where ALL THREE models have a directional observation count -- never
 * a two-model stand-in for a missing one. Returns
 * { nDays, disagreementRate: null } when fewer than
 * MIN_ALIGNED_DAYS_FOR_DISAGREEMENT such days exist, rather than a
 * rate computed from a handful of coincidental overlaps.
 */
export function computeDisagreementRate(knnObs, challengerObs, timesFmObs) {
  const knnByDay = latestDirectionPerDay(knnObs);
  const challengerByDay = latestDirectionPerDay(challengerObs);
  const timesFmByDay = latestDirectionPerDay(timesFmObs);

  const commonDays = [...knnByDay.keys()].filter(d => challengerByDay.has(d) && timesFmByDay.has(d));
  if (commonDays.length < MIN_ALIGNED_DAYS_FOR_DISAGREEMENT) {
    return { nDays: commonDays.length, disagreementRate: null };
  }
  const disagreeing = commonDays.filter(d => {
    const dirs = [knnByDay.get(d).direction, challengerByDay.get(d).direction, timesFmByDay.get(d).direction];
    return new Set(dirs).size > 1;
  });
  return { nDays: commonDays.length, disagreementRate: disagreeing.length / commonDays.length };
}

function challengerToDirectionObs(rows, coin, horizonHours) {
  return (rows || [])
    .filter(r => r.coin === coin && r.horizon_hours === horizonHours && r.p_up_flat != null && r.ts != null)
    .map(r => ({ ts: r.ts, direction: r.p_up_flat >= 0.5 ? 'UP' : 'DOWN' }));
}

/**
 * Bundles the three per-model stat blocks plus the disagreement rate
 * for one coin/horizon into the shape the comparison panel renders.
 * `knnPredictions` is Prediction[] for this exact horizon (from
 * fetchChartData), `challengerRows` is the raw /challenger-recent rows
 * (any coin/horizon -- filtered internally), `timesFmForecasts` is
 * TimesFmForecast[] for this exact horizon (from fetchTimesFmRecent).
 */
export function buildComparison(coin, horizonHours, { knnPredictions, challengerRows, timesFmForecasts }) {
  const knnStats = computeKnnStats(knnPredictions);
  const challengerStats = computeChallengerStats(challengerRows, coin, horizonHours);
  const timesFmStats = computeTimesFmStats(timesFmForecasts);

  const knnObs = (knnPredictions || []).filter(p => p.direction != null && p.ts != null)
    .map(p => ({ ts: p.ts, direction: p.direction }));
  const challengerObs = challengerToDirectionObs(challengerRows, coin, horizonHours);
  const timesFmObs = (timesFmForecasts || []).filter(f => f.direction != null && f.ts != null)
    .map(f => ({ ts: f.ts, direction: f.direction }));

  const disagreement = computeDisagreementRate(knnObs, challengerObs, timesFmObs);

  return { coin, horizonHours, models: [knnStats, challengerStats, timesFmStats], disagreement };
}
