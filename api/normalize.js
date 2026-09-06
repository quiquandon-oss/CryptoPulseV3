// Strict backend-field normalization. This module exists ONLY to absorb
// legitimate field-name differences across PulseWorkerV2 endpoints/response
// shapes (e.g. `chosen_variant` vs `selected_variant` vs `model_name` all
// meaning the same thing). It must NEVER invent a value a real backend
// response didn't provide -- see V3_ALIGNMENT_AUDIT.md items #1-#6, #16.
//
// Every normalize* function returns either:
//   { available: true, ... fields, with individual fields possibly still
//     null when the backend genuinely omitted them (e.g. direction known,
//     confidence not) }
// or:
//   { available: false, reason }
// Callers must render an explicit unavailable state for `available: false`
// and must never substitute a default value for an individual null field.

import { isValidProbability, isValidTimestamp } from './validation.js';

function coerceTimestamp(raw) {
  const ts = raw?.ts ?? raw?.timestamp ?? raw?.time ?? raw?.date;
  if (ts == null) return null;
  const ms = typeof ts === 'number' ? ts : new Date(ts).getTime();
  return isValidTimestamp(ms) ? ms : null;
}

function coerceDirection(rawDirection) {
  if (rawDirection == null) return null;
  const upper = String(rawDirection).toUpperCase();
  return upper === 'UP' || upper === 'DOWN' ? upper : null;
}

function coerceFiniteNumber(value) {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * @typedef {Object} Prediction
 * @property {boolean} available
 * @property {number} [ts]
 * @property {'UP'|'DOWN'|null} [direction]
 * @property {number|null} [p_up] - raw backend probability, 0..1, or null if absent/invalid
 * @property {number|null} [confidence] - 0..100, derived from p_up when valid, otherwise a genuine backend `confidence` field, otherwise null. Never a hardcoded guess.
 * @property {number|null} [expectedMove] - percent, or null if the backend didn't supply one
 * @property {number|null} [actualMove] - percent, null while unresolved
 * @property {boolean|null} [correct] - null means pending, not "wrong"
 */
export function normalizePrediction(raw) {
  if (!raw) return { available: false, reason: 'missing prediction' };

  const ts = coerceTimestamp(raw);
  if (ts == null) return { available: false, reason: 'prediction has no valid timestamp' };

  const rawPUp = coerceFiniteNumber(raw.p_up);
  const pUp = rawPUp != null && isValidProbability(rawPUp) ? rawPUp : null;
  if (raw.p_up != null && pUp == null) {
    // A p_up field was present but out of [0,1] (e.g. 1.7) -- reject it
    // outright rather than clamping, per the audit's explicit test case.
    return { available: false, reason: `invalid p_up: ${raw.p_up}` };
  }

  const direction = pUp != null ? (pUp >= 0.5 ? 'UP' : 'DOWN') : coerceDirection(raw.direction);
  if (direction == null) {
    // No directional signal at all -- there is nothing here worth calling
    // a prediction.
    return { available: false, reason: 'no p_up or direction field' };
  }

  const confidence = pUp != null
    ? Math.round(Math.abs(pUp - 0.5) * 2 * 100)
    : coerceFiniteNumber(raw.confidence);

  const expectedMove = coerceFiniteNumber(raw.median_analog_return ?? raw.expectedMove);
  const actualMove = coerceFiniteNumber(raw.real_return_pct ?? raw.actual_return ?? raw.realized_return ?? raw.actualMove);

  let correct = null;
  if (typeof raw.correct === 'boolean') {
    correct = raw.correct;
  } else if (raw.realized_up != null) {
    correct = direction === 'UP' === (Number(raw.realized_up) === 1);
  }

  return { available: true, ts, direction, p_up: pUp, confidence, expectedMove, actualMove, correct };
}

/**
 * @typedef {Object} SelectionDecision
 * @property {boolean} available
 * @property {number} [ts]
 * @property {string} [variant] - the actual chosen_variant string as returned by the backend
 * @property {number|null} [chosen_p_up] - the selected variant's own probability, when the backend supplied one
 */
export function normalizeSelection(raw) {
  if (!raw) return { available: false, reason: 'missing selection record' };

  const ts = coerceTimestamp(raw);
  if (ts == null) return { available: false, reason: 'selection record has no valid timestamp' };

  const variant = raw.chosen_variant || raw.selected_variant || raw.model_name || null;
  if (!variant) return { available: false, reason: 'no variant name field' };

  const rawChosenPUp = coerceFiniteNumber(raw.chosen_p_up);
  const chosen_p_up = rawChosenPUp != null && isValidProbability(rawChosenPUp) ? rawChosenPUp : null;

  return { available: true, ts, variant, chosen_p_up };
}

/**
 * @typedef {Object} ResolvedPricePoint
 * @property {boolean} available
 * @property {number} [ts]
 * @property {number} [price]
 */
export function normalizePricePoint(raw) {
  if (!raw) return { available: false, reason: 'missing price point' };

  const ts = coerceTimestamp(raw);
  if (ts == null) return { available: false, reason: 'price point has no valid timestamp' };

  const rawPrice = coerceFiniteNumber(raw.price ?? raw.btc_price ?? raw.link_price ?? raw.eth_price ?? raw.close);
  if (rawPrice == null || rawPrice <= 0) return { available: false, reason: 'no valid price field' };

  return { available: true, ts, price: rawPrice };
}

/**
 * @typedef {Object} TimesFmForecast
 * @property {boolean} available
 * @property {number} [ts] - when this forecast was made
 * @property {number} [target_ts] - the timestamp this forecast is for
 * @property {string} [coin]
 * @property {number} [horizon_hours]
 * @property {number|null} [forecast_price]
 * @property {number|null} [predicted_return_pct]
 * @property {'UP'|'DOWN'|null} [direction] - threshold on predicted_return_pct, NOT a probability -- TimesFM does not provide one here
 * @property {string|null} [model_version]
 * @property {string|null} [checkpoint]
 * @property {boolean} [resolved] - false means "pending", never treated as incorrect
 * @property {number|null} [actual_return_pct] - null while unresolved
 * @property {'UP'|'DOWN'|null} [actual_direction] - null while unresolved
 * @property {boolean|null} [correct] - null while unresolved, never fabricated as false
 * @property {number|null} [absolute_error] - null while unresolved
 * @property {number|null} [signed_error] - null while unresolved
 */
export function normalizeTimesFmForecast(raw) {
  if (!raw) return { available: false, reason: 'missing TimesFM forecast row' };

  const ts = coerceTimestamp(raw);
  if (ts == null) return { available: false, reason: 'TimesFM row has no valid ts' };

  const targetTs = isValidTimestamp(Number(raw.target_ts)) ? Number(raw.target_ts) : null;
  if (targetTs == null) return { available: false, reason: 'TimesFM row has no valid target_ts' };

  const coin = raw.coin || null;
  if (!coin) return { available: false, reason: 'TimesFM row has no coin field' };

  const horizonHours = coerceFiniteNumber(raw.horizon_hours);
  if (horizonHours == null) return { available: false, reason: 'TimesFM row has no valid horizon_hours' };

  const forecastPrice = coerceFiniteNumber(raw.forecast_price);
  const predictedReturnPct = coerceFiniteNumber(raw.predicted_return_pct);
  const direction = coerceDirection(raw.direction);
  if (forecastPrice == null || predictedReturnPct == null || direction == null) {
    return { available: false, reason: 'TimesFM row is missing its forecast (forecast_price/predicted_return_pct/direction)' };
  }

  const resolvedTs = raw.resolved_ts != null && isValidTimestamp(Number(raw.resolved_ts)) ? Number(raw.resolved_ts) : null;
  const resolved = resolvedTs != null;

  let correct = null;
  if (typeof raw.correct === 'number') correct = raw.correct === 1;
  else if (typeof raw.correct === 'boolean') correct = raw.correct;

  return {
    available: true,
    ts,
    target_ts: targetTs,
    coin,
    horizon_hours: horizonHours,
    price_at_prediction: coerceFiniteNumber(raw.price_at_prediction),
    forecast_price: forecastPrice,
    predicted_return_pct: predictedReturnPct,
    direction,
    model_version: raw.model_version || null,
    checkpoint: raw.checkpoint || null,
    resolved,
    resolved_ts: resolvedTs,
    actual_return_pct: resolved ? coerceFiniteNumber(raw.actual_return_pct) : null,
    actual_direction: resolved ? coerceDirection(raw.actual_direction) : null,
    correct: resolved ? correct : null,
    absolute_error: resolved ? coerceFiniteNumber(raw.absolute_error) : null,
    signed_error: resolved ? coerceFiniteNumber(raw.signed_error) : null,
  };
}

// Human-readable label for known variant keys/names. Falls back to the raw
// string as-is (still real backend data, just unmapped) -- never invents a
// name for a variant this map doesn't know about.
export const VARIANT_LABELS = {
  original: 'Original k-NN',
  experimental: 'Experimental (adaptive-K)',
  calibrated: 'k-NN Calibrated',
  challenger_flat: 'Challenger Flat',
  challenger_tilted: 'Challenger Tilted',
  challenger_calibrated: 'Challenger Calibrated',
  challenger_momentum: 'Challenger Momentum',
};

export function labelVariant(variant) {
  return VARIANT_LABELS[variant] || variant;
}
