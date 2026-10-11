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

/** cells: [{coin, horizon, stats: directionalStats, trend: trendStats}]; freshness: normalizePredictionFreshness output. */
export function overallStatus(cells, freshness) {
  const stale = [];
  if (freshness && freshness.ok) {
    for (const row of freshness.rows || []) {
      if (row.track === 'core' && (row.status === 'STALE' || row.status === 'NONE' || row.status === 'MISSING')) stale.push(`${row.coin} ${row.horizon}h`);
    }
  }
  if (stale.length) {
    return { status: 'BLOCKED', reason: `Predictions are not being saved on schedule for ${stale.join(', ')} — new evidence cannot accumulate until that is fixed.` };
  }
  const withData = cells.filter(c => c.stats && c.stats.n > 0);
  if (!withData.length) return { status: 'INCONCLUSIVE', reason: 'No resolved predictions are available yet, so there is nothing to compare with the baseline.' };
  const beats = withData.filter(c => c.stats.verdict === 'BEATS_BASELINE');
  const below = withData.filter(c => c.stats.verdict === 'BELOW_BASELINE');
  const improving = withData.filter(c => c.trend && c.trend.verdict === 'IMPROVING');
  const declining = withData.filter(c => c.trend && c.trend.verdict === 'DECLINING');
  const pooled = withData.reduce((a, c) => ({ n: a.n + c.stats.n, hits: a.hits + c.stats.hits }), { n: 0, hits: 0 });
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  if (declining.length || (below.length && !beats.length)) {
    const which = (declining.length ? declining : below).map(c => `${c.coin} ${c.horizon}h`).join(', ');
    return { status: 'NOT_IMPROVING', reason: declining.length
      ? `Accuracy fell significantly over the last 30 days for ${which}.`
      : `Accuracy is significantly below the always-same-direction baseline for ${which}.` };
  }
  if (improving.length && beats.length && !below.length) {
    return { status: 'IMPROVING', reason: `Accuracy rose significantly in the last 30 days (${improving.map(c => `${c.coin} ${c.horizon}h`).join(', ')}) and beats the baseline for ${beats.map(c => `${c.coin} ${c.horizon}h`).join(', ')}.` };
  }
  return { status: 'INCONCLUSIVE', reason: `Pooled accuracy ${pct(pooled.hits / pooled.n)} on ${pooled.n} resolved predictions; ${beats.length
    ? `${beats.map(c => `${c.coin} ${c.horizon}h`).join(', ')} beat${beats.length === 1 ? 's' : ''} the baseline, but there is no significant improvement over time yet.`
    : 'no coin/horizon is distinguishable from the always-same-direction baseline yet (differences are within noise).'}` };
}

// ---- Experiments -----------------------------------------------------------

export const EXPERIMENT_GROUPS = [
  { key: 'models', title: 'Prediction models & selection', ids: ['EXP-002', 'EXP-003', 'EXP-004', 'EXP-008'] },
  { key: 'sentiment', title: 'Sentiment effectiveness & weighting', ids: ['EXP-005', 'EXP-006', 'EXP-007', 'EXP-025'] },
  { key: 'signals', title: 'New market signals', ids: ['EXP-024', 'EXP-026', 'EXP-027', 'EXP-028'] },
  { key: 'combined', title: 'Combined-factor evaluation', ids: [] },
  { key: 'largemoves', title: 'Large-move early warning', ids: ['EXP-023', 'EXP-001'] },
  { key: 'controls', title: 'Controls & diagnostics', ids: ['EXP-009', 'EXP-010', 'EXP-011', 'EXP-012'] },
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

/** Scientific evidence status, kept separate from operational status. */
export function evidenceStatus(e) {
  if (!e) return { key: 'unknown', label: 'Unknown' };
  if (e.live_error) return { key: 'unavailable', label: 'Data unavailable' };
  const st = String(e.status || '').toUpperCase();
  const concl = String(e.conclusion || '').toLowerCase();
  if (concl) {
    if (/not replicat|no (incremental|significant)|fail|negative|worse|reject/.test(concl)) return { key: 'negative', label: 'Negative' };
    if (/improv|outperform|significant|promising|support/.test(concl)) return { key: 'promising', label: 'Promising' };
    return { key: 'inconclusive', label: 'Inconclusive' };
  }
  if (st === 'PROPOSED') return { key: 'not_started', label: 'Not started' };
  if (st === 'BUILT_NOT_ACTIVATED' || st === 'STAGING_ONLY') return { key: 'blocked', label: 'Not active in production' };
  if (e.suggested_status === 'READY_FOR_ANALYSIS') return { key: 'ready', label: 'Ready for analysis (not yet evaluated)' };
  if (st === 'ON_DEMAND_AUDIT') return { key: 'diagnostic', label: 'Diagnostic only' };
  return { key: 'insufficient', label: 'Insufficient data' };
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
 * One row per V1 source with the four quantities kept separate:
 * raw score, configured weight x confidence, effective share of the V1
 * composite, contribution to the latest V1 composite. Incremental value to
 * V3 predictions is not computed anywhere yet and is reported as such.
 */
export function factorRows(adaptation, latestSources, evidence) {
  const defaults = (adaptation && adaptation.defaults) || {};
  const shares = (adaptation && adaptation.default_shares_pct) || {};
  const ids = Object.keys(defaults);
  const known = new Set(FACTOR_CATEGORIES.flatMap(c => c.ids));
  const cats = [...FACTOR_CATEGORIES, { key: 'other', title: 'Other', ids: ids.filter(id => !known.has(id)) }];
  return cats.map(c => ({
    key: c.key, title: c.title,
    sharePct: c.ids.reduce((a, id) => a + (shares[id] || 0), 0),
    rows: c.ids.filter(id => defaults[id]).map(id => {
      const raw = latestSources && Number.isFinite(latestSources[id]) ? latestSources[id] : null;
      const share = Number.isFinite(shares[id]) ? shares[id] : null;
      const ev = evidence && evidence[id];
      return { id, rawScore: raw, configuredWeight: defaults[id][0], confidence: defaults[id][1], effectiveSharePct: share,
        compositePoints: raw != null && share != null ? raw * share / 100 : null,
        v1LeaveOneOut: ev && Number.isFinite(ev.delta_pts) ? { deltaPts: ev.delta_pts, samples: ev.samples } : null,
        v3IncrementalValue: null };
    }),
  })).filter(c => c.rows.length);
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
export function combinedFactorCard(adaptation, now = Date.now()) {
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
  const perDay = pol.sampleSpacingHours ? 24 / pol.sampleSpacingHours : null;
  let eta = null;
  if (n_samples != null && n_samples < min && perDay) {
    eta = new Date(now + Math.ceil((min - n_samples) / perDay) * DAY_MS).toISOString().slice(0, 10);
  }
  return { question: q, finding, evidence: ev, next: adaptationNextAction(adaptation), eta,
    persisted, v3: 'Not measured — V3 predictions do not use V1 factors yet' };
}

// ---- Daily summary -----------------------------------------------------------

/** Compact snapshot for "what changed since your last visit". */
export function snapshotOf(model) {
  return {
    ts: model.now, status: model.overall.status,
    resolved: model.cells.reduce((a, c) => a + (c.stats ? c.stats.n : 0), 0),
    ready: (model.experiments || []).filter(e => e.suggested_status === 'READY_FOR_ANALYSIS').map(e => e.experiment_id).sort(),
    statuses: Object.fromEntries((model.experiments || []).map(e => [e.experiment_id, e.status])),
  };
}

export function diffSnapshots(prev, cur) {
  if (!prev) return ['First visit on this browser — changes will be listed from your next visit.'];
  const out = [];
  if (prev.status !== cur.status) out.push(`Overall status changed from ${prev.status.replace('_', ' ').toLowerCase()} to ${cur.status.replace('_', ' ').toLowerCase()}.`);
  if (cur.resolved > prev.resolved) out.push(`${cur.resolved - prev.resolved} more prediction(s) resolved.`);
  for (const id of cur.ready) if (!prev.ready.includes(id)) out.push(`${id} now has enough data to analyse.`);
  for (const [id, st] of Object.entries(cur.statuses)) if (prev.statuses[id] && prev.statuses[id] !== st) out.push(`${id}: ${prev.statuses[id]} → ${st}.`);
  return out.length ? out : ['No meaningful change since your last visit.'];
}

/** Deterministic finding / limitation / next actions / milestone from live data. */
export function dailyFindings({ overall, cells, experiments, hloi, adaptation, now = Date.now() }) {
  const exps = experiments || [];
  const ready = exps.filter(e => e.suggested_status === 'READY_FOR_ANALYSIS');
  const best = cells.filter(c => c.stats && c.stats.n > 0).sort((a, b) => (b.stats.delta ?? -1) - (a.stats.delta ?? -1))[0];
  let finding;
  if (overall.status === 'BLOCKED') finding = overall.reason;
  else if (best && best.stats.verdict === 'BEATS_BASELINE') finding = `${best.coin} ${best.horizon}h predictions beat the baseline: ${(best.stats.accuracy * 100).toFixed(1)}% vs ${(best.stats.baseline * 100).toFixed(1)}% on ${best.stats.n} resolved.`;
  else if (ready.length) finding = `${ready.map(e => e.experiment_id).join(', ')} ${ready.length === 1 ? 'has' : 'have'} collected the required sample and can now be evaluated.`;
  else finding = overall.reason;
  let limitation;
  if (hloi && hloi.status && hloi.status !== 'OK') limitation = `Hyperliquid OI (new V1 source) is still collecting history (${hloi.status.replace(/_/g, ' ').toLowerCase()}); it is excluded from the composite until it has 24h of data.`;
  else if (overall.status !== 'IMPROVING') limitation = 'Resolved samples are still too small to show a statistically significant improvement.';
  else limitation = 'Improvement is measured on recent data only; it still needs to persist out of sample.';
  const actions = [];
  for (const e of ready.slice(0, 2)) actions.push(`Run the planned evaluation for ${e.experiment_id} (${e.title || e.display_label}).`);
  if (actions.length < 2 && adaptation) actions.push(`Automatic V1 weighting: ${adaptationNextAction(adaptation).toLowerCase()}.`);
  if (actions.length < 2) actions.push('Keep collecting resolved predictions; re-check the baseline comparison daily.');
  const dated = exps.filter(e => e.eta && e.eta.estimable && !e.eta.reached && e.eta.eta_date).sort((a, b) => a.eta.eta_date.localeCompare(b.eta.eta_date));
  const milestone = dated.length ? { date: dated[0].eta.eta_date, text: `${dated[0].experiment_id} reaches its required sample (${dated[0].eta.progress}/${dated[0].eta.required}; linear projection)` }
    : { date: null, text: 'No milestone date is estimable yet from the observed data rates.' };
  return { finding, limitation, actions: actions.slice(0, 2), milestone };
}
