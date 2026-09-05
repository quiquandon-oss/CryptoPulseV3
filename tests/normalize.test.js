import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePrediction, normalizeSelection, normalizePricePoint } from '../api/normalize.js';

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
