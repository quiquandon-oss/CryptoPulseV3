// ui/research-dashboard.js -- the Lab's four research tabs
// (Overview / Performance / Experiments / Factors).
//
// Every number is computed by api/evaluation.js from live records read from
// V2 (predictions, registry, persistence) and V1 (latest composite reading,
// shadow weight-adaptation report, Hyperliquid OI status). A metric that cannot
// be computed honestly renders as "Insufficient data" or "Unavailable".
// Nothing here writes to any backend; V1 owns sentiment scoring and weights,
// V2 owns prediction generation.
//
// The build/render functions are pure (data in, HTML string out) and are
// unit-tested in tests/research-dashboard.test.js; mountResearchDashboard() is
// the only DOM/network glue. The page header, Refresh Data button and bottom
// navigation belong to index.html -- this module renders no identity of its own.

import * as Ev from '../api/evaluation.js';
import { formatEtaText, registryTitle } from '../api/research.js';
import * as DQ from '../api/dataquality.js';
import * as C from '../api/controls.js';
import { renderControls, renderExecutionTile, summarizeModelChange } from './research-controls.js';

export const COINS = ['BTC', 'ETH', 'LINK'];
export const HORIZONS = [12, 24];
export const REFRESH_MS = 30 * 60000;
export const TABS = [['overview', 'Overview'], ['performance', 'Performance'], ['experiments', 'Experiments'], ['factors', 'Factors']];
const CHART_ENDPOINT = { BTC: '/chart-data', ETH: '/eth-chart-data', LINK: '/link-chart-data' };

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (x, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : null);
const pts = (x, d = 1) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)} pts` : null);
const num = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : null);
const dt = (ts) => (Number.isFinite(ts) ? new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');
const INSUF = '<span class="rd-muted">Insufficient data</span>';
const UNAV = '<span class="rd-muted">Unavailable</span>';
const verdictTxt = (v) => String(v || '').replace(/_/g, ' ').toLowerCase();
// Colour follows the statistical verdict, never the sign alone.
const VERDICT_CLS = { BEATS_BASELINE: 'rd-pos', BELOW_BASELINE: 'rd-neg' };
const lbl = (c) => `${c.coin} ${c.horizon}h`;
const firstSentence = (t) => { const s = String(t || '').trim(); const m = s.match(/^.*?[.?!](\s|$)/); return m ? m[0].trim() : s; };

// ---- model --------------------------------------------------------------------

function evalCells(charts, now, asOf = null) {
  const cells = [];
  for (const coin of COINS) {
    for (const horizon of HORIZONS) {
      const c = charts && charts[`${coin}-${horizon}`];
      if (!c || !c.ok) { cells.push({ coin, horizon, ok: false, error: (c && c.error) || 'not loaded' }); continue; }
      const preds = asOf == null ? (c.predictions || []) : Ev.predictionsAsOf(c.predictions || [], asOf);
      const at = asOf == null ? now : asOf;
      cells.push({
        coin, horizon, ok: true, preds,
        stats: Ev.directionalStats(preds), calib: Ev.calibrationStats(preds), trend: Ev.trendStats(preds, at),
        large: Ev.largeMoveStats(preds), origin: Ev.originSplit(preds),
        statsScheduled: Ev.directionalStats(preds.filter(p => Ev.isScheduled(p.ts))),
        statsLive: Ev.directionalStats(preds.filter(p => !Ev.isScheduled(p.ts))),
        growth: growthOf(preds, at),
      });
    }
  }
  return cells;
}

function growthOf(preds, now) {
  const r = preds.filter(Ev.isResolved);
  const since = (d) => r.filter(p => p.ts > now - d * Ev.DAY_MS).length;
  return { total: r.length, d7: since(7), d30: since(30), pending: preds.length - r.length,
    first: preds.length ? Math.min(...preds.map(p => p.ts)) : null };
}

/**
 * @param {object} d values per source: { charts: {`${coin}-${h}`: {ok, predictions}}, freshness, registry, v1Latest, adaptation, hloi }
 * @param {object} [opts] { freshState: acceptSource state for /prediction-freshness, sources: {name: state} for staleness }
 */
export function buildModel(d, now = Date.now(), opts = {}) {
  const cells = evalCells(d.charts, now);
  const prevCells = evalCells(d.charts, now, now - Ev.DAY_MS);
  const freshness = d.freshness && d.freshness.ok ? d.freshness : null;
  const experiments = d.registry && d.registry.ok ? d.registry.experiments : [];
  const adaptation = d.adaptation && d.adaptation.ok !== false && d.adaptation.defaults ? d.adaptation : null;
  const hloi = d.hloi && d.hloi.status ? d.hloi : null;
  // Three independent dimensions: research outcome (evaluation only), data quality (persistence + availability),
  // execution (job runs, held by the controls). None is derived from another.
  const overall = Ev.overallStatus(cells);
  const prevOverall = Ev.overallStatus(prevCells); // the same records as of 24 h ago
  const freshState = opts.freshState || (d.freshness ? DQ.acceptSource(null, d.freshness, { seq: 0, fetchedAt: now }) : null);
  const dataQuality = DQ.assessDataQuality(freshState, now, DQ.OPERATING_POLICY, cells.filter(c => !c.ok));
  const review = Ev.nextReview({ cells, experiments, now });
  const v1 = d.v1Latest && d.v1Latest.ok ? d.v1Latest : null;
  const { evidence } = Ev.adaptationEvidence(adaptation);
  const factors = adaptation ? Ev.factorRows(adaptation, v1, evidence, hloi) : [];
  return {
    now, cells, overall, prevOverall, review, freshness, experiments, adaptation, hloi, v1,
    pooled: pool(cells.filter(c => c.ok)),
    dataQuality,
    staleSources: Object.entries(opts.sources || {}).filter(([, st]) => st && (st.stale || (!st.value && st.lastError))).map(([name, st]) => ({ name, verifiedAt: st.verifiedAt, lastError: st.lastError, stale: !!st.stale })),
    changes: Ev.whatChanged({ cells, prevCells, overall, prevOverall, experiments, now }),
    actions: Ev.recommendations({ overall, cells, experiments, adaptation, review, dataQuality }),
    errors: {
      registry: d.registry && !d.registry.ok ? d.registry.error : null,
      freshness: d.freshness && !d.freshness.ok ? d.freshness.error : (!d.freshness ? 'not loaded' : null),
      v1: d.v1Latest && !d.v1Latest.ok ? d.v1Latest.error : null,
      adaptation: !adaptation ? (d.adaptation && d.adaptation.error) || 'not loaded' : null,
      hloi: !hloi ? (d.hloi && d.hloi.error) || 'not loaded' : null,
    },
    groups: Ev.groupExperiments(experiments),
    combined: Ev.combinedFactorCard(adaptation),
    factors,
    reconstructed: Ev.reconstructedComposite(factors),
  };
}

/** Pooled figures across all loaded series (sums, not averages of averages). */
export function pool(cells) {
  let n = 0, hits = 0, base = 0, upM = 0, upC = 0, dnM = 0, dnC = 0, resolved = 0, pending = 0;
  const sch = { n: 0, hits: 0 }, live = { n: 0, hits: 0 };
  for (const c of cells) {
    n += c.stats.n; hits += c.stats.hits || 0; base += c.stats.n ? c.stats.baseline * c.stats.n : 0;
    upM += c.large.up.moves; upC += c.large.up.called; dnM += c.large.down.moves; dnC += c.large.down.called;
    resolved += c.origin.resolved; pending += c.origin.pending;
    sch.n += c.statsScheduled.n; sch.hits += c.statsScheduled.hits || 0; live.n += c.statsLive.n; live.hits += c.statsLive.hits || 0;
  }
  const ci = Ev.wilson(hits, n), baseline = n ? base / n : null;
  const verdict = !n ? 'NO_DATA' : ci.lo > baseline ? 'BEATS_BASELINE' : ci.hi < baseline ? 'BELOW_BASELINE' : 'WITHIN_NOISE';
  return {
    n, accuracy: n ? hits / n : null, baseline, delta: n ? (hits - base) / n : null, verdict,
    largeUp: { moves: upM, called: upC, recall: upM >= Ev.MIN_LARGE_MOVES ? upC / upM : null },
    largeDown: { moves: dnM, called: dnC, recall: dnM >= Ev.MIN_LARGE_MOVES ? dnC / dnM : null },
    resolved, pending,
    scheduled: { n: sch.n, accuracy: sch.n ? sch.hits / sch.n : null },
    live: { n: live.n, accuracy: live.n ? live.hits / live.n : null },
  };
}

// ---- shared pieces -----------------------------------------------------------

const STATUS_UI = {
  UNVERIFIED: { tone: 'tone-info', icon: '?' },
  IMPROVING: { tone: 'tone-good', icon: '↗' },
  DETERIORATING: { tone: 'tone-bad', icon: '↘' },
  NOT_IMPROVING: { tone: 'tone-bad', icon: '↓' },
  INCONCLUSIVE: { tone: 'tone-warn', icon: '≈' },
  INSUFFICIENT_DATA: { tone: 'tone-info', icon: '…' },
  DATA_QUALITY: { tone: 'tone-bad', icon: '!' },
};
const STAGE_CLS = { eligible: 'status-neutral', evaluated: 'status-ok', collecting: 'status-warning', unavailable: 'status-error',
  not_started: 'rd-badge-mute', inactive: 'rd-badge-mute', diagnostic: 'rd-badge-mute', unknown: 'rd-badge-mute' };
const badge = (label, cls) => `<span class="status-badge rd-badge ${cls}">${esc(label)}</span>`;
const metric = (title, value, sub, cls = '') => `<div class="rd-metric${cls ? ' ' + cls : ''}"><p class="rd-metric-t">${esc(title)}</p><p class="rd-metric-v">${value}</p>${sub ? `<p class="rd-metric-s">${sub}</p>` : ''}</div>`;
const section = (title, body, cls = '') => `<section class="rd-card${cls ? ' ' + cls : ''}"><p class="rd-h">${esc(title)}</p>${body}</section>`;
const details = (summary, body) => `<details class="rd-details"><summary>${esc(summary)}</summary><div class="rd-details-body">${body}</div></details>`;
const kv = (rows) => `<dl class="rd-kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

// ---- Overview -----------------------------------------------------------------

const DQ_TONE = { HEALTHY: '', DEGRADED: 'tone-warn', PROBLEM: 'rd-neg', UNVERIFIED: 'rd-muted' };

export function renderDataQualityTile(dq, incidents = []) {
  const open = incidents.filter(i => i.resolvedAt == null);
  const closed = incidents.filter(i => i.resolvedAt != null).slice(0, 5);
  return `<div class="rd-metric"><p class="rd-metric-t">Data quality</p><p class="rd-metric-v ${DQ_TONE[dq.status] || ''}">${esc(DQ.DQ_LABEL[dq.status])}</p>
    <p class="rd-metric-s">${esc(dq.reason)}${dq.verifiedAt ? `<br>Verified ${esc(dt(dq.verifiedAt))} (V2 check generated ${esc(dt(dq.asOf))}).` : ''}</p>
    ${incidents.length ? details(`Incident history (${open.length} open, ${closed.length} resolved shown)`, `<ul class="rd-list">${[...open, ...closed].map(i => `<li>${esc(i.series)} ${esc(String(i.status).toLowerCase())} · seen ${esc(dt(i.openedAt))}${i.resolvedAt ? ` · recovered ${esc(dt(i.resolvedAt))}` : ' · still open'}</li>`).join('')}</ul><p class="rd-foot">Recorded on this device from verified checks only. History is kept apart from current health.</p>`) : ''}</div>`;
}

export function renderStaleBanner(m, lastSuccessAt) {
  if (!m.staleSources || !m.staleSources.length) return '';
  return `<section class="rd-card rd-note-warn"><p class="rd-note-t">⚠ Not current</p><p class="rd-sub">The latest refresh failed for ${esc(m.staleSources.map(x => `${x.name} (${x.lastError})`).join(', '))}. ${m.staleSources.some(x => x.stale) ? `Values shown for those sources are the last verified ones${lastSuccessAt ? ` (last fully successful refresh ${esc(dt(lastSuccessAt))})` : ''} and are not current.` : 'No earlier verified values exist for them.'}</p></section>`;
}

export function renderOverview(m, ctx = {}) {
  const s = STATUS_UI[m.overall.status] || STATUS_UI.INCONCLUSIVE;
  const p = m.pooled;
  const sideTxt = (x, dir) => (x.recall == null ? `${dir} ${INSUF} <span class="rd-muted">(${x.moves} move${x.moves === 1 ? '' : 's'})</span>` : `${dir} ${esc(pct(x.recall, 0))} <span class="rd-muted">(${x.called}/${x.moves})</span>`);
  const calibCells = m.cells.filter(c => c.ok && Number.isFinite(c.calib.skill));
  const calN = calibCells.reduce((a, c) => a + c.calib.n, 0);
  const skill = calibCells.length ? calibCells.reduce((a, c) => a + c.calib.skill * c.calib.n, 0) / calN : null;
  // Show the scheduled / live-fallback split whenever both exist: pooling them could mislead.
  const split = p.scheduled.n && p.live.n ? `<br>Scheduled ${esc(pct(p.scheduled.accuracy))} (n=${p.scheduled.n}) · live-fallback ${esc(pct(p.live.accuracy))} (n=${p.live.n})` : '';
  const failed = m.cells.filter(c => !c.ok);
  const r = m.review;
  return `${renderStaleBanner(m, ctx.lastSuccessAt)}
  <section class="rd-card rd-status">
    <div class="rd-status-icon ${s.tone}" aria-hidden="true">${s.icon}</div>
    <div class="rd-min0">
      <p class="rd-label">Research outcome · V2 predictions, all coins and horizons</p>
      <p class="rd-status-v ${s.tone}">${esc(Ev.STATUS_LABEL[m.overall.status])}</p>
      <p class="rd-sub">${esc(m.overall.reason)}</p>
    </div>
  </section>
  <div class="rd-grid rd-mb">${renderDataQualityTile(m.dataQuality, ctx.incidents || [])}${renderExecutionTile(ctx.controls, m.now)}</div>
  <p class="rd-muted rd-mb">${ctx.lastSuccessAt ? `Overview data last refreshed successfully at ${esc(dt(ctx.lastSuccessAt))}.` : 'Overview data has not been refreshed successfully yet.'} Research outcome, data quality and execution are separate: none is inferred from another.</p>
  ${section('Core metrics', `<div class="rd-grid">
    ${metric('Directional accuracy vs baseline', p.n >= Ev.MIN_ACCURACY_SAMPLES ? `<span class="${VERDICT_CLS[p.verdict] || ''}">${esc(pts(p.delta))}</span>` : INSUF,
      p.n >= Ev.MIN_ACCURACY_SAMPLES ? `${esc(pct(p.accuracy))} vs ${esc(pct(p.baseline))} always-same-direction baseline · n=${p.n} · ${esc(verdictTxt(p.verdict))}${split}` : `${p.n} resolved of ${Ev.MIN_ACCURACY_SAMPLES} needed`)}
    ${metric(`Large moves (≥${Ev.LARGE_MOVE_PCT}%) called`, `${sideTxt(p.largeUp, '↑')}<br>${sideTxt(p.largeDown, '↓')}`, `Recall shown only with ≥${Ev.MIN_LARGE_MOVES} moves per direction`)}
    ${metric('Calibration (Brier skill)', skill == null ? INSUF : `${skill >= 0 ? '+' : ''}${esc((skill * 100).toFixed(1))}%`, skill == null ? 'Needs ≥10 resolved per series' : `vs climatology on ${calN} resolved · >0 is better than the base rate`)}
    ${metric('Resolved / pending', `${p.resolved} / ${p.pending}`, `${p.scheduled.n} scheduled · ${p.live.n} live-fallback resolved`)}
  </div>${failed.length ? `<p class="rd-foot">Unavailable series: ${esc(failed.map(c => `${lbl(c)} (${c.error})`).join(', '))}.</p>` : ''}`)}
  ${section('What changed?', `<p class="rd-muted rd-mb">Compared with the evaluation as of 24 h ago, rebuilt from the same records.</p><ul class="rd-list">${m.changes.map(c => `<li>${esc(c)}</li>`).join('')}</ul>`, 'rd-note-info')}
  ${section('What should we do next?', m.actions.length
    ? `<ol class="rd-list rd-ol">${m.actions.map(a => `<li>${a.kind === 'blocker' ? '<b>Blocker.</b> ' : ''}${esc(a.text)}</li>`).join('')}</ol>`
    : '<p class="rd-sub">No action is indicated by the current evidence.</p>', m.actions.some(a => a.kind === 'blocker') ? 'rd-note-warn' : 'rd-note-good')}
  ${section('Next milestone', r.date
    ? `<div class="rd-row"><p class="rd-sub rd-min0">${esc(r.text)}</p><p class="rd-date">${esc(r.date)}</p></div>${r.later.length ? `<ul class="rd-list rd-mt">${r.later.map(x => `<li>${esc(x.date)} — ${esc(x.text)}</li>`).join('')}</ul>` : ''}`
    : `<p class="rd-date">ETA: Not yet estimable</p><p class="rd-sub">${esc(r.why)}</p>`)}`;
}

// ---- Performance ------------------------------------------------------------------

export const PERF_TABS = [['direction', 'Direction'], ['large', 'Large moves'], ['calibration', 'Calibration'], ['growth', 'Sample growth'], ['origin', 'Scheduled vs live']];

export function renderPerformance(m, sub = 'direction') {
  const seg = `<div class="rd-seg" role="tablist">${PERF_TABS.map(([k, l]) => `<button type="button" data-rd-perf="${k}" class="${k === sub ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const fail = (c, cols) => `<tr><td>${lbl(c)}</td><td colspan="${cols}">${UNAV} <span class="rd-muted">(${esc(c.error)})</span></td></tr>`;
  let body;
  if (sub === 'large') {
    const side = (s) => (s.recall == null ? `${INSUF}<br><span class="rd-muted">${s.called}/${s.moves} called</span>` : `${esc(pct(s.recall, 0))}<br><span class="rd-muted">${s.called}/${s.moves}</span>`);
    body = `<table class="rd-table"><tr><th>Series</th><th>Up moves called</th><th>Down moves called</th></tr>${m.cells.map(c => !c.ok ? fail(c, 2)
      : `<tr><td>${lbl(c)}</td><td>${side(c.large.up)}</td><td>${side(c.large.down)}</td></tr>`).join('')}</table>
      <p class="rd-foot">Large move = realized |return| ≥ ${Ev.LARGE_MOVE_PCT}% over the horizon (V2 realized_return, percent). Recall is shown only with ≥${Ev.MIN_LARGE_MOVES} moves. Precision is unavailable: V2 emits no separate large-move call (no large-move field on predictions).</p>`;
  } else if (sub === 'calibration') {
    body = `<table class="rd-table"><tr><th>Series</th><th>Brier</th><th>Climatology</th><th>Skill</th></tr>${m.cells.map(c => !c.ok ? fail(c, 3) : c.calib.brier == null
      ? `<tr><td>${lbl(c)}</td><td colspan="3">${INSUF} <span class="rd-muted">(n=${c.calib.n}, needs 10)</span></td></tr>`
      : `<tr><td>${lbl(c)}</td><td>${esc(num(c.calib.brier))}</td><td>${esc(num(c.calib.climatology))}</td><td>${c.calib.skill >= 0 ? '+' : ''}${esc((c.calib.skill * 100).toFixed(1))}%<br><span class="rd-muted">n=${c.calib.n}</span></td></tr>`).join('')}</table>
      <p class="rd-foot">Brier on p_up vs the realized direction; lower is better. Skill > 0 means the probabilities beat always forecasting the series' base rate.</p>`;
  } else if (sub === 'growth') {
    body = `<table class="rd-table"><tr><th>Series</th><th>Resolved</th><th>Last 7 d</th><th>Last 30 d</th><th>Pending</th></tr>${m.cells.map(c => !c.ok ? fail(c, 4)
      : `<tr><td>${lbl(c)}</td><td>${c.growth.total}<br><span class="rd-muted">since ${esc(c.growth.first ? new Date(c.growth.first).toISOString().slice(0, 10) : '—')}</span></td><td>${c.growth.d7}</td><td>${c.growth.d30}</td><td>${c.growth.pending}</td></tr>`).join('')}</table>
      <p class="rd-foot">Counts by prediction time. The 30-day trend test needs ≥${Ev.MIN_TREND_PER_WINDOW} resolved predictions in each of the last two 30-day windows.</p>`;
  } else if (sub === 'origin') {
    const acc = (s) => (s.n ? `${esc(pct(s.accuracy))}<br><span class="rd-muted">n=${s.n}</span>` : INSUF);
    body = `<table class="rd-table"><tr><th>Series</th><th>Scheduled</th><th>Live-fallback</th></tr>${m.cells.map(c => !c.ok ? fail(c, 2)
      : `<tr><td>${lbl(c)}</td><td>${acc(c.statsScheduled)}</td><td>${acc(c.statsLive)}</td></tr>`).join('')}</table>
      <p class="rd-foot">Scheduled = written by the 3-hourly cron (within 5 min of a 00/03/…/21 UTC tick); every other row is a live-fallback prediction. Accuracy on resolved rows of each origin.</p>`;
  } else {
    body = `<table class="rd-table"><tr><th>Series</th><th>Accuracy</th><th>Baseline</th><th>Δ</th></tr>${m.cells.map(c => !c.ok ? fail(c, 3) : c.stats.n < Ev.MIN_ACCURACY_SAMPLES
      ? `<tr><td>${lbl(c)}</td><td colspan="3">${INSUF} <span class="rd-muted">(${c.stats.n} resolved of ${Ev.MIN_ACCURACY_SAMPLES} needed · ${c.origin.pending} pending)</span></td></tr>`
      : `<tr><td>${lbl(c)}</td><td>${esc(pct(c.stats.accuracy))}<br><span class="rd-muted">n=${c.stats.n} · ${c.origin.pending} pending</span></td><td>${esc(pct(c.stats.baseline))}<br><span class="rd-muted">always ${esc(c.stats.baselineDirection)}</span></td><td><span class="${VERDICT_CLS[c.stats.verdict] || ''}">${esc(pts(c.stats.delta))}</span><br><span class="rd-muted">${esc(verdictTxt(c.stats.verdict))} · 30 d: ${esc(verdictTxt(c.trend.verdict))}</span></td></tr>`).join('')}</table>
      <p class="rd-foot">Resolved outcomes only; pending predictions are counted but never scored. Accuracy is shown from ${Ev.MIN_ACCURACY_SAMPLES} resolved predictions. Baseline = always predicting the series' more frequent realized direction on the same resolved rows. "Beats" requires the 95% Wilson interval to clear it. 30 d = last 30 days vs the 30 before (two-proportion test, ≥${Ev.MIN_TREND_PER_WINDOW} per window).</p>`;
  }
  const prov = `<p class="rd-foot rd-prov">Source: PulseWorkerV2 ${COINS.map(c => CHART_ENDPOINT[c]).join(', ')} (horizon=12H and 24H), production core predictions; loaded ${esc(dt(m.now))}.</p>`;
  return section('Prediction quality vs baseline', seg + body + prov);
}

// ---- Experiments -------------------------------------------------------------------

/** The backend's measured result, only when it reported one as text. */
function resultLine(e) {
  const r = e.current_measured_result;
  return typeof r === 'string' && r && r !== 'NOT_AVAILABLE' ? r : null;
}

export function renderExperimentCard(e) {
  const st = Ev.experimentStage(e);
  const hasProgress = Number.isFinite(e.progress_count) && Number.isFinite(e.required_sample) && e.required_sample > 0;
  const prog = hasProgress ? Math.min(1, e.progress_count / e.required_sample) : null;
  const sample = hasProgress ? `${e.progress_count} / ${e.required_sample}` : Number.isFinite(e.progress_count) ? `${e.progress_count} (no required sample set)` : 'Not reported';
  const result = resultLine(e);
  const eta = e.eta && e.eta.estimable && e.eta.reached ? 'Sample threshold met — eligible for evaluation, not a result'
    : e.eta && e.eta.estimable && e.eta.eta_date ? formatEtaText(e.eta) : 'Not yet estimable';
  return `<article class="rd-card rd-exp">
    <div class="rd-row rd-wrap"><p class="rd-exp-t">${esc(registryTitle(e))}</p>${badge(st.label, STAGE_CLS[st.key] || 'rd-badge-mute')}</div>
    <p class="rd-sub">${esc(firstSentence(e.research_question))}</p>
    ${kv([
      ['Result vs baseline', result ? esc(result) + (e.baseline ? ` <span class="rd-muted">(baseline: ${esc(e.baseline)})</span>` : '') : `<span class="rd-muted">Not yet evaluated${e.baseline ? ` (baseline: ${esc(e.baseline)})` : ''}</span>`],
      ['Evidence', `${esc(String(e.confidence_evidence_maturity || 'UNKNOWN').replace(/_/g, ' ').toLowerCase())} · samples ${esc(sample)}`],
      ...(e.conclusion ? [['Assessment', esc(e.conclusion)]] : []),
      ['Next action', esc(e.next_action)],
      ['ETA', esc(eta)],
    ])}
    ${prog == null ? '' : `<div class="rd-bar" aria-hidden="true"><span style="width:${(prog * 100).toFixed(0)}%"></span></div>`}
    ${details('Technical details', `${kv([['Operational status', esc(Ev.operationalStatus(e))], ['Success criterion', esc(e.success_criterion)], ['Out-of-sample', esc(typeof e.oos_result === 'object' ? JSON.stringify(e.oos_result) : e.oos_result)], ['Data last updated', esc(dt(e.data_last_updated))], ['References', esc(e.github_refs || '—')], ['Live error', esc(e.live_error || '—')]])}<pre class="rd-pre">${esc(JSON.stringify(e, null, 2))}</pre>`)}
  </article>`;
}

export function renderCombinedCard(c) {
  return `<article class="rd-card rd-exp">
    <div class="rd-row rd-wrap"><p class="rd-exp-t">Combined factors · V1 composite leave-one-out</p>${badge(c.evidence.label, c.evidence.key === 'unavailable' ? 'status-error' : c.evidence.key === 'insufficient' ? 'status-warning' : 'status-neutral')}</div>
    <p class="rd-sub">${esc(c.question)}</p>
    ${kv([['Result', esc(c.finding)], ['Next action', esc(c.next)], ['ETA', esc(c.eta || `Not yet estimable — ${c.etaWhy || 'no rate available'}`)], ['Value to V3 predictions', esc(c.v3)]])}
    <p class="rd-foot">No combined-factor experiment is registered in V2; this is V1's own shadow evidence, read-only.</p>
  </article>`;
}

const EXP_SHORT = { models: 'Models', sentiment: 'Sentiment', signals: 'Signals', combined: 'Combined', largemoves: 'Large moves', controls: 'Controls', other: 'Other' };

export function renderExperiments(m, filter = 'all') {
  if (m.errors.registry) return section('Experiments', `<p class="rd-sub">${UNAV} <span class="rd-muted">(/api/research-lab/registry: ${esc(m.errors.registry)})</span></p>`);
  const chips = [['all', 'All'], ...m.groups.map(g => [g.key, EXP_SHORT[g.key] || g.title])];
  const seg = `<div class="rd-seg">${chips.map(([k, l]) => `<button type="button" data-rd-exp="${k}" class="${k === filter ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>`;
  const groups = m.groups.filter(g => filter === 'all' || g.key === filter);
  return `${seg}${groups.map(g => `
    <p class="rd-group">${esc(g.title)}</p>
    ${g.key === 'combined' ? renderCombinedCard(m.combined) : ''}
    ${g.items.length ? g.items.map(renderExperimentCard).join('') : g.key === 'combined' ? '' : '<p class="rd-muted rd-pad">No registered experiment in this group.</p>'}`).join('')}`;
}

// ---- Factors --------------------------------------------------------------------

const CAT_COLORS = { sentiment: '#3B82F6', onchain: '#22C55E', derivatives: '#F59E0B', macro: '#8B5CF6', other: '#64748B' };
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : null);
const signed = (x) => { if (!Number.isFinite(x)) return null; const r = Math.round(x * 10) / 10 || 0; return `${r >= 0 ? '+' : ''}${r.toFixed(1)}`; };

function predictiveTxt(p) {
  if (p.status === 'insufficient') return `<span class="rd-muted">Insufficient data (${p.samples}/${p.required} samples)</span>`;
  const label = p.status === 'helps' ? 'adds' : p.status === 'hurts' ? 'subtracts' : 'no clear effect:';
  const cls = p.status === 'helps' ? 'rd-pos' : p.status === 'hurts' ? 'rd-neg' : '';
  return `<span class="${cls}">${label} ${esc(signed(p.deltaPts))} pts</span> <span class="rd-muted">hit rate, in-sample, n=${p.samples}</span>`;
}

export function renderSourceCard(r) {
  return `<article class="rd-src${r.contributing ? '' : ' rd-src-off'}">
    <div class="rd-row rd-wrap"><p class="rd-src-t">${esc(r.id)}</p>${r.contributing ? '' : badge(r.id === 'hloi' ? 'Collecting' : 'Excluded', 'status-warning')}</div>
    ${kv([
      ['Now', r.rawScore == null ? '<span class="rd-muted">—</span>' : esc(Math.round(r.rawScore))],
      ['Configured weight', `${esc(r.weight)} × ${esc(r.confidence)} conf <span class="rd-muted">(${esc(f1(r.configuredSharePct) ?? '—')}% of all weight)</span>`],
      ['Effective share', r.contributing ? `${esc(f1(r.effectiveSharePct))}%` : '<span class="rd-muted">0% — excluded</span>'],
      ['Observed contribution', r.contributing && r.contributionPts != null ? `${esc(f1(r.contributionPts))} pts <span class="rd-muted">(${esc(signed(r.pushPts))} vs neutral)</span>` : `<span class="rd-muted">${esc(r.excludedReason || 'Not contributing')}</span>`],
      ['Predictive value', `${predictiveTxt(r.predictive)}<br><span class="rd-muted">V3: not measured</span>`],
    ])}
    ${r.evidenceRaw ? details('Diagnostics', `<pre class="rd-pre">${esc(JSON.stringify(r.evidenceRaw, null, 2))}</pre>`) : ''}
  </article>`;
}

export function renderFactors(m) {
  const a = m.adaptation;
  if (!a) return section('Factors', `<p class="rd-sub">${UNAV} <span class="rd-muted">(V1 /weight-adaptation: ${esc(m.errors.adaptation)})</span></p>`);
  const summary = m.factors.map(c => `<div class="rd-cat">
      <div class="rd-row"><p class="rd-cat-t">${esc(c.title)}</p><p class="rd-cat-v">${c.contributingCount}/${c.total} contributing</p></div>
      <div class="rd-bar"><span style="width:${Math.min(100, c.effectiveSharePct).toFixed(0)}%;--cat:${CAT_COLORS[c.key] || CAT_COLORS.other}"></span></div>
      <p class="rd-muted">Effective share ${esc(f1(c.effectiveSharePct))}% · configured ${esc(f1(c.configuredSharePct))}% · contribution ${c.contributionPts == null ? '—' : `${esc(f1(c.contributionPts))} pts (${esc(signed(c.pushPts))} vs neutral)`}</p>
    </div>`).join('');
  const reading = m.v1 ? `Latest V1 reading ${esc(dt(m.v1.ts))} · V1 composite ${m.v1.score == null ? '—' : esc(Math.round(m.v1.score))}` : `Latest V1 reading unavailable${m.errors.v1 ? ` (${esc(m.errors.v1)})` : ''}`;
  const { n_samples, persisted, run_ts } = Ev.adaptationEvidence(a);
  const pol = a.policy, ev = a.evaluation;
  return `
  ${section('Factor categories', `<p class="rd-muted rd-mb">${reading}</p>${summary}
    <p class="rd-foot">Configured weight comes from V1's defaults. Effective share renormalises weight × confidence over the sources present in the latest reading (V1's own composite arithmetic). Contribution is the points each source supplied to that reading. None of these is evidence of predictive value.</p>`)}
  ${m.factors.map(c => `<p class="rd-group">${esc(c.title)}</p><div class="rd-src-grid">${c.rows.map(renderSourceCard).join('')}</div>`).join('')}
  ${section('Measured predictive value', `<p class="rd-sub">Predictive value is V1's leave-one-out test: the change in V1's next-24h BTC directional hit rate with vs without the source, on at least ${pol.minSamples} spaced samples (in-sample). Incremental value to V3 predictions is not measured: V3 models do not consume V1 factors.</p>
    ${details('Weight-adaptation diagnostics (V1, read-only)', kv([
      ['Mode', esc(a.mode === 'active' ? 'Active' : 'Shadow — proposals never change V1 weights by themselves')],
      ['Last run', persisted ? esc(dt(run_ts)) : 'No stored run yet; values shown are an unsaved preview'],
      ['Spaced samples', `${n_samples ?? '—'} (need ${pol.minSamples})`],
      ['Out-of-sample vs defaults', ev ? `${esc(verdictTxt(ev.verdict))}${Number.isFinite(ev.shadow_hit_pct) ? ` · ${esc(ev.shadow_hit_pct.toFixed(1))}% vs ${esc(ev.baseline_hit_pct.toFixed(1))}% (n=${ev.samples_after})` : ''}` : 'Not evaluated yet'],
      ['Policy', `${pol.minFactor}–${pol.maxFactor}× default · ≤${pol.maxStepPct}%/step · ≤${pol.maxSharePct}% share · Δ≥${pol.minDeltaPts} pts`],
      ['Reconstructed composite', m.reconstructed == null ? '—' : `${esc(m.reconstructed.toFixed(1))} vs V1 stored ${m.v1 && m.v1.score != null ? esc(m.v1.score.toFixed(1)) : '—'} (V1 also applies a ×1.5 Foufi driver boost not visible in stored readings)`],
    ]))}`)}`;
}

// ---- DOM glue -----------------------------------------------------------------

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* private mode */ } },
};
export const POLL_ACTIVE_MS = 60000;
export const POLL_IDLE_MS = 5 * 60000;
export const MIN_INTERIM_REFRESH_MS = 2 * 60000;

/** Merge one load's results into held per-source states (newer-only), returning values for buildModel. */
export function mergeSources(held, results, meta) {
  const next = { ...held };
  for (const [name, res] of Object.entries(results)) next[name] = DQ.acceptSource(held[name] || null, res, meta);
  const values = { charts: {} };
  for (const [name, st] of Object.entries(next)) {
    const v = st.value || (st.lastError ? { ok: false, error: st.lastError } : null);
    if (name.startsWith('chart:')) values.charts[name.slice(6)] = v;
    else values[name] = v;
  }
  const failed = Object.entries(results).filter(([, r]) => !r || r.ok === false).map(([n]) => n);
  return { held: next, values, failed };
}

/**
 * @param {HTMLElement} root
 * @param {{ fetchers: object, fetchRuns?: Function, openUrl?: Function, onTab?: (tab:string)=>void, now?: Function }} opts
 */
const KEY_NAME = 'cp3_dispatch_key';
const keyStore = {
  get() { try { return sessionStorage.getItem(KEY_NAME) || localStorage.getItem(KEY_NAME) || null; } catch (_) { return null; } },
  remembered() { try { return !!localStorage.getItem(KEY_NAME); } catch (_) { return false; } },
  set(v, remember) { try { (remember ? localStorage : sessionStorage).setItem(KEY_NAME, v); (remember ? sessionStorage : localStorage).removeItem(KEY_NAME); } catch (_) { /* ignore */ } },
  clear() { try { sessionStorage.removeItem(KEY_NAME); localStorage.removeItem(KEY_NAME); } catch (_) { /* ignore */ } },
};
const newRequestId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

export function mountResearchDashboard(root, { fetchers, fetchRuns = C.fetchRuns, dispatchJob = C.dispatchJob, fetchHealth = C.fetchDispatcherHealth,
  openUrl, onTab, now: clock = () => Date.now() } = {}) {
  const state = { tab: 'overview', perf: 'direction', exp: 'all', model: null, loadedAt: 0, loading: null, error: null,
    sources: {}, seq: 0, lastSuccessAt: null, incidents: LS.get('cp3_dq_incidents', []),
    ctl: { runs: null, etag: null, lastPollAt: null, lastOkPollAt: null, pollError: null, rate: null,
      pending: LS.get('cp3_research_pending', {}), audit: LS.get('cp3_research_audit', []), review: null, authInput: {}, lastExecutionRefresh: null,
      dispatcher: null, healthAt: 0, keySet: !!keyStore.get(), keyRemembered: keyStore.remembered(), keyRememberChoice: false,
      confirm: null, confirmAck: false, dispatching: null, lastDispatch: LS.get('cp3_last_dispatch', null) },
    timer: null, lastLoadAt: 0 };
  try { const t = localStorage.getItem('cp3_research_tab'); if (TABS.some(([k]) => k === t)) state.tab = t; } catch (_) { /* ignore */ }

  const tabsHtml = () => `<div class="rd-tabs" role="tablist">${TABS
    .map(([k, l]) => `<button type="button" role="tab" aria-selected="${state.tab === k}" data-rd-tab="${k}" class="${state.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;

  function render() {
    const m = state.model;
    const t = clock();
    let body;
    if (!m) body = section('Research', `<p class="rd-sub">${state.loading ? 'Loading live data…' : esc(state.error || 'Not loaded.')}</p>`);
    else if (state.tab === 'performance') body = renderStaleBanner(m, state.lastSuccessAt) + renderPerformance(m, state.perf);
    else if (state.tab === 'experiments') body = renderControls(state.ctl, t) + renderExperiments(m, state.exp);
    else if (state.tab === 'factors') body = renderStaleBanner(m, state.lastSuccessAt) + renderFactors(m);
    else body = renderOverview(m, { controls: state.ctl, incidents: state.incidents, lastSuccessAt: state.lastSuccessAt });
    // Preserve open <details> and focused inputs across re-renders (polling re-renders often).
    const open = new Set([...root.querySelectorAll('details[open] > summary')].map(x => x.textContent + '|' + (x.closest('article')?.querySelector('.rd-exp-t,.rd-src-t')?.textContent || '')));
    const focused = document.activeElement && root.contains(document.activeElement) ? document.activeElement.dataset.rdPhrase : null;
    root.innerHTML = tabsHtml() + `<div class="rd-body">${body}</div>`;
    root.querySelectorAll('details > summary').forEach(x => {
      if (open.has(x.textContent + '|' + (x.closest('article')?.querySelector('.rd-exp-t,.rd-src-t')?.textContent || ''))) x.parentElement.open = true;
    });
    if (focused) { const el = root.querySelector(`[data-rd-phrase="${focused}"]`); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
    if (onTab) onTab(state.tab);
  }

  function audit(entry) {
    state.ctl.audit = C.appendAudit(state.ctl.audit, { at: clock(), ...entry });
    LS.set('cp3_research_audit', state.ctl.audit);
  }

  let keyDraft = '';
  root.addEventListener('click', (ev) => {
    const link = ev.target.closest('a[data-rd-ghpage]');
    if (link && root.contains(link)) { githubPageRequested(link.dataset.rdGhpage); return; }
    const t = ev.target.closest('button');
    if (!t || !root.contains(t) || t.disabled) return;
    if (t.dataset.rdTab) { state.tab = t.dataset.rdTab; try { localStorage.setItem('cp3_research_tab', state.tab); } catch (_) { /* ignore */ } render(); }
    else if (t.dataset.rdPerf) { state.perf = t.dataset.rdPerf; render(); }
    else if (t.dataset.rdExp) { state.exp = t.dataset.rdExp; render(); }
    else if (t.dataset.rdConfirm) { state.ctl.confirm = state.ctl.confirm === t.dataset.rdConfirm ? null : t.dataset.rdConfirm; state.ctl.confirmAck = false; render(); }
    else if (t.dataset.rdLaunch) launch(t.dataset.rdLaunch);
    else if (t.dataset.rdKeySave) { if (keyDraft.trim().length >= 24) { keyStore.set(keyDraft.trim(), state.ctl.keyRememberChoice); state.ctl.keySet = true; state.ctl.keyRemembered = state.ctl.keyRememberChoice; } keyDraft = ''; render(); }
    else if (t.dataset.rdKeyForget) { keyStore.clear(); state.ctl.keySet = false; state.ctl.keyRemembered = false; render(); }
    else if (t.dataset.rdReview) { state.ctl.review = state.ctl.review === t.dataset.rdReview ? null : t.dataset.rdReview; render(); }
    else if (t.dataset.rdAuthorize) authorize(t.dataset.rdAuthorize);
  });
  root.addEventListener('input', (ev) => {
    const el = ev.target;
    if (el.dataset.rdKeyinput) { keyDraft = el.value; return; } // never stored or rendered until "Use this key"
    if (el.dataset.rdKeyremember) { state.ctl.keyRememberChoice = el.checked; return; }
    if (el.dataset.rdConfirmack) { state.ctl.confirmAck = el.checked; render(); return; }
    const id = el.dataset.rdPhrase || el.dataset.rdAck;
    if (!id) return;
    const cur = state.ctl.authInput[id] || {};
    state.ctl.authInput[id] = el.dataset.rdAck ? { ...cur, acknowledged: el.checked } : { ...cur, phrase: el.value };
    render();
  });

  /** Fallback while live dispatch is unavailable: the owner opened GitHub's Run workflow page. */
  function githubPageRequested(jobId) {
    const job = C.JOBS.find(j => j.id === jobId);
    if (!job) return;
    state.ctl.pending = { ...state.ctl.pending, [job.id]: clock() };
    LS.set('cp3_research_pending', state.ctl.pending);
    audit({ kind: 'manual-request', job: job.id, workflow: job.workflow, trigger: 'Manual', result: 'Opened GitHub Run workflow page; not yet confirmed by GitHub' });
    schedulePoll(5000);
  }

  async function launch(jobId) {
    const job = C.JOBS.find(j => j.id === jobId);
    const el = job && C.eligibility(job, state.ctl.runs || [], state.ctl.pending, clock());
    const key = keyStore.get();
    if (!job || job.policy !== 'ELIGIBLE' || !el || !el.canRun || !state.ctl.confirmAck || !key || state.ctl.dispatching) return;
    if (!(state.ctl.dispatcher && state.ctl.dispatcher.ok && state.ctl.dispatcher.enabled)) return;
    state.ctl.dispatching = job.id; render();
    const res = await dispatchJob(job.id, key, { requestId: newRequestId() });
    state.ctl.dispatching = null; state.ctl.confirm = null; state.ctl.confirmAck = false;
    if (res.ok) {
      state.ctl.pending = { ...state.ctl.pending, [job.id]: res.acceptedAt || clock() };
      state.ctl.lastDispatch = { jobId: job.id, dispatchId: res.dispatchId, acceptedAt: res.acceptedAt || clock(), runId: null };
      audit({ kind: 'dispatch-accepted', job: job.id, workflow: job.workflow, trigger: 'Manual', result: `Dispatcher: accepted by GitHub (dispatch ${String(res.dispatchId || '').slice(0, 8)}); run not yet listed` });
    } else if (res.code === 'timeout') {
      // Unknown outcome: watch for a run instead of allowing an immediate retry.
      state.ctl.pending = { ...state.ctl.pending, [job.id]: clock() };
      state.ctl.lastDispatch = { jobId: job.id, acceptedAt: clock(), runId: null, unknown: res.message };
      audit({ kind: 'dispatch-unknown', job: job.id, workflow: job.workflow, result: res.message });
    } else {
      state.ctl.lastDispatch = { jobId: job.id, error: res.message, code: res.code, at: clock() };
      if (res.code === 'unauthorized') { keyStore.clear(); state.ctl.keySet = false; state.ctl.keyRemembered = false; }
      audit({ kind: 'dispatch-rejected', job: job.id, workflow: job.workflow, result: `${res.code}: ${res.message}` });
    }
    LS.set('cp3_research_pending', state.ctl.pending);
    LS.set('cp3_last_dispatch', state.ctl.lastDispatch);
    render();
    schedulePoll(4000);
  }

  async function checkHealth() {
    state.ctl.healthAt = clock();
    state.ctl.dispatcher = await fetchHealth();
  }

  function authorize(jobId) {
    const job = C.JOBS.find(j => j.id === jobId);
    if (!job) return;
    const v = C.validateAuthorization(job, state.ctl.authInput[jobId]);
    if (!v.ok) { render(); return; } // the button is disabled in this case; nothing is recorded or launched
    // Reached only when a protected job has an execution mechanism (none does today, see docs/RESEARCH_CONTROLS.md).
    audit(C.authorizationRecord(job, clock()));
    render();
  }

  async function load({ force = false, cause = null } = {}) {
    if (state.loading) return state.loading;
    if (!force && state.model && clock() - state.loadedAt < REFRESH_MS) { render(); return { ok: true, cached: true }; }
    const seq = ++state.seq;
    state.loading = (async () => {
      if (!state.model) render();
      const chartJobs = [];
      for (const coin of COINS) for (const h of HORIZONS) chartJobs.push(fetchers.chart(coin, h).then(r => [`chart:${coin}-${h}`, r]));
      const [charts, freshness, registry, v1Latest, adaptation, hloi] = await Promise.all([
        Promise.all(chartJobs).then(Object.fromEntries), fetchers.freshness(), fetchers.registry(),
        fetchers.v1Latest(), fetchers.adaptation(), fetchers.hloi(),
      ]);
      const t = clock();
      const merged = mergeSources(state.sources, { ...charts, freshness, registry, v1Latest, adaptation, hloi }, { seq, fetchedAt: t });
      state.sources = merged.held;
      const prev = state.model;
      state.model = buildModel(merged.values, t, { freshState: state.sources.freshness, sources: state.sources });
      state.incidents = DQ.updateIncidents(state.incidents, state.sources.freshness, t);
      LS.set('cp3_dq_incidents', state.incidents);
      state.loadedAt = t; state.lastLoadAt = t; state.error = null;
      if (!merged.failed.length) state.lastSuccessAt = t;
      return { ok: !merged.failed.length, failed: merged.failed, at: t, change: summarizeModelChange(prev, state.model) };
    })().catch((e) => { state.error = `Could not build the research view: ${e && e.message ? e.message : e}`; return { ok: false, failed: ['all'], at: clock(), error: state.error }; })
      .finally(() => { state.loading = null; render(); });
    return state.loading;
  }

  async function onExecutionTransitions(transitions) {
    const terminal = transitions.filter(x => C.TERMINAL.has(x.to));
    const trackedTerminal = terminal.filter(x => C.JOBS.some(j => j.workflow === x.run.workflow));
    const tracked = transitions.filter(x => C.JOBS.some(j => j.workflow === x.run.workflow));
    if (!tracked.length) return;
    // Interim refresh on queued/started (rate-limited); always a final refresh when a tracked run ends.
    if (!trackedTerminal.length && clock() - state.lastLoadAt < MIN_INTERIM_REFRESH_MS) { render(); return; }
    const res = await load({ force: true });
    for (const x of trackedTerminal) {
      const dq = state.model && state.model.dataQuality;
      state.ctl.lastExecutionRefresh = {
        runId: x.run.id, workflow: x.run.workflow, trigger: C.triggerLabel(x.run.event), state: x.to,
        refreshOk: !!(res && res.ok), refreshedAt: res ? res.at : clock(),
        changed: res && res.change ? res.change.changed : [], unchanged: res && res.change ? res.change.unchanged : [],
        blocker: res && !res.ok ? `Refresh failed for ${res.failed.join(', ')}` : dq && dq.status !== 'HEALTHY' ? `Data quality: ${DQ.DQ_LABEL[dq.status]}` : null,
      };
      audit({ kind: 'overview-refresh', workflow: x.run.workflow, run_id: x.run.id, trigger: C.triggerLabel(x.run.event), head_sha: x.run.head_sha,
        result: `${x.to}; Overview refresh ${res && res.ok ? 'succeeded' : 'failed'}` });
    }
    render();
  }

  async function poll() {
    state.timer = null;
    const t = clock();
    if (!state.ctl.dispatcher || clock() - state.ctl.healthAt > POLL_IDLE_MS) await checkHealth();
    const res = await fetchRuns({ etag: state.ctl.etag });
    state.ctl.lastPollAt = t;
    if (!res.ok) { state.ctl.pollError = res.error; render(); schedulePoll(); return; }
    state.ctl.pollError = null; state.ctl.lastOkPollAt = t; state.ctl.rate = res.rate || state.ctl.rate;
    if (!res.notModified) {
      const prevRuns = state.ctl.runs;
      state.ctl.runs = res.runs; state.ctl.etag = res.etag;
      for (const [jobId, since] of Object.entries(state.ctl.pending)) {
        const job = C.JOBS.find(j => j.id === jobId);
        const seen = job && C.runsFor(job, res.runs).find(r => r.event === 'workflow_dispatch' && r.created_at >= since - 60000);
        if (seen) {
          const ld = state.ctl.lastDispatch;
          if (ld && ld.jobId === jobId && !ld.runId && !ld.error) { state.ctl.lastDispatch = { ...ld, runId: seen.id, runUrl: seen.url, unknown: null }; LS.set('cp3_last_dispatch', state.ctl.lastDispatch); }
          audit({ kind: 'run-confirmed', job: jobId, workflow: job.workflow, run_id: seen.id, trigger: 'Manual', head_sha: seen.head_sha, result: `GitHub lists run #${seen.id} (${C.runState(seen).toLowerCase()})` });
          const { [jobId]: _drop, ...rest } = state.ctl.pending; state.ctl.pending = rest;
        } else if (t - since > C.PENDING_DISPATCH_WINDOW_MS) {
          audit({ kind: 'manual-request', job: jobId, workflow: job && job.workflow, result: 'No run appeared on GitHub within 10 minutes; nothing was started from V3' });
          const { [jobId]: _drop, ...rest } = state.ctl.pending; state.ctl.pending = rest;
        }
      }
      LS.set('cp3_research_pending', state.ctl.pending);
      const transitions = C.detectTransitions(prevRuns, res.runs);
      for (const x of transitions) {
        if (C.JOBS.some(j => j.workflow === x.run.workflow)) {
          audit({ kind: 'run-observed', workflow: x.run.workflow, run_id: x.run.id, trigger: C.triggerLabel(x.run.event), head_sha: x.run.head_sha,
            result: `${x.from ? x.from.toLowerCase() + ' → ' : ''}${x.to.toLowerCase()}` });
        }
      }
      await onExecutionTransitions(transitions);
    }
    render();
    schedulePoll();
  }

  function schedulePoll(delay) {
    if (state.timer) clearTimeout(state.timer);
    const active = Array.isArray(state.ctl.runs) && state.ctl.runs.some(r => C.ACTIVE.has(C.runState(r)) && C.JOBS.some(j => j.workflow === r.workflow));
    const wait = delay ?? (active || Object.keys(state.ctl.pending).length ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    state.timer = setTimeout(() => {
      // Poll only while the Lab is on screen and the page is visible; otherwise check again later.
      if ((typeof document !== 'undefined' && document.hidden) || !root.isConnected || root.offsetParent === null) { schedulePoll(); return; }
      poll();
    }, wait);
  }

  render();
  schedulePoll(0);
  return { load, render, state, poll, launchForTest: launch };
}
