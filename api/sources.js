// api/sources.js -- read-only adapters for the two other products V3 observes.
//
// V1 (PulseWorker, sentiment-ff75): composite history, the shadow weight
// adaptation report, and the Hyperliquid OI reading. V3 only READS these; it
// never posts weights, overrides, or model choices back to V1.
//
// V4 (cryptopulse-v4): only the public /api/performance aggregate. V3 must
// never call /api/portfolio* (private holdings, token-gated).

import { fetchWithTimeout } from './pulseworker.js';

export const V1_API_BASE = 'https://sentiment-ff75.quiquandon.workers.dev';
export const V4_API_BASE = 'https://cryptopulse-v4.quiquandon.workers.dev';
export const V4_COINS = ['BTC', 'ETH', 'LINK'];

const errText = (e) => (e && e.name === 'AbortError' ? 'timeout' : String((e && e.message) || e));

async function getJson(url) {
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, body: await res.json() };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/** Latest V1 composite row: ts, score, parsed per-source scores (numbers only). */
export function latestV1Reading(raw) {
  const rows = raw && Array.isArray(raw.history) ? raw.history : null;
  if (!rows || !rows.length) return { ok: false, error: 'no V1 history rows' };
  const last = rows[rows.length - 1];
  let sources = {};
  try { sources = last.sources_json ? JSON.parse(last.sources_json) : {}; } catch (_) { sources = {}; }
  const numeric = Object.fromEntries(Object.entries(sources || {}).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)));
  return { ok: true, ts: Number.isFinite(last.ts) ? last.ts : null, score: Number.isFinite(last.score) ? last.score : null, sources: numeric, rows: rows.length };
}

export async function fetchV1Latest({ apiBase = V1_API_BASE } = {}) {
  const r = await getJson(`${apiBase}/history`);
  return r.ok ? latestV1Reading(r.body) : r;
}

export async function fetchV1WeightAdaptation({ apiBase = V1_API_BASE } = {}) {
  const r = await getJson(`${apiBase}/weight-adaptation`);
  if (!r.ok) return r;
  const b = r.body;
  if (!b || b.ok === false || !b.defaults || !b.policy) return { ok: false, error: (b && b.error) || 'malformed response' };
  return b;
}

export async function fetchV1HlOi({ apiBase = V1_API_BASE } = {}) {
  const r = await getJson(`${apiBase}/hl-oi`);
  if (!r.ok) return r;
  return r.body && typeof r.body.status === 'string' ? r.body : { ok: false, error: 'malformed response' };
}

/** V4 performance_metrics rows for the coins V3 covers, fields renamed, nothing derived. */
export function normalizeV4Performance(raw) {
  if (!raw || !Array.isArray(raw.performance)) return { ok: false, error: 'malformed response' };
  const rows = raw.performance
    .filter(r => r && V4_COINS.includes(String(r.asset_id || '').toUpperCase()))
    .map(r => ({ coin: String(r.asset_id).toUpperCase(), horizon: r.horizon ?? null, regime: r.regime ?? 'ALL',
      status: r.status ?? null, samples: Number.isFinite(r.samples) ? r.samples : null,
      winRate: Number.isFinite(r.win_rate) ? r.win_rate : null }));
  return { ok: true, rows };
}

export async function fetchV4Performance({ apiBase = V4_API_BASE } = {}) {
  const r = await getJson(`${apiBase}/api/performance`);
  return r.ok ? normalizeV4Performance(r.body) : r;
}
