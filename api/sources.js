// api/sources.js -- read-only adapters for V1 data shown in V3's Factors tab.
//
// V1 (PulseWorker, sentiment-ff75): composite history, the shadow weight
// adaptation report, and the Hyperliquid OI reading. V3 only READS these; it
// never posts weights, overrides, or model choices back to V1. V1 owns
// sentiment scoring and source weights; V4 is a separate product and is not
// read here.

import { fetchWithTimeout } from './pulseworker.js';

export const V1_API_BASE = 'https://sentiment-ff75.quiquandon.workers.dev';

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
