import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePrediction, normalizeSelection, normalizePricePoint, normalizeTimesFmForecast } from '../api/normalize.js';

test('missing prediction -> unavailable, not a fabricated default', () => {
  const result = normalizePrediction({});
  assert.equal(result.available, false);
});

test('null prediction -> unavailable', () => {
  const result = normalizePrediction(null);
  assert.equal(result.available, false);
});

test('missing p_up but a real direction field -> shows direction, does not invent confidence', () => {
  const result = normalizePrediction({ ts: Date.now(), direction: 'up' });
  assert.equal(result.available, true);
  assert.equal(result.direction, 'UP');
  assert.equal(result.p_up, null);
  assert.equal(result.confidence, null, 'confidence must not be a guessed 70/75 when no p_up or confidence field exists');
});

test('invalid p_up (out of [0,1] range) is rejected outright, not clamped', () => {
  const result = normalizePrediction({ ts: Date.now(), p_up: 1.7 });
  assert.equal(result.available, false);
});

test('negative p_up is rejected', () => {
  const result = normalizePrediction({ ts: Date.now(), p_up: -0.1 });
  assert.equal(result.available, false);
});

test('valid p_up produces direction and confidence derived from it, no invented expectedMove', () => {
  const result = normalizePrediction({ ts: Date.now(), p_up: 0.63 });
  assert.equal(result.available, true);
  assert.equal(result.direction, 'UP');
  assert.equal(result.confidence, 26); // |0.63-0.5|*2*100
  assert.equal(result.expectedMove, null, 'missing expected move must be null, not "0.00"');
});

test('missing timestamp -> unavailable (freshness can never be assessed for an invented "now")', () => {
  const result = normalizePrediction({ p_up: 0.6 });
  assert.equal(result.available, false);
});

test('pending prediction (no correct/realized_up field) has correct=null, not false', () => {
  const result = normalizePrediction({ ts: Date.now(), p_up: 0.6 });
  assert.equal(result.correct, null);
});

test('resolved prediction derives correct from realized_up vs direction', () => {
  const up = normalizePrediction({ ts: Date.now(), p_up: 0.6, realized_up: 1 });
  assert.equal(up.correct, true);
  const wrong = normalizePrediction({ ts: Date.now(), p_up: 0.6, realized_up: 0 });
  assert.equal(wrong.correct, false);
});

test('explicit correct field is honored as-is', () => {
  const result = normalizePrediction({ ts: Date.now(), p_up: 0.6, correct: false });
  assert.equal(result.correct, false);
});

test('normalizeSelection: no variant name field at all -> unavailable, no "Original k-NN" guess', () => {
  const result = normalizeSelection({ ts: Date.now() });
  assert.equal(result.available, false);
});

test('normalizeSelection: accepts legitimate field-name aliases without inventing values', () => {
  const a = normalizeSelection({ ts: Date.now(), chosen_variant: 'calibrated' });
  const b = normalizeSelection({ ts: Date.now(), selected_variant: 'calibrated' });
  const c = normalizeSelection({ ts: Date.now(), model_name: 'calibrated' });
  assert.equal(a.variant, 'calibrated');
  assert.equal(b.variant, 'calibrated');
  assert.equal(c.variant, 'calibrated');
});

test('normalizeSelection: chosen_p_up passed through only when valid', () => {
  const valid = normalizeSelection({ ts: Date.now(), chosen_variant: 'original', chosen_p_up: 0.7 });
  assert.equal(valid.chosen_p_up, 0.7);
  const invalid = normalizeSelection({ ts: Date.now(), chosen_variant: 'original', chosen_p_up: 5 });
  assert.equal(invalid.chosen_p_up, null);
});

test('normalizePricePoint: no valid price field -> unavailable', () => {
  const result = normalizePricePoint({ ts: Date.now() });
  assert.equal(result.available, false);
});

test('normalizePricePoint: zero/negative price rejected', () => {
  assert.equal(normalizePricePoint({ ts: Date.now(), price: 0 }).available, false);
  assert.equal(normalizePricePoint({ ts: Date.now(), price: -5 }).available, false);
});

test('normalizePricePoint: accepts coin-specific field aliases', () => {
  assert.equal(normalizePricePoint({ ts: Date.now(), btc_price: 80000 }).price, 80000);
  assert.equal(normalizePricePoint({ ts: Date.now(), link_price: 15 }).price, 15);
  assert.equal(normalizePricePoint({ ts: Date.now(), eth_price: 2500 }).price, 2500);
});

function baseTimesFmRow(overrides = {}) {
  return {
    ts: Date.now(),
    target_ts: Date.now() + 12 * 3600 * 1000,
    coin: 'BTC',
    horizon_hours: 12,
    forecast_price: 91000,
    predicted_return_pct: 1.2,
    direction: 'UP',
    model_version: 'timesfm-2.5-200m',
    checkpoint: 'google/timesfm-2.5-200m-pytorch',
    ...overrides,
  };
}

test('normalizeTimesFmForecast: missing row -> unavailable', () => {
  assert.equal(normalizeTimesFmForecast(null).available, false);
  assert.equal(normalizeTimesFmForecast({}).available, false);
});

test('normalizeTimesFmForecast: missing forecast_price/predicted_return_pct/direction -> unavailable, never a fabricated forecast', () => {
  assert.equal(normalizeTimesFmForecast(baseTimesFmRow({ forecast_price: null })).available, false);
  assert.equal(normalizeTimesFmForecast(baseTimesFmRow({ predicted_return_pct: null })).available, false);
  assert.equal(normalizeTimesFmForecast(baseTimesFmRow({ direction: null })).available, false);
});

test('normalizeTimesFmForecast: an unresolved forecast (resolved_ts null) reports resolved=false and every actual/error/correct field as null -- never a guessed outcome', () => {
  const result = normalizeTimesFmForecast(baseTimesFmRow());
  assert.equal(result.available, true);
  assert.equal(result.resolved, false);
  assert.equal(result.actual_return_pct, null);
  assert.equal(result.actual_direction, null);
  assert.equal(result.correct, null);
  assert.equal(result.absolute_error, null);
  assert.equal(result.signed_error, null);
});

test('normalizeTimesFmForecast: a resolved forecast carries its real actual/error/correct fields through', () => {
  const result = normalizeTimesFmForecast(baseTimesFmRow({
    resolved_ts: Date.now(),
    actual_return_pct: 0.8,
    actual_direction: 'UP',
    correct: 1,
    absolute_error: 0.4,
    signed_error: 0.4,
  }));
  assert.equal(result.resolved, true);
  assert.equal(result.actual_return_pct, 0.8);
  assert.equal(result.actual_direction, 'UP');
  assert.equal(result.correct, true);
  assert.equal(result.absolute_error, 0.4);
});

test('normalizeTimesFmForecast: does not invent a confidence field -- TimesFM does not provide a probability here', () => {
  const result = normalizeTimesFmForecast(baseTimesFmRow());
  assert.equal('confidence' in result, false);
  assert.equal('p_up' in result, false);
});

test('normalizeTimesFmForecast: coin is carried through as-is, never assumed BTC when absent', () => {
  assert.equal(normalizeTimesFmForecast(baseTimesFmRow({ coin: null })).available, false);
});
