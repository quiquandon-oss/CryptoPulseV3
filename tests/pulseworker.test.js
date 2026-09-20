import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchChartData, fetchSelectionHistory, fetchTimesFmRecent, fetchExperimentRegistry } from '../api/pulseworker.js';

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

test('fetchTimesFmRecent: unsupported horizon is rejected without ever calling fetch', async () => {
  const restore = mockFetchOnce(() => { throw new Error('fetch should not have been called'); });
  try {
    const result = await fetchTimesFmRecent(48);
    assert.equal(result.ok, false);
  } finally { restore(); }
});

test('fetchTimesFmRecent: hits /research/timesfm-recent with the requested horizon, BTC-only (no coin param needed)', async () => {
  let calledUrl = null;
  const restore = mockFetchOnce(async (url) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ ok: true, summary: { total: 0, resolved: 0, unresolved: 0 }, forecasts: [] }), { status: 200 });
  });
  try {
    await fetchTimesFmRecent(12);
    assert.match(calledUrl, /\/research\/timesfm-recent/);
    assert.match(calledUrl, /horizon=12/);
  } finally { restore(); }
});

test('fetchTimesFmRecent: zero resolved observations produces a real zero summary, never a fabricated nonzero default', async () => {
  const restore = mockFetchOnce(async () => new Response(JSON.stringify({
    ok: true,
    summary: { total: 4, resolved: 0, unresolved: 4 },
    forecasts: [],
  }), { status: 200 }));
  try {
    const result = await fetchTimesFmRecent(12);
    assert.equal(result.ok, true);
    assert.deepEqual(result.summary, { total: 4, resolved: 0, unresolved: 4 });
  } finally { restore(); }
});

test('fetchTimesFmRecent: an unresolved forecast row is kept, with resolved:false, never a fabricated outcome', async () => {
  const restore = mockFetchOnce(async () => new Response(JSON.stringify({
    ok: true,
    summary: { total: 1, resolved: 0, unresolved: 1 },
    forecasts: [{
      ts: Date.now(), target_ts: Date.now() + 12 * 3600 * 1000, coin: 'BTC', horizon_hours: 12,
      forecast_price: 91000, predicted_return_pct: 1.1, direction: 'UP',
      model_version: 'timesfm-2.5-200m', checkpoint: 'google/timesfm-2.5-200m-pytorch',
    }],
  }), { status: 200 }));
  try {
    const result = await fetchTimesFmRecent(12);
    assert.equal(result.forecasts.length, 1);
    assert.equal(result.forecasts[0].resolved, false);
    assert.equal(result.forecasts[0].correct, null);
  } finally { restore(); }
});

test('fetchTimesFmRecent: a row missing its forecast fields is dropped, not patched with defaults', async () => {
  const restore = mockFetchOnce(async () => new Response(JSON.stringify({
    ok: true,
    summary: { total: 1, resolved: 0, unresolved: 1 },
    forecasts: [{ ts: Date.now(), coin: 'BTC', horizon_hours: 12 }], // no forecast_price/predicted_return_pct/direction
  }), { status: 200 }));
  try {
    const result = await fetchTimesFmRecent(12);
    assert.equal(result.forecasts.length, 0);
  } finally { restore(); }
});

test('fetchTimesFmRecent: malformed response (no summary) -> explicit failure', async () => {
  const restore = mockFetchOnce(async () => new Response(JSON.stringify({}), { status: 200 }));
  try {
    const result = await fetchTimesFmRecent(12);
    assert.equal(result.ok, false);
  } finally { restore(); }
});

function baseRegistryRow(overrides = {}) {
  return {
    experiment_id: 'EXP-004', title: 'TimesFM BTC Challenger', research_question: 'q?', purpose: 'p',
    experiment_type: 'TYPE_2', expected_result: 'e', success_criterion: 's', status: 'ACCUMULATING',
    baseline: 'b', next_action: 'n',
    start_date: '2026-09-06', target_date: null, required_sample: 30,
    current_sample_size: { total_forecasts: 30, total_resolved: 28 },
    current_measured_result: { combined_correct_of_resolved: '12/28' },
    oos_result: 'INSUFFICIENT_SAMPLE', confidence_evidence_maturity: 'INSUFFICIENT_SAMPLE',
    conclusion: null, github_refs: null, last_updated: 1789819245336,
    ...overrides,
  };
}

test('fetchExperimentRegistry: hits /api/research-lab/registry, source of truth is PulseWorkerV2', async () => {
  let requestedUrl = null;
  const restore = mockFetchOnce(async (url) => {
    requestedUrl = url;
    return new Response(JSON.stringify({ ok: true, experiments: [] }), { status: 200 });
  });
  try {
    await fetchExperimentRegistry();
    assert.match(String(requestedUrl), /\/api\/research-lab\/registry$/);
  } finally { restore(); }
});

test('fetchExperimentRegistry: returns real experiment rows unmodified, never re-derives status client-side', async () => {
  const restore = mockFetchOnce(async () => new Response(JSON.stringify({
    ok: true, experiments: [baseRegistryRow()],
  }), { status: 200 }));
  try {
    const result = await fetchExperimentRegistry();
    assert.equal(result.ok, true);
    assert.equal(result.experiments.length, 1);
    assert.equal(result.experiments[0].status, 'ACCUMULATING');
    assert.equal(result.experiments[0].oos_result, 'INSUFFICIENT_SAMPLE');
  } finally { restore(); }
});

test('fetchExperimentRegistry: a PROPOSED/NOT_STARTED row is kept as-is, never backfilled with fake progress', async () => {
  const restore = mockFetchOnce(async () => new Response(JSON.stringify({
    ok: true,
    experiments: [baseRegistryRow({
      experiment_id: 'EXP-008', status: 'PROPOSED', start_date: null, required_sample: null,
      current_sample_size: 'NOT_STARTED', current_measured_result: 'NOT_AVAILABLE',
      oos_result: 'NOT_AVAILABLE', confidence_evidence_maturity: 'UNKNOWN',
    })],
  }), { status: 200 }));
  try {
    const result = await fetchExperimentRegistry();
    assert.equal(result.experiments[0].current_sample_size, 'NOT_STARTED');
    assert.equal(result.experiments[0].start_date, null);
  } finally { restore(); }
});

test('fetchExperimentRegistry: a row missing a required field is dropped, not patched with defaults', async () => {
  const restore = mockFetchOnce(async () => new Response(JSON.stringify({
    ok: true, experiments: [baseRegistryRow({ title: undefined })],
  }), { status: 200 }));
  try {
    const result = await fetchExperimentRegistry();
    assert.equal(result.experiments.length, 0);
  } finally { restore(); }
});

test('fetchExperimentRegistry: malformed response (no experiments array) -> explicit failure', async () => {
  const restore = mockFetchOnce(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  try {
    const result = await fetchExperimentRegistry();
    assert.equal(result.ok, false);
  } finally { restore(); }
});

test('fetchExperimentRegistry: HTTP error status -> explicit failure, not a fabricated fallback', async () => {
  const restore = mockFetchOnce(async () => new Response('server error', { status: 500 }));
  try {
    const result = await fetchExperimentRegistry();
    assert.equal(result.ok, false);
    assert.match(result.error, /500/);
  } finally { restore(); }
});
