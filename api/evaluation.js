// api/evaluation.js -- pure evaluation helpers for the V3 research dashboard.
//
// Every number shown on the Overview / Performance / Experiments / Factors
// views comes from these functions applied to live backend records. Nothing
// here fetches, writes, or invents data: a metric that cannot be computed
// honestly is returned as null with a reason.
//
// Conventions (normalizePrediction output): `correct` is null until the
// prediction has resolved; `direction` is 'UP'|'DOWN' from p_up >= 0.5;
// `actualMove` is the realized return in percent.

export const HOUR_MS = 3600000;
export const DAY_MS = 24 * HOUR_MS;
export const CRON_TICK_MS = 3 * HOUR_MS;
export const CRON_SLACK_MS = 5 * 60000;
export const LARGE_MOVE_PCT = 3;            // same 3% bar as the market-moves definition
export const MIN_LARGE_MOVES = 10;          // below this, large-move recall is "insufficient data"
export const MIN_TREND_PER_WINDOW = 20;     // resolved predictions needed in each 30-day window
export const TREND_WINDOW_DAYS = 30;
// Below this many resolved predictions a series' accuracy is not shown as a
// result (same bar as api/comparison.js PRELIMINARY_SAMPLE_THRESHOLD).
export const MIN_ACCURACY_SAMPLES = 20;

/** Rows written by the 3h cron are stamped within minutes of 00/03/.../21 UTC. */
export function isScheduled(ts) {
  return Number.isFinite(ts) && (ts % CRON_TICK_MS) < CRON_SLACK_MS;
}

export function isResolved(p) {
  return p != null && (p.correct === true || p.correct === false);
}

/** Realized direction of a resolved prediction (1 = up), derived from direction + correct. */
export function realizedUp(p) {
  if (!isResolved(p)) return null;
  return (p.direction === 'UP') === p.correct ? 1 : 0;
}

/** Wilson score interval, 95%. */
export function wilson(k, n, z = 1.96) {
  if (!n) return { lo: null, hi: null };
  const ph = k / n, d = 1 + z * z / n;
  const c = (ph + z * z / (2 * n)) / d;
  const h = (z * Math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n))) / d;
  return { lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

export function originSplit(preds) {
  let scheduled = 0, live = 0, pending = 0, resolved = 0;
  for (const p of preds) {
    if (isScheduled(p.ts)) scheduled++; else live++;
    if (isResolved(p)) resolved++; else pending++;
  }
  return { scheduled, live, resolved, pending };
}

/**
 * Directional accuracy on resolved predictions against the base-rate baseline
 * of the SAME cohort (always predicting that cohort's more frequent outcome).
 */
export function directionalStats(preds) {
  const r = preds.filter(isResolved);
  const n = r.length;
  if (!n) return { n: 0, accuracy: null, ci: { lo: null, hi: null }, baseline: null, delta: null, verdict: 'NO_DATA' };
  const hits = r.filter(p => p.correct).length;
  const ups = r.filter(p => realizedUp(p) === 1).length;
  const accuracy = hits / n, baseline = Math.max(ups, n - ups) / n, ci = wilson(hits, n);
  const verdict = ci.lo > baseline ? 'BEATS_BASELINE' : ci.hi < baseline ? 'BELOW_BASELINE' : 'WITHIN_NOISE';
  return { n, hits, accuracy, ci, baseline, baselineDirection: ups >= n - ups ? 'UP' : 'DOWN', delta: accuracy - baseline, verdict };
}

/** Brier score vs climatology (base-rate) Brier on the same resolved cohort. */
export function calibrationStats(preds) {
  const r = preds.filter(p => isResolved(p) && Number.isFinite(p.p_up));
  const n = r.length;
  if (n < 10) return { n, brier: null, climatology: null, skill: null };
  const ys = r.map(realizedUp);
  const pbar = ys.reduce((a, b) => a + b, 0) / n;
  const brier = r.reduce((a, p, i) => a + (p.p_up - ys[i]) ** 2, 0) / n;
  const climatology = pbar * (1 - pbar);
  return { n, brier, climatology, skill: climatology > 0 ? 1 - brier / climatology : null };
}

function normalCdf(x) {
  // Abramowitz-Stegun 7.1.26 on erf
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Last 30 days vs the previous 30 days, two-proportion z-test (by prediction time). */
export function trendStats(preds, now = Date.now(), windowDays = TREND_WINDOW_DAYS) {
  const w = windowDays * DAY_MS;
  const r = preds.filter(isResolved);
  const recent = r.filter(p => p.ts > now - w), prior = r.filter(p => p.ts <= now - w && p.ts > now - 2 * w);
  const k1 = recent.filter(p => p.correct).length, k0 = prior.filter(p => p.correct).length;
  const n1 = recent.length, n0 = prior.length;
  if (n1 < MIN_TREND_PER_WINDOW || n0 < MIN_TREND_PER_WINDOW) {
    return { n_recent: n1, n_prior: n0, recent: n1 ? k1 / n1 : null, prior: n0 ? k0 / n0 : null, p: null, verdict: 'INSUFFICIENT_DATA' };
  }
  const p1 = k1 / n1, p0 = k0 / n0, pp = (k1 + k0) / (n1 + n0);
  const se = Math.sqrt(pp * (1 - pp) * (1 / n1 + 1 / n0));
  const z = se > 0 ? (p1 - p0) / se : 0;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { n_recent: n1, n_prior: n0, recent: p1, prior: p0, p,
    verdict: p < 0.05 ? (p1 > p0 ? 'IMPROVING' : 'DECLINING') : 'NO_SIGNIFICANT_CHANGE' };
}

/** Share of resolved large moves (|return| >= 3%) whose direction the model called. */
export function largeMoveStats(preds, thresholdPct = LARGE_MOVE_PCT) {
  const r = preds.filter(p => isResolved(p) && Number.isFinite(p.actualMove));
  const side = (up) => {
    const moves = r.filter(p => (up ? p.actualMove >= thresholdPct : p.actualMove <= -thresholdPct));
    const called = moves.filter(p => p.direction === (up ? 'UP' : 'DOWN')).length;
    return { moves: moves.length, called, recall: moves.length >= MIN_LARGE_MOVES ? called / moves.length : null,
      status: moves.length >= MIN_LARGE_MOVES ? 'OK' : 'INSUFFICIENT_DATA' };
  };
  return { thresholdPct, up: side(true), down: side(false), resolvedWithReturn: r.length };
}

const lbl = (c) => `${c.coin} ${c.horizon}h`;
const pctTxt = (x) => `${(x * 100).toFixed(1)}%`;

/**
 * Research outcome, one of IMPROVING | DETERIORATING (significant drop over time) |
 * NOT_IMPROVING (significantly below baseline) | INCONCLUSIVE | INSUFFICIENT_DATA |
 * UNVERIFIED (no V2 predictions could be loaded).
 * Computed from evaluation results only: data quality and job execution are
 * separate statuses and never change this one.
 * cells: [{coin, horizon, ok, error?, stats, trend}] (ok:false = series not loaded).
 */
export function overallStatus(cells) {
  const ok = cells.filter(c => c.ok !== false && c.stats);
  const missing = cells.filter(c => c.ok === false);
  if (cells.length && !ok.length) return { status: 'UNVERIFIED', reason: 'No V2 prediction series could be loaded, so the research outcome cannot be evaluated.' };
  const scope = missing.length ? ` Based on ${ok.length} of ${cells.length} series (${missing.map(lbl).join(', ')} not loaded).` : '';
  const withData = ok.filter(c => c.stats.n > 0);
  if (!withData.length) return { status: 'INSUFFICIENT_DATA', reason: `No resolved predictions are available yet, so nothing can be compared with the baseline.${scope}` };
  const beats = withData.filter(c => c.stats.verdict === 'BEATS_BASELINE');
  const below = withData.filter(c => c.stats.verdict === 'BELOW_BASELINE');
  const improving = withData.filter(c => c.trend && c.trend.verdict === 'IMPROVING');
  const declining = withData.filter(c => c.trend && c.trend.verdict === 'DECLINING');
  const trendable = withData.filter(c => c.trend && c.trend.verdict !== 'INSUFFICIENT_DATA');
  const pooled = withData.reduce((a, c) => ({ n: a.n + c.stats.n, hits: a.hits + c.stats.hits }), { n: 0, hits: 0 });
  const beatsTxt = beats.length ? ` ${beats.map(lbl).join(', ')} ${beats.length === 1 ? 'beats' : 'beat'} the baseline.` : '';
  if (declining.length) return { status: 'DETERIORATING', reason: `Accuracy fell significantly over the last 30 days vs the 30 days before for ${declining.map(lbl).join(', ')}.${scope}` };
  if (below.length && !beats.length) return { status: 'NOT_IMPROVING', reason: `Accuracy is significantly below the always-same-direction baseline for ${below.map(lbl).join(', ')}.${scope}` };
  if (improving.length && beats.length && !below.length) {
    return { status: 'IMPROVING', reason: `Accuracy rose significantly in the last 30 days vs the 30 days before (${improving.map(lbl).join(', ')}) and${beatsTxt.replace(/\.$/, '')} on ${pooled.n} resolved predictions.${scope}` };
  }
  if (!trendable.length) {
    return { status: 'INSUFFICIENT_DATA', reason: `Improvement over time cannot be measured yet: no coin/horizon has ${MIN_TREND_PER_WINDOW} resolved predictions in both the last 30 days and the 30 days before. Pooled accuracy so far ${pctTxt(pooled.hits / pooled.n)} on ${pooled.n} resolved.${beatsTxt}${scope}` };
  }
  return { status: 'INCONCLUSIVE', reason: `No significant change in accuracy over the last 30 days for the ${trendable.length} series that can be tested (pooled ${pctTxt(pooled.hits / pooled.n)} on ${pooled.n} resolved).${beatsTxt || ' No series is distinguishable from the always-same-direction baseline.'}${scope}` };
}

/** The same records as they stood at `asOf`: rows created by then, resolved only if their target had passed. */
export function predictionsAsOf(preds, asOf) {
  return preds.filter(p => p.ts <= asOf).map(p => (isResolved(p) && Number.isFinite(p.target_ts) && p.target_ts > asOf ? { ...p, correct: null } : p));
}

/**
 * Next point at which the 30-day trend test becomes possible for one series:
 * the earliest date D >= now where the prior window (D-60d, D-30d] already holds
 * MIN_TREND_PER_WINDOW predictions (all of which exist today) and the recent
 * window is projected to, at the scheduled rate observed over the last 7 days.
 * Returns null when not projectable (no rate, too little history).
 */
export function trendReadyDate(preds, now = Date.now(), windowDays = TREND_WINDOW_DAYS) {
  const w = windowDays * DAY_MS;
  const ts = preds.map(p => p.ts).filter(Number.isFinite).sort((a, b) => a - b);
  if (ts.length < MIN_TREND_PER_WINDOW) return null;
  const rate = preds.filter(p => isScheduled(p.ts) && p.ts > now - 7 * DAY_MS).length / 7; // per day
  const countIn = (lo, hi) => ts.filter(t => t > lo && t <= hi).length;
  const recentOk = (D) => countIn(D - w, now) + Math.max(0, (D - now) / DAY_MS) * rate >= MIN_TREND_PER_WINDOW;
  if (countIn(now - 2 * w, now - w) >= MIN_TREND_PER_WINDOW && recentOk(now)) return now;
  for (let i = MIN_TREND_PER_WINDOW - 1; i < ts.length; i++) {
    const D = ts[i] + w;
    if (D < now) continue;
    if (countIn(D - 2 * w, D - w) >= MIN_TREND_PER_WINDOW && recentOk(D)) return D;
  }
  return null;
}

/** Next meaningful review, only from actual schedules / observed rates; otherwise not estimable with a reason. */
export function nextReview({ cells, experiments, now = Date.now() }) {
  const events = [];
  for (const c of cells) {
    if (c.ok === false || !c.trend || c.trend.verdict !== 'INSUFFICIENT_DATA' || !c.preds) continue;
    const d = trendReadyDate(c.preds, now);
    if (d != null && d > now) events.push({ ts: d, text: `30-day trend test becomes possible for ${lbl(c)} (projected from existing history and the scheduled prediction rate of the last 7 days)` });
  }
  for (const e of experiments || []) {
    const eta = e.eta;
    if (eta && eta.estimable && !eta.reached && eta.eta_date) {
      const ts = Date.parse(eta.eta_date);
      if (Number.isFinite(ts) && ts >= now - DAY_MS) events.push({ ts, text: `${e.experiment_id} reaches its required sample (${eta.progress ?? '—'}/${eta.required ?? '—'}; backend linear projection)` });
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  if (!events.length) {
    return { date: null, text: 'Not yet estimable', why: 'No series has a projectable date for the 30-day trend test (too little history or no scheduled predictions in the last 7 days), and no registered experiment reports an estimable ETA.', later: [] };
  }
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  return { date: iso(events[0].ts), text: events[0].text, why: null, later: events.slice(1, 3).map(e => ({ date: iso(e.ts), text: e.text })) };
}

/** What changed vs the evaluation as of `asOfMs` ago, reconstructed from the same records. */
export function whatChanged({ cells, prevCells, overall, prevOverall, experiments, now = Date.now(), sinceMs = DAY_MS }) {
  const out = [];
  if (prevOverall && overall && prevOverall.status !== overall.status) {
    out.push(`Status changed from ${STATUS_LABEL[prevOverall.status] || prevOverall.status} to ${STATUS_LABEL[overall.status] || overall.status}.`);
  }
  const byKey = new Map((prevCells || []).map(c => [lbl(c), c]));
  let newly = 0; const per = [], bigMoves = [];
  for (const c of cells) {
    if (c.ok === false || !c.stats) continue;
    const p = byKey.get(lbl(c));
    const d = c.stats.n - (p && p.stats ? p.stats.n : 0);
    if (d > 0) { newly += d; per.push(`${lbl(c)} +${d}`); }
    if (p && p.stats && p.stats.verdict !== c.stats.verdict && p.stats.n && c.stats.n) {
      out.push(`${lbl(c)}: ${p.stats.verdict.replace(/_/g, ' ').toLowerCase()} → ${c.stats.verdict.replace(/_/g, ' ').toLowerCase()} (${pctTxt(p.stats.accuracy)} → ${pctTxt(c.stats.accuracy)}).`);
    }
    if (c.preds) {
      const big = c.preds.filter(x => isResolved(x) && Number.isFinite(x.actualMove) && Math.abs(x.actualMove) >= LARGE_MOVE_PCT && Number.isFinite(x.target_ts) && x.target_ts > now - sinceMs);
      if (big.length) bigMoves.push(`${lbl(c)} ${big.filter(x => x.direction === (x.actualMove > 0 ? 'UP' : 'DOWN')).length}/${big.length}`);
    }
  }
  if (bigMoves.length) out.push(`Large moves (≥${LARGE_MOVE_PCT}%) resolved, called in the right direction: ${bigMoves.join(', ')}.`);
  out.unshift(newly ? `${newly} prediction(s) resolved (${per.join(', ')}).` : 'No predictions resolved in this period.');
  const fresh = (experiments || []).filter(e => Number.isFinite(e.data_last_updated) && e.data_last_updated > now - sinceMs).map(e => e.experiment_id);
  if (fresh.length) out.push(`New experiment data recorded for ${fresh.join(', ')}.`);
  const meaningful = out.length > 1 || newly > 0;
  return meaningful ? out : ['No meaningful change in the last 24 hours.'];
}

export const STATUS_LABEL = { IMPROVING: 'Improving', DETERIORATING: 'Deteriorating', NOT_IMPROVING: 'Not improving', INCONCLUSIVE: 'Inconclusive', INSUFFICIENT_DATA: 'Insufficient data', UNVERIFIED: 'Unable to evaluate' };

/** At most three recommendations, each tied to observed evidence or an operational blocker. */
export function recommendations({ overall, cells, experiments, adaptation, review, dataQuality }) {
  const out = [];
  // Operational blockers come from data quality (required series only; best-effort series never block).
  if (dataQuality && dataQuality.status === 'PROBLEM') {
    for (const r of dataQuality.required) out.push({ kind: 'blocker', text: `Fix: ${r.coin} ${r.horizon}h ${r.track} predictions are ${String(r.status).toLowerCase()} (not saving on schedule). Evidence for that required series is not accumulating until it is resolved.` });
  } else if (dataQuality && dataQuality.status === 'UNVERIFIED') {
    out.push({ kind: 'blocker', text: `Restore verification: ${dataQuality.reason}` });
  }
  for (const e of (experiments || []).filter(x => x.suggested_status === 'READY_FOR_ANALYSIS')) {
    out.push({ kind: 'evidence', text: `Run the planned evaluation for ${e.experiment_id} (${e.progress_count ?? '—'}/${e.required_sample ?? '—'} samples). Meeting the threshold makes it eligible for evaluation, not successful.` });
  }
  for (const c of cells.filter(x => x.ok !== false && x.stats && x.stats.verdict === 'BELOW_BASELINE')) {
    out.push({ kind: 'evidence', text: `Review ${lbl(c)}: ${pctTxt(c.stats.accuracy)} is significantly below the always-${c.stats.baselineDirection} baseline (${pctTxt(c.stats.baseline)}, n=${c.stats.n}).` });
  }
  for (const c of cells.filter(x => x.ok !== false && x.trend && x.trend.verdict === 'DECLINING')) {
    out.push({ kind: 'evidence', text: `Investigate ${lbl(c)}: accuracy fell from ${pctTxt(c.trend.prior)} to ${pctTxt(c.trend.recent)} (p=${c.trend.p.toFixed(3)}).` });
  }
  const v = adaptation && adaptation.evaluation;
  if (v && v.verdict === 'IMPROVED') out.push({ kind: 'evidence', text: `Owner review of the proposed V1 weights: shadow ${v.shadow_hit_pct.toFixed(1)}% vs default ${v.baseline_hit_pct.toFixed(1)}% hit rate on ${v.samples_after} later samples (decision stays in V1).` });
  if (v && v.verdict === 'WORSE') out.push({ kind: 'evidence', text: 'Keep V1 default weights: the shadow proposal did worse than the defaults on later data.' });
  if (!out.length && overall && overall.status === 'INSUFFICIENT_DATA' && review && review.date) {
    out.push({ kind: 'evidence', text: `Keep collecting: ${review.text.charAt(0).toLowerCase()}${review.text.slice(1)} on ${review.date}.` });
  }
  return out.slice(0, 3);
}

// ---- Experiments -----------------------------------------------------------

export const EXPERIMENT_GROUPS = [
  { key: 'models', title: 'Prediction models & selection', ids: ['EXP-002', 'EXP-003', 'EXP-004', 'EXP-008'] },
  { key: 'sentiment', title: 'Sentiment effectiveness & weighting', ids: ['EXP-005', 'EXP-006', 'EXP-007', 'EXP-025'] },
  { key: 'signals', title: 'New market signals', ids: ['EXP-011', 'EXP-024', 'EXP-026', 'EXP-027', 'EXP-028'] },
  { key: 'combined', title: 'Combined-factor evaluation', ids: [] },
  { key: 'largemoves', title: 'Large-move early warning', ids: ['EXP-023', 'EXP-001'] },
  { key: 'controls', title: 'Controls & diagnostics', ids: ['EXP-009', 'EXP-010', 'EXP-012'] },
];

/** Group registry entries; ids are preserved, unknown ids land in "Other". */
export function groupExperiments(experiments) {
  const byId = new Map((experiments || []).map(e => [e.experiment_id, e]));
  const used = new Set();
  const groups = EXPERIMENT_GROUPS.map(g => ({ ...g, items: g.ids.filter(id => byId.has(id)).map(id => { used.add(id); return byId.get(id); }) }));
  const other = (experiments || []).filter(e => !used.has(e.experiment_id));
  if (other.length) groups.push({ key: 'other', title: 'Other', ids: other.map(e => e.experiment_id), items: other });
  return groups;
}

/**
 * Stage of an experiment, from registry fields only (no parsing of free text).
 * A met sample threshold means eligible for evaluation, never success.
 */
// decision-state-v1 (PulseWorkerV2 registry `decision`) -> stage keys used by the dashboard.
export const DECISION_STAGE_KEY = {
  COLLECTING: 'collecting', READY_FOR_EVALUATION: 'eligible', BLOCKED: 'blocked', EVALUATED_DECISION_PENDING: 'evaluated',
  REJECTED: 'rejected', IMPLEMENTED_RESEARCH_ONLY: 'implemented_research', IMPLEMENTED_PRODUCTION: 'implemented_production',
  PROPOSED: 'not_started', STAGING_ONLY: 'inactive', ON_DEMAND: 'diagnostic',
};

export function experimentStage(e) {
  if (!e) return { key: 'unknown', label: 'Unknown' };
  if (e.live_error) return { key: 'unavailable', label: 'Data unavailable' };
  // The backend's decision state is authoritative when sent; the derivation below is only for older registries.
  if (e.decision && e.decision.state) return { key: DECISION_STAGE_KEY[e.decision.state] || 'unknown', label: e.decision.label || e.decision.state, source: 'api' };
  if (e.conclusion) return { key: 'evaluated', label: 'Evaluated' };
  const st = String(e.status || '').toUpperCase();
  if (e.suggested_status === 'READY_FOR_ANALYSIS') return { key: 'eligible', label: 'Eligible for evaluation' };
  if (st === 'PROPOSED') return { key: 'not_started', label: 'Not started' };
  if (st === 'BUILT_NOT_ACTIVATED' || st === 'STAGING_ONLY') return { key: 'inactive', label: 'Not active in production' };
  if (st === 'ON_DEMAND_AUDIT') return { key: 'diagnostic', label: 'Diagnostic (on demand)' };
  return { key: 'collecting', label: 'Collecting data' };
}

export function operationalStatus(e) {
  const st = String(e && e.status || 'UNKNOWN').toUpperCase();
  const map = { ACCUMULATING: 'Collecting data', COLLECTING: 'Collecting data', PROPOSED: 'Proposed', BUILT_NOT_ACTIVATED: 'Built, not activated',
    STAGING_ONLY: 'Staging only', ON_DEMAND_AUDIT: 'On demand' };
  return map[st] || st.replace(/_/g, ' ').toLowerCase();
}

// ---- Factors ----------------------------------------------------------------

export const FACTOR_CATEGORIES = [
  { key: 'sentiment', title: 'Sentiment & news', ids: ['fng', 'cryptonews', 'macrogeo', 'geopolitics', 'regulatory', 'sosovalue', 'foufi'] },
  { key: 'derivatives', title: 'Derivatives & OI', ids: ['funding', 'longshort', 'hypefunding', 'hloi'] },
  { key: 'onchain', title: 'On-chain & flows', ids: ['onchain', 'etfflows', 'strc'] },
  { key: 'macro', title: 'Macro & markets', ids: ['global', 'oil', 'yield10y', 'usd', 'nasdaq', 'sp500', 'ninemag', 'gold'] },
];

/**
 * One entry per V1 source with four quantities kept separate:
 *  - configured weight (weight x confidence, from V1's defaults),
 *  - effective share: that weight renormalised over the sources present in the
 *    latest V1 reading (V1's own computeComposite arithmetic),
 *  - observed contribution: points of the latest composite it supplied,
 *  - measured predictive value: V1's leave-one-out change in next-24h BTC hit
 *    rate, only when it has at least policy.minSamples spaced samples.
 * A source absent from the reading (or hloi whenever /hl-oi is not OK) is
 * excluded: zero share, no contribution, weight redistributed to the others.
 */
export function factorRows(adaptation, reading, evidence, hloi) {
  const defaults = (adaptation && adaptation.defaults) || {};
  const configuredShares = (adaptation && adaptation.default_shares_pct) || {};
  const minSamples = (adaptation && adaptation.policy && adaptation.policy.minSamples) || 30;
  const minDelta = (adaptation && adaptation.policy && adaptation.policy.minDeltaPts) || 2;
  const values = (reading && reading.sources) || {};
  const hloiExcluded = !hloi || hloi.status !== 'OK';
  const excludedReason = (id) => {
    if (id === 'hloi' && hloiExcluded) return `Collecting history (${hloi && hloi.status ? hloi.status.replace(/_/g, ' ').toLowerCase() : 'status unavailable'}); excluded from the composite until 24h of history exists`;
    if (!reading) return 'Latest V1 reading unavailable';
    if (!Number.isFinite(values[id])) return 'No value in the latest V1 reading; excluded, weight redistributed';
    return null;
  };
  const ids = Object.keys(defaults);
  const present = ids.filter(id => !excludedReason(id));
  const wc = (id) => defaults[id][0] * defaults[id][1];
  const totalPresent = present.reduce((a, id) => a + wc(id), 0);
  const rows = ids.map(id => {
    const reason = excludedReason(id);
    const share = !reason && totalPresent > 0 ? wc(id) / totalPresent * 100 : null;
    const raw = Number.isFinite(values[id]) && !(id === 'hloi' && hloiExcluded) ? values[id] : null;
    const ev = evidence && evidence[id];
    const measured = ev && Number.isFinite(ev.delta_pts) && ev.samples >= minSamples;
    return {
      id, weight: defaults[id][0], confidence: defaults[id][1], configuredWeight: wc(id),
      configuredSharePct: Number.isFinite(configuredShares[id]) ? configuredShares[id] : null,
      contributing: !reason, excludedReason: reason, rawScore: raw,
      effectiveSharePct: share,
      contributionPts: share != null && raw != null ? raw * share / 100 : null,
      pushPts: share != null && raw != null ? (raw - 50) * share / 100 : null,
      predictive: measured
        ? { status: Math.abs(ev.delta_pts) >= minDelta ? (ev.delta_pts > 0 ? 'helps' : 'hurts') : 'no_effect', deltaPts: ev.delta_pts, samples: ev.samples, hitWith: ev.hit_with, hitWithout: ev.hit_without }
        : { status: 'insufficient', samples: ev && Number.isFinite(ev.samples) ? ev.samples : 0, required: minSamples },
      evidenceRaw: ev || null,
      v3IncrementalValue: null,
    };
  });
  const known = new Set(FACTOR_CATEGORIES.flatMap(c => c.ids));
  const cats = [...FACTOR_CATEGORIES, { key: 'other', title: 'Other', ids: ids.filter(id => !known.has(id)) }];
  return cats.map(c => {
    const r = c.ids.map(id => rows.find(x => x.id === id)).filter(Boolean);
    const contrib = r.filter(x => x.contributing);
    return { key: c.key, title: c.title, rows: r, total: r.length, contributingCount: contrib.length,
      configuredSharePct: r.reduce((a, x) => a + (x.configuredSharePct || 0), 0),
      effectiveSharePct: contrib.reduce((a, x) => a + (x.effectiveSharePct || 0), 0),
      contributionPts: contrib.some(x => x.contributionPts != null) ? contrib.reduce((a, x) => a + (x.contributionPts || 0), 0) : null,
      pushPts: contrib.some(x => x.pushPts != null) ? contrib.reduce((a, x) => a + (x.pushPts || 0), 0) : null };
  }).filter(c => c.rows.length);
}

/** Composite rebuilt from the rows (V1 arithmetic, without the Foufi driver boost) — a consistency check against V1's stored score. */
export function reconstructedComposite(categories) {
  const rows = categories.flatMap(c => c.rows).filter(r => r.contributionPts != null);
  return rows.length ? rows.reduce((a, r) => a + r.contributionPts, 0) : null;
}

export function adaptationNextAction(adaptation) {
  const v = adaptation && adaptation.evaluation && adaptation.evaluation.verdict;
  if (v === 'IMPROVED') return 'Eligible for owner approval in V1 Settings';
  if (v === 'WORSE') return 'Rollback: keep the default weights';
  if (v === 'NO_DIFFERENCE') return 'Continue in shadow mode';
  return 'Continue collecting evidence in shadow mode';
}

/** Evidence from the latest persisted shadow run, else the unsaved preview. */
export function adaptationEvidence(adaptation) {
  if (!adaptation) return { evidence: {}, n_samples: null, persisted: false, run_ts: null };
  if (adaptation.latest) return { evidence: adaptation.latest.evidence || {}, n_samples: adaptation.latest.n_samples ?? null, persisted: true, run_ts: adaptation.latest.run_ts ?? null };
  const p = adaptation.preview || {};
  return { evidence: p.evidence || {}, n_samples: Number.isFinite(p.n_samples) ? p.n_samples : null, persisted: false, run_ts: null };
}

/**
 * Combined-factor evaluation card. The only combined-factor evidence that
 * exists today is V1's leave-one-out test of its own composite against the
 * next-24h BTC direction; V3 predictions do not consume V1 factors, so their
 * incremental value to V3 is reported as not measured.
 */
export function combinedFactorCard(adaptation) {
  const q = 'Does the combined V1 composite call the next-24h BTC direction better with each factor than without it?';
  if (!adaptation) return { question: q, finding: 'V1 weight-adaptation report unavailable.', evidence: { key: 'unavailable', label: 'Data unavailable' }, next: 'Retry when V1 is reachable.', eta: null, v3: 'Not measured' };
  const { evidence, n_samples, persisted } = adaptationEvidence(adaptation);
  const pol = adaptation.policy || {};
  const min = pol.minSamples || 30, thr = pol.minDeltaPts || 2;
  const tested = Object.entries(evidence).filter(([, e]) => Number.isFinite(e && e.delta_pts));
  const helps = tested.filter(([, e]) => e.delta_pts >= thr).map(([id]) => id);
  const hurts = tested.filter(([, e]) => e.delta_pts <= -thr).map(([id]) => id);
  let finding, ev;
  if (!tested.length) {
    finding = `Not enough spaced samples yet (${n_samples ?? 0} of ${min} with a resolved 24h outcome).`;
    ev = { key: 'insufficient', label: 'Insufficient data' };
  } else {
    finding = `${tested.length} factor(s) tested on ≥${min} samples: ${helps.length} add ≥${thr} pts of hit rate (${helps.join(', ') || 'none'}), ${hurts.length} subtract (${hurts.join(', ') || 'none'}).`;
    ev = { key: 'inconclusive', label: 'In-sample only (not yet out of sample)' };
  }
  const v = adaptation.evaluation && adaptation.evaluation.verdict;
  if (v === 'IMPROVED') ev = { key: 'promising', label: 'Improved out of sample' };
  else if (v === 'WORSE') ev = { key: 'negative', label: 'Worse out of sample' };
  else if (v === 'NO_DIFFERENCE') ev = { key: 'inconclusive', label: 'No out-of-sample difference' };
  // V1 readings are written when V1 is used (plus the V2 archive), not on a
  // fixed schedule, so no sample-accrual rate is guaranteed: no ETA is projected.
  const eta = null;
  const etaWhy = n_samples != null && n_samples >= min ? null : 'V1 readings are not recorded on a fixed schedule, so no sample-accrual rate can be projected.';
  return { question: q, finding, evidence: ev, next: adaptationNextAction(adaptation), eta, etaWhy,
    persisted, v3: 'Not measured — V3 predictions do not use V1 factors yet' };
}
