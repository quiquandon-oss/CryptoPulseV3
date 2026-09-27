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

// Below this many observations, the panel must still show the exact
// number (never hide it), but the UI labels the figure PRELIMINARY
// rather than presenting it as a settled result. Shared by the common
// cohort's n and the disagreement rate's nDays -- both are "how many
// shared observations back this number" questions, so one threshold
// covers both rather than maintaining two separate magic numbers doing
// the same job. There is no statistical basis for calling this an
// "insufficient data" wall the way TIMESFM_MIN_RESOLVED_FOR_EVAL is for
// the per-model gate, since a user explicitly asked to see the exact
// denominator at any size; this only controls advisory UI language,
// never whether a number is computed or displayed.
export const PRELIMINARY_SAMPLE_THRESHOLD = 20;

// Verified directly against each table's own resolution code (not
// assumed): predictions.realized_up (backfillPredictions, worker.js),
// challenger_predictions.realized_up (backfillChallengerPredictions,
// worker.js) and experiment_4_timesfm.actual_direction
// (exp004-timesfm/run_experiment.py resolve_pending) all define the
// REALIZED/actual outcome the same way -- realized_return > 0 is UP,
// otherwise DOWN. What differs, unavoidably, is how each model's own
// PREDICTED direction is derived: k-NN and Challenger threshold a
// probability (p_up / p_up_flat >= 0.5), while TimesFM thresholds the
// sign of its own predicted percent return (predicted_return_pct > 0).
// These are the models' own natural output types -- there is no way to
// force them into one representation without fabricating a probability
// TimesFM never produced, or a magnitude Challenger never produced.
// Exported so the UI states this once, from a single source, rather
// than re-describing it independently (and potentially inconsistently).
export const DIRECTION_CONVENTION_NOTE =
  'All three models\' actual/realized outcome is defined identically (realized return > 0 = UP). ' +
  'Predicted direction is each model\'s own natural output: k-NN and Challenger threshold a probability ' +
  '(p_up >= 0.5); TimesFM thresholds the sign of its predicted return (> 0).';

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

// Same 20%-of-horizon tolerance backfillPredictions/
// backfillChallengerPredictions/resolve_pending() (worker.js,
// exp004-timesfm/run_experiment.py) already use when matching a
// target_ts to a realized price -- reused here as the alignment
// tolerance for matching one model's target_ts to another's, so the
// common cohort uses the same notion of "close enough to the same
// target" the backend's own resolution logic already establishes,
// rather than an independently invented number.
export function cohortToleranceMs(horizonHours) {
  return horizonHours * 3600000 * 0.2;
}

// Verified against production D1 (2026-09-27): predictions,
// challenger_predictions and experiment_4_timesfm currently have zero
// duplicate target_ts rows for BTC at either horizon. This is
// nonetheless a real, disclosed data-integrity check, not a assumption
// -- and a defensive guard against a future regression (e.g. a retried
// write), not dead code. Keeps the FIRST-seen row per target_ts;
// duplicatesRemoved is reported so callers/tests can see the check ran
// and its result, rather than silently dropping rows.
export function dedupeByTargetTs(rows) {
  const seen = new Set();
  const deduped = [];
  let duplicatesRemoved = 0;
  for (const r of rows || []) {
    if (r.target_ts == null) { deduped.push(r); continue; } // nothing to key on -- pass through, not discarded
    if (seen.has(r.target_ts)) { duplicatesRemoved++; continue; }
    seen.add(r.target_ts);
    deduped.push(r);
  }
  return { rows: deduped, duplicatesRemoved };
}

function findNearestIndex(targetTs, rows, usedSet, toleranceMs) {
  let bestIndex = -1;
  let bestDist = Infinity;
  rows.forEach((r, i) => {
    if (usedSet.has(i) || r.target_ts == null) return;
    const dist = Math.abs(r.target_ts - targetTs);
    if (dist <= toleranceMs && dist < bestDist) { bestDist = dist; bestIndex = i; }
  });
  return bestIndex;
}

/**
 * Common evaluation cohort: the set of target timestamps where k-NN,
 * Challenger AND TimesFM all have a RESOLVED forecast within
 * cohortToleranceMs(horizonHours) of each other. TimesFM is the anchor
 * series -- it is by far the sparsest of the three (see
 * TIMESFM_MIN_RESOLVED_FOR_EVAL's own comment in index.html), so
 * anchoring on it and searching the denser k-NN/Challenger series for a
 * nearby match is the only direction that can produce real matches; the
 * reverse would mostly fail since TimesFM has so few target timestamps
 * to land near. Matching is transactional per anchor (a k-NN/Challenger
 * row is only marked used once BOTH sides of a triple are found), so a
 * near-miss on one side never wastes a row a later, better anchor could
 * have used.
 */
export function buildCommonCohort(knnResolved, challengerResolved, timesFmResolved, horizonHours) {
  const toleranceMs = cohortToleranceMs(horizonHours);
  const usedKnn = new Set();
  const usedChallenger = new Set();
  const triples = [];
  const anchors = (timesFmResolved || [])
    .filter(f => f.target_ts != null)
    .slice()
    .sort((a, b) => a.target_ts - b.target_ts);
  for (const anchor of anchors) {
    const knnIndex = findNearestIndex(anchor.target_ts, knnResolved || [], usedKnn, toleranceMs);
    if (knnIndex < 0) continue;
    const challengerIndex = findNearestIndex(anchor.target_ts, challengerResolved || [], usedChallenger, toleranceMs);
    if (challengerIndex < 0) continue;
    usedKnn.add(knnIndex);
    usedChallenger.add(challengerIndex);
    triples.push({ targetTs: anchor.target_ts, knn: knnResolved[knnIndex], challenger: challengerResolved[challengerIndex], timesFm: anchor });
  }
  return triples;
}

function challengerCorrectRow(row) {
  return (row.p_up_flat >= 0.5) === (Number(row.realized_up) === 1);
}

/**
 * Per-model directional accuracy AND (where the model provides one)
 * MAE/RMSE, computed ONLY on the shared common-cohort triples -- so all
 * three numbers share the exact same n and the exact same underlying
 * cycles, unlike each model's own independent full-history stats above.
 * Also reports allThreeCorrectRate (how often every model was right on
 * the same observation) as a secondary, clearly-labeled bonus figure --
 * never presented as "the" three-way accuracy on its own.
 */
export function computeCommonCohortStats(triples) {
  const n = triples.length;
  if (n === 0) {
    return { n: 0, knn: null, challenger: null, timesFm: null, allThreeCorrectRate: null };
  }
  const knnMagRows = triples.filter(t => t.knn.expectedMove != null && t.knn.actualMove != null);
  const knnErrors = knnMagRows.map(t => t.knn.expectedMove - t.knn.actualMove);
  const timesFmMagRows = triples.filter(t => t.timesFm.absolute_error != null);

  const knnCorrect = t => t.knn.correct === true;
  const challengerCorrect = t => challengerCorrectRow(t.challenger);
  const timesFmCorrect = t => t.timesFm.correct === true;

  return {
    n,
    knn: {
      directionalAccuracy: triples.filter(knnCorrect).length / n,
      maeN: knnMagRows.length,
      mae: knnMagRows.length ? mean(knnErrors.map(Math.abs)) : null,
      rmse: knnMagRows.length ? Math.sqrt(mean(knnErrors.map(e => e * e))) : null,
    },
    challenger: {
      directionalAccuracy: triples.filter(challengerCorrect).length / n,
      maeN: 0,
      mae: null,
      rmse: null,
    },
    timesFm: {
      directionalAccuracy: triples.filter(timesFmCorrect).length / n,
      maeN: timesFmMagRows.length,
      mae: timesFmMagRows.length ? mean(timesFmMagRows.map(t => t.timesFm.absolute_error)) : null,
      rmse: timesFmMagRows.length ? Math.sqrt(mean(timesFmMagRows.map(t => t.timesFm.absolute_error ** 2))) : null,
    },
    allThreeCorrectRate: triples.filter(t => knnCorrect(t) && challengerCorrect(t) && timesFmCorrect(t)).length / n,
  };
}

/**
 * Bundles the three per-model stat blocks (each model's own full
 * resolved history), the common-cohort comparison (all three restricted
 * to the same shared observations), and the disagreement rate for one
 * coin/horizon into the shape the comparison panel renders.
 * `knnPredictions` is Prediction[] for this exact horizon (from
 * fetchChartData), `challengerRows` is the raw /challenger-recent rows
 * (any coin/horizon -- filtered internally), `timesFmForecasts` is
 * TimesFmForecast[] for this exact horizon (from fetchTimesFmRecent).
 */
export function buildComparison(coin, horizonHours, { knnPredictions, challengerRows, timesFmForecasts }) {
  const challengerForHorizon = (challengerRows || []).filter(r => r.coin === coin && r.horizon_hours === horizonHours);

  const knnDedup = dedupeByTargetTs(knnPredictions);
  const challengerDedup = dedupeByTargetTs(challengerForHorizon);
  const timesFmDedup = dedupeByTargetTs(timesFmForecasts);

  const knnStats = computeKnnStats(knnDedup.rows);
  const challengerStats = computeChallengerStats(challengerDedup.rows, coin, horizonHours);
  const timesFmStats = computeTimesFmStats(timesFmDedup.rows);

  const knnObs = knnDedup.rows.filter(p => p.direction != null && p.ts != null)
    .map(p => ({ ts: p.ts, direction: p.direction }));
  const challengerObs = challengerToDirectionObs(challengerDedup.rows, coin, horizonHours);
  const timesFmObs = timesFmDedup.rows.filter(f => f.direction != null && f.ts != null)
    .map(f => ({ ts: f.ts, direction: f.direction }));

  const disagreement = computeDisagreementRate(knnObs, challengerObs, timesFmObs);

  const knnResolved = knnDedup.rows.filter(p => p.correct === true || p.correct === false);
  const challengerResolved = challengerDedup.rows.filter(r =>
    r.resolved_ts != null && r.realized_up != null && r.p_up_flat != null
  );
  const timesFmResolved = timesFmDedup.rows.filter(f => f.resolved && (f.correct === true || f.correct === false));
  const commonCohortTriples = buildCommonCohort(knnResolved, challengerResolved, timesFmResolved, horizonHours);
  const commonCohort = computeCommonCohortStats(commonCohortTriples);

  return {
    coin,
    horizonHours,
    models: [knnStats, challengerStats, timesFmStats],
    disagreement,
    commonCohort,
    dataIntegrity: {
      knnDuplicatesRemoved: knnDedup.duplicatesRemoved,
      challengerDuplicatesRemoved: challengerDedup.duplicatesRemoved,
      timesFmDuplicatesRemoved: timesFmDedup.duplicatesRemoved,
    },
  };
}
