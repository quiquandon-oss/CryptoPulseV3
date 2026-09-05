import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchChartData, fetchSelectionHistory } from '../api/pulseworker.js';

function mockFetchOnce(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = original; };
}

test('fetchChartData: unsupported coin is rejected without ever calling fetch', async () => {
  const restore = mockFetchOnce(() => { throw new Error('fetch should not have been called'); });
  try {
    const result = await fetchChartData('DOGE', 24);
    assert.equal(result.ok, false);
  } finally { restore(); }
});

test('fetchChartData: unsupported horizon is rejected without ever calling fetch', async () => {
  const restore = mockFetchOnce(() => { throw new Error('fetch should not have been called'); });
  try {
    const result = await fetchChartData('BTC', 48);
    assert.equal(result.ok, false);
  } finally { restore(); }
});

test('fetchChartData: HTTP error status -> explicit failure, not a fabricated fallback', async () => {
  const restore = mockFetchOnce(async () => new Response('server error', { status: 500 }));
  try {
    const result = await fetchChartData('BTC', 24);
    assert.equal(result.ok, false);
    assert.match(result.error, /500/);
  } finally { restore(); }
});

test('fetchChartData: malformed/empty JSON body -> empty arrays, not synthetic rows', async () => {
  const restore = mockFetchOnce(async () => new Response(JSON.stringify({}), { status: 200 }));
  try {
    const result = await fetchChartData('BTC', 24);
    assert.equal(result.ok, true);
    assert.deepEqual(result.prices, []);
    assert.deepEqual(result.predictions, []);
  } finally { restore(); }
});

test('fetchChartData: invalid rows (bad p_up, missing ts) are dropped, not patched', async () => {
  const restore = mockFetchOnce(async () => new Response(JSON.stringify({
    prices: [{ ts: Date.now(), price: 100 }],
    predictions: [
      { ts: Date.now(), p_up: 1.7 },     // invalid -> dropped
      { p_up: 0.6 },                      // no ts -> dropped
      { ts: Date.now(), p_up: 0.6 },      // valid -> kept
    ],
  }), { status: 200 }));
  try {
    const result = await fetchChartData('BTC', 24);
    assert.equal(result.predictions.length, 1);
  } finally { restore(); }
});

test('fetchChartData: coin isolation -- BTC request hits the BTC endpoint only', async () => {
  let calledUrl = null;
  const restore = mockFetchOnce(async (url) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ prices: [], predictions: [] }), { status: 200 });
  });
  try {
    await fetchChartData('ETH', 24);
    assert.match(calledUrl, /\/eth-chart-data/);
    assert.doesNotMatch(calledUrl, /\/chart-data\?/); // not the bare BTC endpoint
    assert.doesNotMatch(calledUrl, /link-chart-data/);
  } finally { restore(); }
});

test('fetchChartData: horizon isolation -- the requested horizon is the one sent', async () => {
  let calledUrl = null;
  const restore = mockFetchOnce(async (url) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ prices: [], predictions: [] }), { status: 200 });
  });
  try {
    await fetchChartData('BTC', 12);
    assert.match(calledUrl, /horizon=12H/);
  } finally { restore(); }
});

test('fetchChartData: network failure produces an explicit error, never a thrown exception the caller must guess about', async () => {
  const restore = mockFetchOnce(async () => { throw new TypeError('Failed to fetch'); });
  try {
    const result = await fetchChartData('BTC', 24);
    assert.equal(result.ok, false);
    assert.ok(result.error);
  } finally { restore(); }
});

test('fetchSelectionHistory: a response with no variant name field on any row yields zero decisions, not guessed ones', async () => {
  const restore = mockFetchOnce(async () => new Response(JSON.stringify({
    decisions: [{ ts: Date.now() }],
  }), { status: 200 }));
  try {
    const result = await fetchSelectionHistory('BTC', 24);
    assert.equal(result.ok, true);
    assert.deepEqual(result.decisions, []);
  } finally { restore(); }
});
