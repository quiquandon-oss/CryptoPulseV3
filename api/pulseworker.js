// PulseWorkerV2 API adapter. This is the ONLY place in the frontend that
// should know the backend's endpoint shapes and field-name quirks --
// callers get back normalized, validated data or an explicit failure, never
// a fabricated fallback. See V3_ALIGNMENT_AUDIT.md.
//
// "PulseWorkerV2 is the source of truth. V3 is a visualization, monitoring,
// explanation and research-observability layer." -- nothing in this file
// invents a prediction, selection, or metric; it only reads and validates.

import { normalizePrediction, normalizeSelection, normalizePricePoint, normalizeTimesFmForecast, normalizeRegistryEntry } from './normalize.js';
import { isSupportedCoin, isSupportedHorizon } from './validation.js';

export const API_BASE = 'https://pulseworker-v2.quiquandon.workers.dev';
const DEFAULT_TIMEOUT_MS = 8000;

// Bounds every request so a slow/hung backend produces a fast, explicit
// failure instead of leaving the caller waiting indefinitely (this also
// matters for widget-host apps that snapshot the page shortly after load --
// see widget.html's own comment on the same issue).
export async function fetchWithTimeout(url, { timeoutMs = DEFAULT_TIMEOUT_MS, ...opts } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function describeError(e) {
  return e && e.name === 'AbortError' ? 'timeout' : String((e && e.message) || e);
}

const CHART_ENDPOINTS = { BTC: '/chart-data', LINK: '/link-chart-data', ETH: '/eth-chart-data' };

/**
 * @returns {{ ok: true, prices: ResolvedPricePoint[], predictions: Prediction[] } | { ok: false, error: string }}
 */
export async function fetchChartData(coin, horizon, { days = 7, apiBase = API_BASE } = {}) {
  if (!isSupportedCoin(coin)) return { ok: false, error: `unsupported coin: ${coin}` };
  if (!isSupportedHorizon(horizon)) return { ok: false, error: `unsupported horizon: ${horizon}` };
  try {
    const res = await fetchWithTimeout(`${apiBase}${CHART_ENDPOINTS[coin]}?days=${days}&horizon=${horizon}H`);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const raw = await res.json();
    // Invalid/incomplete rows are dropped here, not patched with defaults --
    // a row this adapter can't validate is a row V3 must not display.
    const prices = (raw.prices || []).map(normalizePricePoint).filter(p => p.available);
    const predictions = (raw.predictions || []).map(normalizePrediction).filter(p => p.available);
    return { ok: true, prices, predictions };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

/**
 * @returns {{ ok: true, decisions: SelectionDecision[] } | { ok: false, error: string }}
 */
export async function fetchSelectionHistory(coin, horizon, { limit = 50, apiBase = API_BASE } = {}) {
  if (!isSupportedCoin(coin)) return { ok: false, error: `unsupported coin: ${coin}` };
  if (!isSupportedHorizon(horizon)) return { ok: false, error: `unsupported horizon: ${horizon}` };
  try {
    const res = await fetchWithTimeout(`${apiBase}/selection-history?coin=${coin}&horizon=${horizon}H&limit=${limit}`);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const raw = await res.json();
    const list = Array.isArray(raw) ? raw : (raw.decisions || []);
    const decisions = list.map(normalizeSelection).filter(d => d.available);
    return { ok: true, decisions };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

// Research-only. `/challenger-recent` is read-only and never influences
// production selection (see PulseWorkerV2's SELECTION_VARIANTS, which never
// includes challenger_momentum). Rows are returned close to raw since the
// Lab tab needs challenger-specific fields (p_up_momentum, momentum_triggered,
// trend_strength) that normalizePrediction's production-shaped Prediction
// type doesn't model -- this function still validates the response envelope,
// it just doesn't force every research field through the same normalizer.
export async function fetchChallengerRecent({ limit = 100, apiBase = API_BASE } = {}) {
  try {
    const res = await fetchWithTimeout(`${apiBase}/challenger-recent?limit=${limit}`);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const raw = await res.json();
    if (!raw || raw.ok === false) return { ok: false, error: raw?.error || 'malformed response' };
    return { ok: true, predictions: Array.isArray(raw.predictions) ? raw.predictions : [] };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

// Research-only (Learning Roadmap Experiment 2). Never touches
// selection_decisions / chosen_variant.
export async function fetchAnomalyGateAudit({ apiBase = API_BASE } = {}) {
  try {
    const res = await fetchWithTimeout(`${apiBase}/research/anomaly-gate`);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const raw = await res.json();
    if (!raw || raw.ok === false || !raw.results) return { ok: false, error: raw?.error || 'malformed response' };
    return { ok: true, results: raw.results };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

// Research-only (Experiment 4: Google TimesFM research challenger).
// BTC-only, matching the experiment's actual scope -- see
// PulseWorkerV2's /research/timesfm-recent, which does not run inside
// the Worker at all and never touches selection_decisions/chosen_variant.
// summary.total/resolved/unresolved come straight from the backend's own
// aggregate; this adapter never derives or fabricates them client-side.
export async function fetchTimesFmRecent(horizon, { limit = 20, apiBase = API_BASE } = {}) {
  if (!isSupportedHorizon(horizon)) return { ok: false, error: `unsupported horizon: ${horizon}` };
  try {
    const res = await fetchWithTimeout(`${apiBase}/research/timesfm-recent?horizon=${horizon}&limit=${limit}`);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const raw = await res.json();
    if (!raw || raw.ok === false || !raw.summary) return { ok: false, error: raw?.error || 'malformed response' };
    const forecasts = (raw.forecasts || []).map(normalizeTimesFmForecast).filter(f => f.available);
    return {
      ok: true,
      summary: {
        total: Number.isFinite(raw.summary.total) ? raw.summary.total : 0,
        resolved: Number.isFinite(raw.summary.resolved) ? raw.summary.resolved : 0,
        unresolved: Number.isFinite(raw.summary.unresolved) ? raw.summary.unresolved : 0,
      },
      forecasts,
    };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

// Program Foundation Experiment Registry. PulseWorkerV2/D1 is the
// source of truth (research_experiment_registry, joined live against
// each experiment's own data table at request time -- see worker.js's
// getResearchLabRegistry) -- this adapter reads it, never writes, and
// never derives a status/result client-side that the backend itself
// didn't already compute.
export async function fetchExperimentRegistry({ apiBase = API_BASE } = {}) {
  try {
    const res = await fetchWithTimeout(`${apiBase}/api/research-lab/registry`);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const raw = await res.json();
    if (!raw || raw.ok === false || !Array.isArray(raw.experiments)) {
      return { ok: false, error: raw?.error || 'malformed response' };
    }
    const experiments = raw.experiments.map(normalizeRegistryEntry).filter((e) => e.available);
    return { ok: true, experiments };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

// Experiment 5: agentic market evidence. PulseWorkerV2/D1 is the source
// of truth (research_sentiment_archive + research_hypotheses, migrations
// 0008/0015 -- not yet applied to production as of this change) -- this
// adapter only reads what the backend already computed (activation
// state, counts, the deterministic plain-language narrative) and never
// derives a classification, decision, or comparison verdict itself.
// Because the migrations may not be applied yet, `activated: false` is
// an expected, valid response shape here, not an error.
export async function fetchExperiment5Overview({ apiBase = API_BASE } = {}) {
  try {
    const res = await fetchWithTimeout(`${apiBase}/api/research-lab/experiment5-overview`);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const raw = await res.json();
    if (!raw || raw.ok === false) return { ok: false, error: raw?.error || 'malformed response' };
    return raw;
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

export async function fetchExperiment5Results({ apiBase = API_BASE } = {}) {
  try {
    const res = await fetchWithTimeout(`${apiBase}/api/research-lab/experiment5-results`);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const raw = await res.json();
    if (!raw || raw.ok === false) return { ok: false, error: raw?.error || 'malformed response' };
    return raw;
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

// Cheap reachability probe for the Data Integrity panel -- hits the
// health-check root, does not imply anything about D1/prediction freshness
// on its own (that's derived from fetchChartData's own timestamps).
export async function pingBackend({ apiBase = API_BASE } = {}) {
  try {
    const res = await fetchWithTimeout(apiBase, { timeoutMs: 5000 });
    return { ok: res.ok };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}
