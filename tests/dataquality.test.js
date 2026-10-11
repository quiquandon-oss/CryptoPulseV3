import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptSource, assessDataQuality, updateIncidents, OPERATING_POLICY, VERIFY_MAX_AGE_MS } from '../api/dataquality.js';

const NOW = Date.UTC(2026, 9, 11, 17, 30);
const H = 3600000;
const rows = (over = {}) => ['BTC', 'ETH', 'LINK'].flatMap(coin => ['12', '24'].flatMap(horizon => ['core', 'challenger'].map(track => ({
  coin, horizon, track, status: over[`${coin}-${horizon}`] || 'FRESH', latest_ts: NOW - 2 * H }))));
const fr = (over, gen = NOW - 60000) => ({ ok: true, generated_ts: gen, rows: rows(over) });

test('operating policy: BTC and LINK required, ETH best-effort', () => {
  assert.deepEqual([...OPERATING_POLICY.required], ['BTC', 'LINK']);
  assert.deepEqual([...OPERATING_POLICY.bestEffort], ['ETH']);
});

test('acceptSource: an out-of-order (older request) response never overwrites the held state', () => {
  const newer = acceptSource(null, fr({}, NOW - 1000), { seq: 2, fetchedAt: NOW });
  const late = acceptSource(newer, fr({ 'BTC-12': 'STALE' }, NOW - 9000), { seq: 1, fetchedAt: NOW + 5 });
  assert.equal(late, newer);
});

test('acceptSource: a response with an older backend timestamp is ignored even if it completes later', () => {
  const held = acceptSource(null, fr({}, NOW - 1000), { seq: 1, fetchedAt: NOW });
  const older = acceptSource(held, fr({ 'BTC-12': 'STALE' }, NOW - 50000), { seq: 2, fetchedAt: NOW + 10 });
  assert.equal(older.value, held.value); assert.equal(older.ignoredOlder, NOW - 50000);
});

test('acceptSource: a failure keeps the last verified value, marked stale with the error', () => {
  const held = acceptSource(null, fr({}), { seq: 1, fetchedAt: NOW });
  const failed = acceptSource(held, { ok: false, error: 'HTTP 503' }, { seq: 2, fetchedAt: NOW + 1000 });
  assert.equal(failed.value, held.value); assert.equal(failed.stale, true); assert.equal(failed.lastError, 'HTTP 503');
  const none = acceptSource(null, { ok: false, error: 'timeout' }, { seq: 1, fetchedAt: NOW });
  assert.equal(none.value, null);
});

test('assessDataQuality: healthy, best-effort degraded, required problem', () => {
  const st = (o) => acceptSource(null, fr(o), { seq: 1, fetchedAt: NOW });
  assert.equal(assessDataQuality(st({}), NOW).status, 'HEALTHY');
  const eth = assessDataQuality(st({ 'ETH-12': 'STALE' }), NOW);
  assert.equal(eth.status, 'DEGRADED'); assert.equal(eth.bestEffort.length, 2); assert.match(eth.reason, /best-effort/);
  const btc = assessDataQuality(st({ 'BTC-24': 'STALE', 'ETH-12': 'STALE' }), NOW);
  assert.equal(btc.status, 'PROBLEM'); assert.equal(btc.required.length, 2);
});

test('assessDataQuality: unverifiable health is never reported as healthy', () => {
  assert.equal(assessDataQuality(null, NOW).status, 'UNVERIFIED');
  const old = acceptSource(null, fr({}, NOW - VERIFY_MAX_AGE_MS - 1), { seq: 1, fetchedAt: NOW });
  assert.equal(assessDataQuality(old, NOW).status, 'UNVERIFIED');
  const held = acceptSource(null, fr({}), { seq: 1, fetchedAt: NOW });
  const failed = acceptSource(held, { ok: false, error: 'HTTP 503' }, { seq: 2, fetchedAt: NOW + 1 });
  const a = assessDataQuality(failed, NOW + 1);
  assert.equal(a.status, 'UNVERIFIED'); assert.match(a.reason, /HTTP 503/); assert.match(a.reason, /Last known/);
});

test('a warning clears only after a verified recovery', () => {
  let st = acceptSource(null, fr({ 'LINK-12': 'STALE' }), { seq: 1, fetchedAt: NOW });
  assert.equal(assessDataQuality(st, NOW).status, 'PROBLEM');
  st = acceptSource(st, { ok: false, error: 'timeout' }, { seq: 2, fetchedAt: NOW + 60000 });     // failed re-check
  assert.equal(assessDataQuality(st, NOW + 60000).status, 'UNVERIFIED');                       // not healthy
  st = acceptSource(st, fr({}, NOW + 110000), { seq: 3, fetchedAt: NOW + 120000 });             // verified FRESH
  assert.equal(assessDataQuality(st, NOW + 120000).status, 'HEALTHY');
});

test('chart load failure for a required series is unverifiable, for best-effort it is not escalated', () => {
  const st = acceptSource(null, fr({}), { seq: 1, fetchedAt: NOW });
  assert.equal(assessDataQuality(st, NOW, OPERATING_POLICY, [{ coin: 'BTC', horizon: 12 }]).status, 'UNVERIFIED');
  assert.equal(assessDataQuality(st, NOW, OPERATING_POLICY, [{ coin: 'ETH', horizon: 12 }]).status, 'HEALTHY');
});

test('incident history: opened and closed only by verified checks, kept apart from current health', () => {
  const s1 = acceptSource(null, fr({ 'ETH-12': 'STALE' }), { seq: 1, fetchedAt: NOW });
  let h = updateIncidents([], s1, NOW);
  assert.equal(h.filter(i => i.resolvedAt == null).length, 2);
  const failed = acceptSource(s1, { ok: false, error: 'x' }, { seq: 2, fetchedAt: NOW + 1 });
  assert.deepEqual(updateIncidents(h, failed, NOW + 1), h);                                      // unverified: no change
  const s3 = acceptSource(s1, fr({}, NOW + 3 * H), { seq: 3, fetchedAt: NOW + 3 * H });
  h = updateIncidents(h, s3, NOW + 3 * H);
  assert.ok(h.every(i => i.resolvedAt === NOW + 3 * H));
  assert.equal(assessDataQuality(s3, NOW + 3 * H).status, 'HEALTHY');
});
