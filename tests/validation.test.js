import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSupportedCoin, isSupportedHorizon, isValidProbability,
  getFreshnessState, CRON_INTERVAL_MS,
} from '../api/validation.js';

test('supported coins are exactly BTC/LINK/ETH', () => {
  assert.equal(isSupportedCoin('BTC'), true);
  assert.equal(isSupportedCoin('LINK'), true);
  assert.equal(isSupportedCoin('ETH'), true);
  assert.equal(isSupportedCoin('DOGE'), false, 'must not silently accept an unsupported coin');
});

test('supported horizons are exactly 12 and 24 -- V3 must not invent others', () => {
  assert.equal(isSupportedHorizon(12), true);
  assert.equal(isSupportedHorizon(24), true);
  assert.equal(isSupportedHorizon(1), false);
  assert.equal(isSupportedHorizon(48), false);
});

test('isValidProbability rejects out-of-range and non-numeric values', () => {
  assert.equal(isValidProbability(0.5), true);
  assert.equal(isValidProbability(0), true);
  assert.equal(isValidProbability(1), true);
  assert.equal(isValidProbability(1.7), false);
  assert.equal(isValidProbability(-0.1), false);
  assert.equal(isValidProbability(NaN), false);
  assert.equal(isValidProbability('0.5'), false);
});

test('freshness: missing timestamp is UNAVAILABLE, never LIVE by default', () => {
  assert.equal(getFreshnessState(null, Date.now()), 'UNAVAILABLE');
  assert.equal(getFreshnessState(undefined, Date.now()), 'UNAVAILABLE');
});

test('freshness: within one cron cycle is LIVE', () => {
  const now = Date.now();
  assert.equal(getFreshnessState(now - 60000, now), 'LIVE');
});

test('freshness: beyond one cycle but within 1.5 cycles is RECENT', () => {
  const now = Date.now();
  assert.equal(getFreshnessState(now - CRON_INTERVAL_MS * 1.2, now), 'RECENT');
});

test('freshness: well beyond the cron cadence is STALE -- an old prediction must never look current', () => {
  const now = Date.now();
  assert.equal(getFreshnessState(now - CRON_INTERVAL_MS * 7, now), 'STALE'); // ~21h old, matches the reported "20h ago" scenario
});

test('freshness: a future timestamp (clock skew / corrupt data) is UNAVAILABLE, not LIVE', () => {
  const now = Date.now();
  assert.equal(getFreshnessState(now + 60000, now), 'UNAVAILABLE');
});
