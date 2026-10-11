// api/dataquality.js -- data-quality status for the Lab's Overview, kept separate
// from the research outcome and from job execution.
//
// The rule that decides whether a series is current is PulseWorkerV2's own
// /prediction-freshness status (FRESH / STALE / NONE): V3 never re-derives or
// relaxes it. V3 adds three things on top:
//   1. the owner-agreed operating policy (BTC and LINK required; ETH best-effort
//      under the V2 Workers CPU budget), which decides whether a stale series is
//      a problem or a best-effort degradation;
//   2. verification: health is only "current" when it comes from a check that
//      succeeded recently; a failed or old check gives UNVERIFIED, never HEALTHY;
//   3. ordering: a response older than the one already held never replaces it.

export const OPERATING_POLICY = Object.freeze({
  version: '2026-10-11',
  required: Object.freeze(['BTC', 'LINK']),
  bestEffort: Object.freeze(['ETH']),
  note: 'BTC and LINK are required series. ETH is best-effort under the V2 Workers CPU budget (agreed operating policy): a stale ETH series is reported, but it is not a blocking data-quality problem.',
});

// A persistence check older than this cannot vouch for current health (V2 writes
// every 3 h; V3 re-checks at least every 30 min while the Lab is open).
export const VERIFY_MAX_AGE_MS = 45 * 60000;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Merge one fetch result into the held state for a source.
 * - Responses that complete out of order (lower request seq) are ignored.
 * - A successful response older (by backend generated_ts) than the held one is ignored.
 * - A failure keeps the last verified value, marked stale, with the error.
 * @param {object|null} prev   held state
 * @param {object} res          adapter result ({ok:true, generated_ts?, ...} or {ok:false, error})
 * @param {{seq:number, fetchedAt:number}} meta
 */
export function acceptSource(prev, res, { seq, fetchedAt }) {
  if (prev && isNum(prev.seq) && seq < prev.seq) return prev;
  if (res && res.ok !== false) {
    const asOf = isNum(res.generated_ts) ? res.generated_ts : fetchedAt;
    if (prev && prev.value && isNum(prev.asOf) && prev.asOf > asOf) {
      return { ...prev, seq, lastAttemptAt: fetchedAt, ignoredOlder: asOf };
    }
    return { value: res, asOf, verifiedAt: fetchedAt, seq, lastAttemptAt: fetchedAt, lastError: null, stale: false };
  }
  const error = (res && res.error) || 'unknown error';
  if (prev && prev.value) return { ...prev, seq, lastAttemptAt: fetchedAt, lastError: error, stale: true };
  return { value: null, asOf: null, verifiedAt: null, seq, lastAttemptAt: fetchedAt, lastError: error, stale: false };
}

const key = (r) => `${r.coin} ${r.horizon}h ${r.track}`;

/**
 * Data-quality status from the held freshness state.
 * @returns {{status:'HEALTHY'|'DEGRADED'|'PROBLEM'|'UNVERIFIED', reason:string, required:object[], bestEffort:object[],
 *            verifiedAt:number|null, asOf:number|null, lastKnown:string|null}}
 */
export function assessDataQuality(freshState, now = Date.now(), policy = OPERATING_POLICY, chartFailures = []) {
  const base = { required: [], bestEffort: [], verifiedAt: null, asOf: null, lastKnown: null, chartFailures };
  if (!freshState || !freshState.value) {
    return { ...base, status: 'UNVERIFIED', reason: `Prediction persistence cannot be verified: /prediction-freshness ${freshState && freshState.lastError ? `failed (${freshState.lastError})` : 'has not been read'}.` };
  }
  const rows = (freshState.value.rows || []).filter(r => r.track === 'core' || r.track === 'challenger');
  const notFresh = rows.filter(r => r.status !== 'FRESH');
  const required = notFresh.filter(r => policy.required.includes(r.coin));
  const bestEffort = notFresh.filter(r => policy.bestEffort.includes(r.coin));
  const describe = (list) => list.map(r => `${key(r)} ${String(r.status).toLowerCase()}${isNum(r.latest_ts) ? ` (last row ${new Date(r.latest_ts).toISOString().slice(0, 16).replace('T', ' ')} UTC)` : ''}`).join(', ');
  const summary = required.length ? `Required series not current: ${describe(required)}.`
    : bestEffort.length ? `All required series current. Best-effort series not current: ${describe(bestEffort)}.`
      : `All ${rows.length} V2 series (core and challenger) are saving on schedule.`;
  const out = { ...base, required, bestEffort, verifiedAt: freshState.verifiedAt, asOf: freshState.asOf, lastKnown: summary };
  const requiredChartFailures = chartFailures.filter(c => policy.required.includes(c.coin));
  const age = isNum(freshState.asOf) ? now - freshState.asOf : Infinity;
  if (freshState.stale || age > VERIFY_MAX_AGE_MS) {
    return { ...out, status: 'UNVERIFIED', reason: `Current health cannot be verified: the last successful check is from ${new Date(freshState.asOf).toISOString().slice(0, 16).replace('T', ' ')} UTC${freshState.lastError ? ` and the latest one failed (${freshState.lastError})` : ''}. Last known: ${summary}` };
  }
  if (required.length) return { ...out, status: 'PROBLEM', reason: summary };
  if (requiredChartFailures.length) {
    return { ...out, status: 'UNVERIFIED', reason: `Persistence is current, but V3 could not load ${requiredChartFailures.map(c => `${c.coin} ${c.horizon}h`).join(', ')} predictions, so their records cannot be checked.` };
  }
  if (bestEffort.length) return { ...out, status: 'DEGRADED', reason: `${summary} ${policy.note}` };
  return { ...out, status: 'HEALTHY', reason: summary };
}

/**
 * Incident history, kept separate from current health. Only a verified (non-stale,
 * recent) assessment opens or closes incidents, so a failed check never "resolves"
 * anything. Incidents close only when the series is reported FRESH by a verified check.
 */
export function updateIncidents(history, freshState, now = Date.now()) {
  const list = Array.isArray(history) ? history.map(x => ({ ...x })) : [];
  if (!freshState || !freshState.value || freshState.stale || !isNum(freshState.asOf) || now - freshState.asOf > VERIFY_MAX_AGE_MS) return list;
  for (const r of freshState.value.rows || []) {
    const k = key(r);
    const open = list.find(x => x.series === k && x.resolvedAt == null);
    if (r.status !== 'FRESH' && !open) list.push({ series: k, coin: r.coin, status: r.status, openedAt: freshState.asOf, lastRowTs: r.latest_ts ?? null, resolvedAt: null });
    if (r.status === 'FRESH' && open) open.resolvedAt = freshState.asOf;
  }
  return list.sort((a, b) => b.openedAt - a.openedAt).slice(0, 50);
}

export const DQ_LABEL = { HEALTHY: 'Healthy', DEGRADED: 'Degraded (best-effort series)', PROBLEM: 'Data quality problem', UNVERIFIED: 'Unable to verify' };
