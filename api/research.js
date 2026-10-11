// Pure presentation helpers for the Research Lab registry and the V2
// prediction-persistence (operations) panel. Every function here only
// reformats fields PulseWorkerV2 already computed -- none of them derive a
// status, result, ETA, or verdict the backend did not send. Missing data
// renders as an explicit placeholder ('—' / "not yet estimable"), never as
// an invented number. Returned strings are plain text: callers escape.

export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;

// Default staleness bar for an experiment's latest real data. Weekly-cadence
// experiments (EXP-005 V1 source research, EXP-009, EXP-010) legitimately go
// several days between updates, so they get an 8-day bar instead.
export const DEFAULT_STALE_AFTER_MS = 36 * HOUR_MS;
export const WEEKLY_STALE_AFTER_MS = 8 * DAY_MS;
export const WEEKLY_CADENCE_EXPERIMENTS = new Set(['EXP-005', 'EXP-009', 'EXP-010']);

// Registry statuses grouped for the overview counts. Anything not listed
// falls into "other" and is still counted/shown under its own raw name.
export const STATUS_GROUPS = {
  running: new Set(['ACCUMULATING', 'COLLECTING', 'RUNNING']),
  proposed: new Set(['PROPOSED']),
  staging: new Set(['STAGING_ONLY', 'BUILT_NOT_ACTIVATED', 'BUILDING']),
  on_demand: new Set(['ON_DEMAND_AUDIT']),
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Display title: backend display_label, else "<id> · <title>". */
export function registryTitle(e) {
  if (e && typeof e.display_label === 'string' && e.display_label.trim()) return e.display_label;
  return `${e?.experiment_id ?? '—'} · ${e?.title ?? '—'}`;
}

/** "progress / required" only when both are real numbers, else null. */
export function formatProgress(progressCount, requiredSample) {
  if (!isNum(progressCount) || !isNum(requiredSample)) return null;
  return `${progressCount} / ${requiredSample}`;
}

/** Human ETA line from the backend's own `eta` object. */
export function formatEtaText(eta) {
  if (!eta || typeof eta !== 'object') return 'ETA not yet estimable — no ETA reported';
  if (eta.estimable === true && eta.reached === true) return 'Sample requirement met';
  if (eta.estimable === true && eta.reached === false && eta.eta_date) {
    const rate = isNum(eta.rate_per_day) ? `${+eta.rate_per_day.toFixed(2)}/day` : '—/day';
    return `ETA ≈ ${eta.eta_date} (${rate}, linear projection)`;
  }
  return `ETA not yet estimable — ${eta.reason || 'no reason given'}`;
}

/** Human status label: underscores -> spaces. Unknown statuses pass through. */
export function statusLabel(status) {
  return status == null ? '—' : String(status).replace(/_/g, ' ');
}

/**
 * Data-freshness classification for an experiment's data_last_updated.
 * @returns {{state:'none'|'fresh'|'stale', age_ms:number|null, threshold_ms:number}}
 */
export function classifyDataFreshness(experimentId, dataLastUpdated, now = Date.now()) {
  const threshold_ms = WEEKLY_CADENCE_EXPERIMENTS.has(experimentId) ? WEEKLY_STALE_AFTER_MS : DEFAULT_STALE_AFTER_MS;
  if (!isNum(dataLastUpdated)) return { state: 'none', age_ms: null, threshold_ms };
  const age_ms = Math.max(0, now - dataLastUpdated);
  return { state: age_ms > threshold_ms ? 'stale' : 'fresh', age_ms, threshold_ms };
}

function statusGroup(status) {
  for (const [group, set] of Object.entries(STATUS_GROUPS)) if (set.has(status)) return group;
  return 'other';
}

/**
 * Compact research overview computed only from registry fields.
 */
export function summarizeRegistry(experiments, now = Date.now()) {
  const list = Array.isArray(experiments) ? experiments : [];
  const byStatus = {};
  const groups = { running: 0, proposed: 0, staging: 0, on_demand: 0, other: 0 };
  const ready = [];
  const liveErrors = [];
  const stale = [];
  const awaitingEvidence = [];
  let latest = null;
  let latestId = null;
  for (const e of list) {
    const s = e.status == null ? 'UNKNOWN' : String(e.status);
    byStatus[s] = (byStatus[s] || 0) + 1;
    groups[statusGroup(s)] += 1;
    if (e.suggested_status === 'READY_FOR_ANALYSIS') ready.push(e.experiment_id);
    if (e.live_error) liveErrors.push({ experiment_id: e.experiment_id, error: String(e.live_error) });
    if (e.conclusion == null) awaitingEvidence.push(e.experiment_id);
    if (isNum(e.data_last_updated)) {
      if (latest == null || e.data_last_updated > latest) { latest = e.data_last_updated; latestId = e.experiment_id; }
      if (classifyDataFreshness(e.experiment_id, e.data_last_updated, now).state === 'stale') stale.push(e.experiment_id);
    }
  }
  return {
    total: list.length, byStatus, groups, ready, liveErrors, stale, awaitingEvidence,
    latest_data_update: latest, latest_data_experiment: latestId,
  };
}

export const FRESHNESS_COINS = ['BTC', 'ETH', 'LINK'];
export const FRESHNESS_HORIZONS = ['12', '24'];
export const FRESHNESS_TRACKS = ['core', 'challenger'];

/**
 * Flattens /prediction-freshness into table rows (coin x horizon x track),
 * in a fixed order. A missing cell becomes status 'MISSING' with null
 * fields rather than being dropped, so a gap is visible in the table.
 */
export function normalizePredictionFreshness(raw) {
  if (!raw || raw.ok === false || !raw.coins || typeof raw.coins !== 'object') {
    return { ok: false, error: raw?.error || 'malformed response' };
  }
  const expected = isNum(raw.expected_cron_ticks_24h) ? raw.expected_cron_ticks_24h : null;
  const rows = [];
  const coinKeys = [...FRESHNESS_COINS, ...Object.keys(raw.coins).filter((c) => !FRESHNESS_COINS.includes(c))];
  for (const coin of coinKeys) {
    const c = raw.coins[coin];
    if (!c) continue;
    for (const horizon of FRESHNESS_HORIZONS) {
      for (const track of FRESHNESS_TRACKS) {
        const cell = c.horizons?.[horizon]?.[track];
        const sha = typeof cell?.latest_git_commit_sha === 'string' ? cell.latest_git_commit_sha : null;
        rows.push({
          coin, horizon, track,
          status: typeof cell?.status === 'string' ? cell.status : 'MISSING',
          latest_ts: isNum(cell?.latest_ts) ? cell.latest_ts : null,
          latest_age_hours: isNum(cell?.latest_age_hours) ? cell.latest_age_hours : null,
          rows_24h: isNum(cell?.rows_24h) ? cell.rows_24h : null,
          cron_rows_24h: isNum(cell?.cron_rows_24h) ? cell.cron_rows_24h : null,
          commit: sha ? sha.slice(0, 7) : null,
        });
      }
    }
  }
  const counts = rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  return {
    ok: true,
    generated_ts: isNum(raw.generated_ts) ? raw.generated_ts : null,
    expected_cron_ticks_24h: expected,
    rows, counts,
  };
}
