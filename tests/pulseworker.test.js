import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchChartData, fetchSelectionHistory, fetchTimesFmRecent, fetchExperimentRegistry, fetchExperiment5Overview, fetchExperiment5Results, fetchPredictionFreshness } from '../api/pulseworker.js';

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

test('fetchExperiment5Overview: hits /api/research-lab/experiment5-overview', async () => {
  let requestedUrl = null;
  const restore = mockFetchOnce(async (url) => {
    requestedUrl = url;
    return new Response(JSON.stringify({ ok: true, activated: false, reason: 'not applied' }), { status: 200 });
  });
  try {
    await fetchExperiment5Overview();
    assert.match(String(requestedUrl), /\/api\/research-lab\/experiment5-overview$/);
  } finally { restore(); }
});

test('fetchExperiment5Overview: activated:false is a valid, passed-through response, never treated as an error', async () => {
  const restore = mockFetchOnce(async () => new Response(JSON.stringify({
    ok: true, activated: false, reason: 'Experiment 5 migrations are not yet applied to production D1.',
  }), { status: 200 }));
  try {
    const result = await fetchExperiment5Overview();
    assert.equal(result.ok, true);
    assert.equal(result.activated, false);
    assert.match(result.reason, /not yet applied/);
  } finally { restore(); }
});

test('fetchExperiment5Overview: real activated data (counts + narrative) passes through unmodified', async () => {
  const payload = {
    ok: true, activated: true,
    archive: { n_observations: 10, latest_observation_ts: 1000 },
    decisions: { proposed: 3, resolved: 1, passed: 1, failed: 0, inconclusive: 0 },
    pending_breakdown: { not_yet_eligible: 1, eligible_awaiting_resolution: 1 },
    narrative: ['10 sentiment observation(s) archived so far, most recently at 1970-01-01T00:00:01.000Z.'],
  };
  const restore = mockFetchOnce(async () => new Response(JSON.stringify(payload), { status: 200 }));
  try {
    const result = await fetchExperiment5Overview();
    assert.deepEqual(result, payload);
  } finally { restore(); }
});

test('fetchExperiment5Overview: HTTP error status -> explicit failure, not a fabricated fallback', async () => {
  const restore = mockFetchOnce(async () => new Response('server error', { status: 500 }));
  try {
    const result = await fetchExperiment5Overview();
    assert.equal(result.ok, false);
    assert.match(result.error, /500/);
  } finally { restore(); }
});

test('fetchExperiment5Results: hits /api/research-lab/experiment5-results', async () => {
  let requestedUrl = null;
  const restore = mockFetchOnce(async (url) => {
    requestedUrl = url;
    return new Response(JSON.stringify({ ok: true, activated: false, n_resolved: 0 }), { status: 200 });
  });
  try {
    await fetchExperiment5Results();
    assert.match(String(requestedUrl), /\/api\/research-lab\/experiment5-results$/);
  } finally { restore(); }
});

test('fetchExperiment5Results: insufficient-sample response passes through, never upgraded to a claim', async () => {
  const payload = {
    ok: true, activated: true, n_resolved: 3, agent_accuracy: 0.667, agent_n: 3,
    v1_baseline_accuracy: 0.333, v1_baseline_n: 3, min_sample_for_conclusion: 20,
    sufficient_sample: false, note: 'Not enough validated observations to draw a reliable conclusion (3 of 20 minimum resolved).',
  };
  const restore = mockFetchOnce(async () => new Response(JSON.stringify(payload), { status: 200 }));
  try {
    const result = await fetchExperiment5Results();
    assert.deepEqual(result, payload);
    assert.equal(result.sufficient_sample, false);
  } finally { restore(); }
});

test('fetchExperiment5Results: HTTP error status -> explicit failure, not a fabricated fallback', async () => {
  const restore = mockFetchOnce(async () => new Response('server error', { status: 500 }));
  try {
    const result = await fetchExperiment5Results();
    assert.equal(result.ok, false);
    assert.match(result.error, /500/);
  } finally { restore(); }
});

test('fetchExperimentRegistry: passes through new registry contract fields (display_label, eta, data_last_updated, suggested_status)', async () => {
  const eta = { estimable: true, reached: false, progress: 10, required: 60, rate_per_day: 2, eta_date: '2026-11-05', basis: 'linear' };
  const restore = mockFetchOnce(async () => new Response(JSON.stringify({
    ok: true, generated_ts: 1789819245336,
    experiments: [baseRegistryRow({
      experiment_id: 'EXP-011', display_label: 'EXP-011 · Experiment 5 — Agentic Market Evidence', aliases: ['Experiment 5'],
      registry_source: 'code', registry_updated_ts: 1789000000000, data_last_updated: null,
      progress_count: 10, eta, suggested_status: 'READY_FOR_ANALYSIS', live_error: 'D1 timeout',
    })],
  }), { status: 200 }));
  try {
    const result = await fetchExperimentRegistry();
    assert.equal(result.generated_ts, 1789819245336);
    const e = result.experiments[0];
    assert.equal(e.display_label, 'EXP-011 · Experiment 5 — Agentic Market Evidence');
    assert.deepEqual(e.aliases, ['Experiment 5']);
    assert.equal(e.registry_source, 'code');
    assert.equal(e.data_last_updated, null);
    assert.equal(e.registry_updated_ts, 1789000000000);
    assert.equal(e.progress_count, 10);
    assert.deepEqual(e.eta, eta);
    assert.equal(e.suggested_status, 'READY_FOR_ANALYSIS');
    assert.equal(e.status, 'ACCUMULATING');
    assert.equal(e.live_error, 'D1 timeout');
  } finally { restore(); }
});

test('fetchPredictionFreshness: hits /prediction-freshness and returns flattened rows', async () => {
  let requestedUrl = null;
  const restore = mockFetchOnce(async (url) => {
    requestedUrl = url;
    return new Response(JSON.stringify({
      ok: true, generated_ts: 1, expected_cron_ticks_24h: 8,
      coins: { BTC: { horizons: { 12: { core: { status: 'FRESH', rows_24h: 8, cron_rows_24h: 8, latest_git_commit_sha: 'abcdef1234' } } } } },
    }), { status: 200 });
  });
  try {
    const result = await fetchPredictionFreshness();
    assert.match(String(requestedUrl), /\/prediction-freshness$/);
    assert.equal(result.ok, true);
    assert.equal(result.rows[0].commit, 'abcdef1');
    assert.equal(result.rows[0].status, 'FRESH');
  } finally { restore(); }
});

test('fetchPredictionFreshness: HTTP error / network error -> explicit failure', async () => {
  let restore = mockFetchOnce(async () => new Response('nope', { status: 503 }));
  try {
    const result = await fetchPredictionFreshness();
    assert.equal(result.ok, false);
    assert.match(result.error, /503/);
  } finally { restore(); }
  restore = mockFetchOnce(async () => { throw new Error('network down'); });
  try {
    const result = await fetchPredictionFreshness();
    assert.equal(result.ok, false);
    assert.match(result.error, /network down/);
  } finally { restore(); }
});
