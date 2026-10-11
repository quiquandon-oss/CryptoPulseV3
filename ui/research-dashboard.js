// ui/research-dashboard.js -- the four-view V3 research dashboard
// (Overview / Performance / Experiments / Factors) shown at the top of the Lab.
//
// Every number is computed by api/evaluation.js from live records fetched
// read-only from V2 (predictions, registry, persistence), V1 (composite,
// shadow weight adaptation, Hyperliquid OI) and V4 (/api/performance only).
// A metric that cannot be computed honestly renders as "Insufficient data" or
// "Unavailable". Nothing here writes to any backend.
//
// The build/render functions are pure (data in, HTML string out) so they are
// unit-tested in tests/research-dashboard.test.js; mountResearchDashboard()
// is the only DOM/network glue.

import * as Ev from '../api/evaluation.js';
import { formatEtaText, registryTitle } from '../api/research.js';

export const COINS = ['BTC', 'ETH', 'LINK'];
export const HORIZONS = [12, 24];
export const REFRESH_MS = 30 * 60000;
const SNAPSHOT_KEY = 'cp3_research_snapshot';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (x, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : null);
const pts = (x, d = 1) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)} pts` : null);
const num = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : null);
const dt = (ts) => (Number.isFinite(ts) ? new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');
const INSUF = '<span class="rd-muted">Insufficient data</span>';
const UNAV = '<span class="rd-muted">Unavailable</span>';
const orInsuf = (s) => (s == null ? INSUF : esc(s));
const sign = (x) => (!Number.isFinite(x) ? '' : x > 0 ? 'rd-pos' : x < 0 ? 'rd-neg' : '');
// Colour follows the statistical verdict, never the sign alone: a within-noise delta stays neutral.
const VERDICT_CLS = { BEATS_BASELINE: 'rd-pos', BELOW_BASELINE: 'rd-neg' };

// ---- model --------------------------------------------------------------------

/**
 * @param {object} d raw fetch results: { charts: {`${coin}-${h}`: {ok, predictions}}, freshness, registry, v1Latest, adaptation, hloi, v4 }
 */
export function buildModel(d, now = Date.now()) {
  const cells = [];
  for (const coin of COINS) {
    for (const horizon of HORIZONS) {
      const c = d.charts && d.charts[`${coin}-${horizon}`];
      if (!c || !c.ok) { cells.push({ coin, horizon, ok: false, error: (c && c.error) || 'not loaded' }); continue; }
      const preds = c.predictions || [];
      const sched = preds.filter(p => Ev.isScheduled(p.ts));
      cells.push({
        coin, horizon, ok: true, n: preds.length,
        stats: Ev.directionalStats(preds), calib: Ev.calibrationStats(preds), trend: Ev.trendStats(preds, now),
        large: Ev.largeMoveStats(preds), origin: Ev.originSplit(preds),
        statsScheduled: Ev.directionalStats(sched), statsLive: Ev.directionalStats(preds.filter(p => !Ev.isScheduled(p.ts))),
        latestTs: preds.length ? preds[preds.length - 1].ts : null,
      });
    }
  }
  const okCells = cells.filter(c => c.ok);
  const freshness = d.freshness && d.freshness.ok ? d.freshness : null;
  const experiments = d.registry && d.registry.ok ? d.registry.experiments : [];
  const adaptation = d.adaptation && d.adaptation.ok !== false && d.adaptation.defaults ? d.adaptation : null;
  const hloi = d.hloi && d.hloi.status ? d.hloi : null;
  const overall = okCells.length ? Ev.overallStatus(okCells, freshness)
    : { status: 'BLOCKED', reason: 'V2 prediction data could not be loaded, so nothing can be evaluated.' };
  const findings = Ev.dailyFindings({ overall, cells: okCells, experiments, hloi, adaptation, now });
  const pooled = pool(okCells);
  const v1 = d.v1Latest && d.v1Latest.ok ? d.v1Latest : null;
  const { evidence } = Ev.adaptationEvidence(adaptation);
  return {
    now, cells, overall, findings, pooled, freshness, experiments, adaptation, hloi, v1,
    v4: d.v4 && d.v4.ok ? d.v4 : null,
    errors: {
      registry: d.registry && !d.registry.ok ? d.registry.error : null,
      freshness: d.freshness && !d.freshness.ok ? d.freshness.error : null,
      v1: d.v1Latest && !d.v1Latest.ok ? d.v1Latest.error : null,
      adaptation: !adaptation ? (d.adaptation && d.adaptation.error) || 'not loaded' : null,
      v4: d.v4 && !d.v4.ok ? d.v4.error : null,
    },
    groups: Ev.groupExperiments(experiments),
    combined: Ev.combinedFactorCard(adaptation, now),
    factors: adaptation ? Ev.factorRows(adaptation, v1 && v1.sources, evidence) : [],
  };
}

/** Pooled directional / large-move figures across all loaded series (sums, not averages of averages). */
export function pool(cells) {
  let n = 0, hits = 0, base = 0, upM = 0, upC = 0, dnM = 0, dnC = 0, resolved = 0, pending = 0, sched = 0, live = 0;
  for (const c of cells) {
    n += c.stats.n; hits += c.stats.hits || 0; base += c.stats.n ? c.stats.baseline * c.stats.n : 0;
    upM += c.large.up.moves; upC += c.large.up.called; dnM += c.large.down.moves; dnC += c.large.down.called;
    resolved += c.origin.resolved; pending += c.origin.pending; sched += c.origin.scheduled; live += c.origin.live;
  }
  const ci = Ev.wilson(hits, n), baseline = n ? base / n : null;
  const verdict = !n ? 'NO_DATA' : ci.lo > baseline ? 'BEATS_BASELINE' : ci.hi < baseline ? 'BELOW_BASELINE' : 'WITHIN_NOISE';
  return {
    n, accuracy: n ? hits / n : null, baseline, delta: n ? (hits - base) / n : null, verdict,
    largeUp: { moves: upM, recall: upM >= Ev.MIN_LARGE_MOVES ? upC / upM : null },
    largeDown: { moves: dnM, recall: dnM >= Ev.MIN_LARGE_MOVES ? dnC / dnM : null },
    resolved, pending, scheduled: sched, live,
  };
}

// ---- rendering ---------------------------------------------------------------

const STATUS_UI = {
  IMPROVING: { label: 'Improving', cls: 'rd-st-good', icon: '↗' },
  NOT_IMPROVING: { label: 'Not improving', cls: 'rd-st-bad', icon: '↘' },
  INCONCLUSIVE: { label: 'Inconclusive', cls: 'rd-st-warn', icon: '≈' },
  BLOCKED: { label: 'Blocked', cls: 'rd-st-bad', icon: '⛔' },
};

const EVIDENCE_CLS = { promising: 'rd-b-good', negative: 'rd-b-bad', ready: 'rd-b-info', inconclusive: 'rd-b-warn', insufficient: 'rd-b-warn',
  not_started: 'rd-b-mute', blocked: 'rd-b-mute', diagnostic: 'rd-b-mute', unavailable: 'rd-b-bad', unknown: 'rd-b-mute' };

const badge = (label, cls) => `<span class="rd-badge ${cls}">${esc(label)}</span>`;
const tile = (title, value, sub, cls = '') => `<div class="rd-tile"><p class="rd-tile-t">${esc(title)}</p><p class="rd-tile-v ${cls}">${value}</p>${sub ? `<p class="rd-tile-s">${sub}</p>` : ''}</div>`;

export function renderOverview(m, changes = []) {
  const s = STATUS_UI[m.overall.status] || STATUS_UI.INCONCLUSIVE;
  const p = m.pooled;
  const largeVal = p.largeUp.recall == null && p.largeDown.recall == null ? INSUF
    : `↑ ${p.largeUp.recall == null ? '—' : esc(pct(p.largeUp.recall, 0))} · ↓ ${p.largeDown.recall == null ? '—' : esc(pct(p.largeDown.recall, 0))}`;
  const calibCells = m.cells.filter(c => c.ok && Number.isFinite(c.calib.skill));
  const skill = calibCells.length ? calibCells.reduce((a, c) => a + c.calib.skill * c.calib.n, 0) / calibCells.reduce((a, c) => a + c.calib.n, 0) : null;
  const f = m.findings;
  return `
  <div class="rd-card rd-hero">
    <div class="rd-hero-icon ${s.cls}">${s.icon}</div>
    <div>
      <p class="rd-label">Prediction performance (V2, all coins & horizons)</p>
      <p class="rd-hero-v ${s.cls}">${esc(s.label)}</p>
      <p class="rd-sub">${esc(m.overall.reason)}</p>
    </div>
  </div>
  <div class="rd-grid2">
    ${tile('Directional accuracy', p.n ? `<span class="${VERDICT_CLS[p.verdict] || ''}">${esc(pts(p.delta))}</span>` : INSUF, p.n ? `${esc(pct(p.accuracy))} vs ${esc(pct(p.baseline))} baseline · n=${p.n} · ${esc(p.verdict.replace(/_/g, ' ').toLowerCase())}` : 'vs always-same-direction baseline')}
    ${tile('Large moves called (≥3%)', largeVal, `${p.largeUp.moves} up / ${p.largeDown.moves} down moves resolved`)}
    ${tile('Calibration skill', skill == null ? INSUF : `${skill >= 0 ? '+' : ''}${esc((skill * 100).toFixed(1))}%`, 'Brier vs climatology (>0 = better)')}
    ${tile('Resolved / pending', `${p.resolved} / ${p.pending}`, `${p.scheduled} scheduled · ${p.live} live-fallback`)}
  </div>
  <div class="rd-card rd-note rd-note-info"><p class="rd-note-t">💡 Key finding</p><p>${esc(f.finding)}</p></div>
  <div class="rd-card rd-note rd-note-warn"><p class="rd-note-t">⚠ Main limitation</p><p>${esc(f.limitation)}</p></div>
  <div class="rd-card rd-note rd-note-good"><p class="rd-note-t">→ Next actions</p><ol>${f.actions.map(a => `<li>${esc(a)}</li>`).join('')}</ol></div>
  <div class="rd-card rd-row"><div><p class="rd-note-t">🏁 Next milestone</p><p class="rd-sub">${esc(f.milestone.text)}</p></div><p class="rd-date">${esc(f.milestone.date || '—')}</p></div>
  <div class="rd-card"><p class="rd-note-t">Since your last visit</p><ul class="rd-list">${changes.map(c => `<li>${esc(c)}</li>`).join('')}</ul></div>
  <div class="rd-card"><p class="rd-note-t">Four separate tracks (never blended)</p>${renderTracks(m)}</div>`;
}

/** Data collection / implementation / scientific evidence / production impact, each with its own status. */
export function renderTracks(m) {
  const fr = m.freshness;
  const coreRows = fr ? fr.rows.filter(r => r.track === 'core') : [];
  const fresh = coreRows.filter(r => r.status === 'FRESH').length;
  const exps = m.experiments;
  const concluded = exps.filter(e => e.conclusion).length;
  const ready = exps.filter(e => e.suggested_status === 'READY_FOR_ANALYSIS').length;
  const ad = m.adaptation;
  const rows = [
    ['Data collection', fr ? `${fresh}/${coreRows.length} core V2 series saving on schedule` : 'Persistence check unavailable'],
    ['Implementation', `${exps.length} registered experiments · ${exps.filter(e => /ACCUMULATING|COLLECTING|RUNNING/.test(e.status)).length} collecting`],
    ['Scientific evidence', `${concluded} concluded · ${ready} ready for analysis · ${exps.length - concluded - ready} still accumulating`],
    ['Production impact', `V2 model selection unchanged by V3 · V1 weighting ${ad ? esc(ad.mode) : 'unknown'} (defaults in use)`],
  ];
  return `<table class="rd-table rd-kv">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>`;
}

export function renderPerformance(m, sub = 'direction') {
  const tabs = [['direction', 'Direction'], ['large', 'Large moves'], ['calibration', 'Calibration'], ['origin', 'Origin'], ['regime', 'Regime']];
  const seg = `<div class="rd-seg">${tabs.map(([k, l]) => `<button data-rd-perf="${k}" class="${k === sub ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const label = (c) => `${c.coin} ${c.horizon}h`;
  const fail = (c) => `<tr><td>${label(c)}</td><td colspan="4">${UNAV} <span class="rd-muted">(${esc(c.error)})</span></td></tr>`;
  let body;
  if (sub === 'direction') {
    body = `<table class="rd-table"><tr><th>Series</th><th>Accuracy</th><th>Baseline</th><th>Δ</th><th>Verdict</th></tr>${m.cells.map(c => !c.ok ? fail(c) : !c.stats.n
      ? `<tr><td>${label(c)}</td><td colspan="4">${INSUF}</td></tr>`
      : `<tr><td>${label(c)}</td><td>${esc(pct(c.stats.accuracy))}<br><span class="rd-muted">n=${c.stats.n}</span></td><td>${esc(pct(c.stats.baseline))}<br><span class="rd-muted">always ${esc(c.stats.baselineDirection)}</span></td><td class="${VERDICT_CLS[c.stats.verdict] || ''}">${esc(pts(c.stats.delta))}</td><td>${esc(c.stats.verdict.replace(/_/g, ' ').toLowerCase())}<br><span class="rd-muted">30d: ${esc(c.trend.verdict.replace(/_/g, ' ').toLowerCase())}</span></td></tr>`).join('')}</table>
      <p class="rd-foot">Baseline = always predicting the cohort's more frequent direction. "Beats" requires the 95% Wilson interval to clear it. 30d trend = last 30 days vs the previous 30 (two-proportion test, ≥${Ev.MIN_TREND_PER_WINDOW} per window).</p>`;
  } else if (sub === 'large') {
    const side = (s) => (s.recall == null ? `${INSUF}<br><span class="rd-muted">${s.moves} move(s)</span>` : `${esc(pct(s.recall, 0))}<br><span class="rd-muted">${s.called}/${s.moves}</span>`);
    body = `<table class="rd-table"><tr><th>Series</th><th>Up moves called</th><th>Down moves called</th></tr>${m.cells.map(c => !c.ok ? fail(c)
      : `<tr><td>${label(c)}</td><td>${side(c.large.up)}</td><td>${side(c.large.down)}</td></tr>`).join('')}</table>
      <p class="rd-foot">Large move = realized |return| ≥ ${Ev.LARGE_MOVE_PCT}% over the horizon. Recall is shown only with ≥${Ev.MIN_LARGE_MOVES} such moves. Precision is not shown: V2 does not emit a separate large-move call.</p>`;
  } else if (sub === 'calibration') {
    body = `<table class="rd-table"><tr><th>Series</th><th>Brier</th><th>Climatology</th><th>Skill</th></tr>${m.cells.map(c => !c.ok ? fail(c) : c.calib.brier == null
      ? `<tr><td>${label(c)}</td><td colspan="3">${INSUF} <span class="rd-muted">(n=${c.calib.n})</span></td></tr>`
      : `<tr><td>${label(c)}</td><td>${esc(num(c.calib.brier))}</td><td>${esc(num(c.calib.climatology))}</td><td>${c.calib.skill >= 0 ? '+' : ''}${esc((c.calib.skill * 100).toFixed(1))}%</td></tr>`).join('')}</table>
      <p class="rd-foot">Lower Brier is better. Skill > 0 means the probabilities beat always forecasting the cohort's base rate.</p>`;
  } else if (sub === 'origin') {
    const acc = (s) => (s.n ? `${esc(pct(s.accuracy))} <span class="rd-muted">n=${s.n}</span>` : INSUF);
    body = `<table class="rd-table"><tr><th>Series</th><th>Resolved / pending</th><th>Scheduled</th><th>Live-fallback</th></tr>${m.cells.map(c => !c.ok ? fail(c)
      : `<tr><td>${label(c)}</td><td>${c.origin.resolved} / ${c.origin.pending}</td><td>${c.origin.scheduled}<br>${acc(c.statsScheduled)}</td><td>${c.origin.live}<br>${acc(c.statsLive)}</td></tr>`).join('')}</table>
      <p class="rd-foot">Scheduled = written by the 3-hourly cron (within 5 min of a 00/03/…/21 UTC tick); anything else is a live-fallback row.</p>`;
  } else {
    const rows = m.v4 ? m.v4.rows : [];
    body = `<p class="rd-sub">V2 predictions carry no market-regime label, so a regime split of V2 accuracy is <b>unavailable</b>. For reference only, V4 (an independent product) publishes its own regime-segmented win rates:</p>
      ${!m.v4 ? `<p class="rd-sub">${UNAV}${m.errors.v4 ? ` <span class="rd-muted">(${esc(m.errors.v4)})</span>` : ''}</p>` : !rows.length ? `<p class="rd-sub">${INSUF}</p>`
      : `<table class="rd-table"><tr><th>V4 asset</th><th>Horizon</th><th>Regime</th><th>Win rate</th></tr>${rows.map(r => `<tr><td>${esc(r.coin)}</td><td>${esc(r.horizon)}</td><td>${esc(r.regime)}</td><td>${r.status === 'OK' && r.winRate != null ? esc(pct(r.winRate)) : INSUF}<br><span class="rd-muted">n=${r.samples ?? '—'}</span></td></tr>`).join('')}</table>`}
      <p class="rd-foot">Read-only: /api/performance only. V4 is not compared with V2 here because its signals, horizons and cohorts differ.</p>`;
  }
  return `<div class="rd-card"><p class="rd-h">Model performance (V2 production predictions)</p>${seg}${body}</div>`;
}

function expFinding(e) {
  if (e.conclusion) return e.conclusion;
  const r = e.current_measured_result;
  if (typeof r === 'string' && r && r !== 'NOT_AVAILABLE') return r;
  if (r && typeof r === 'object') return JSON.stringify(r);
  return 'Not yet evaluated.';
}

export function renderExperimentCard(e) {
  const ev = Ev.evidenceStatus(e);
  const prog = Number.isFinite(e.progress_count) && Number.isFinite(e.required_sample) && e.required_sample > 0
    ? Math.min(1, e.progress_count / e.required_sample) : null;
  return `<div class="rd-card rd-exp">
    <div class="rd-row"><p class="rd-exp-t">${esc(registryTitle(e))}</p>${badge(ev.label, EVIDENCE_CLS[ev.key] || 'rd-b-mute')}</div>
    <p class="rd-sub"><b>Question:</b> ${esc(e.research_question)}</p>
    <p class="rd-sub"><b>Finding:</b> ${esc(expFinding(e))}</p>
    ${prog == null ? '' : `<div class="rd-bar"><span style="width:${(prog * 100).toFixed(0)}%"></span></div><p class="rd-muted">${e.progress_count} / ${e.required_sample} samples</p>`}
    <p class="rd-sub"><b>Next:</b> ${esc(e.next_action)} · <span class="rd-muted">${esc(formatEtaText(e.eta))}</span></p>
    <p class="rd-muted">Operational: ${esc(Ev.operationalStatus(e))}</p>
    <details class="rd-details"><summary>Technical details</summary><table class="rd-table rd-kv">
      ${[['Baseline', e.baseline], ['Success criterion', e.success_criterion], ['Sample', `${e.current_sample_size} (required ${e.required_sample ?? '—'})`],
        ['Out-of-sample', e.oos_result], ['Evidence maturity', e.confidence_evidence_maturity], ['Data last updated', dt(e.data_last_updated)],
        ['Live error', e.live_error || '—']].map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</td></tr>`).join('')}
    </table></details>
  </div>`;
}

export function renderCombinedCard(c) {
  return `<div class="rd-card rd-exp">
    <div class="rd-row"><p class="rd-exp-t">Combined factors · V1 composite leave-one-out</p>${badge(c.evidence.label, EVIDENCE_CLS[c.evidence.key] || 'rd-b-mute')}</div>
    <p class="rd-sub"><b>Question:</b> ${esc(c.question)}</p>
    <p class="rd-sub"><b>Finding:</b> ${esc(c.finding)}</p>
    <p class="rd-sub"><b>Next:</b> ${esc(c.next)} · <span class="rd-muted">${c.eta ? `ETA ≈ ${esc(c.eta)} (4 spaced samples/day, projection)` : 'ETA not estimable'}</span></p>
    <p class="rd-muted">Incremental value to V3 predictions: ${esc(c.v3)}. No combined-factor experiment is registered in V2 yet.</p>
  </div>`;
}

export function renderExperiments(m, filter = 'all') {
  const SHORT = { models: 'Models', sentiment: 'Sentiment', signals: 'Signals', combined: 'Combined', largemoves: 'Large moves', controls: 'Controls', other: 'Other' };
  const chips = [['all', 'All'], ...m.groups.map(g => [g.key, SHORT[g.key] || g.title])];
  const seg = `<div class="rd-chips">${chips.map(([k, l]) => `<button data-rd-exp="${k}" class="${k === filter ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>`;
  if (m.errors.registry) return `<div class="rd-card"><p class="rd-h">Experiments</p><p class="rd-sub">${UNAV} <span class="rd-muted">(${esc(m.errors.registry)})</span></p></div>`;
  const groups = m.groups.filter(g => filter === 'all' || g.key === filter);
  return `<div class="rd-card"><p class="rd-h">Experiments by contribution</p>${seg}</div>${groups.map(g => `
    <p class="rd-group">${esc(g.title)}</p>
    ${g.key === 'combined' ? renderCombinedCard(m.combined) : ''}
    ${g.items.length ? g.items.map(renderExperimentCard).join('') : g.key === 'combined' ? '' : '<p class="rd-muted rd-pad">No registered experiment in this group.</p>'}`).join('')}`;
}

const CAT_COLORS = { sentiment: '#4A90E2', derivatives: '#F39C12', onchain: '#2ECC71', macro: '#9B59B6', other: '#718096' };

export function renderFactors(m) {
  const a = m.adaptation;
  if (!a) return `<div class="rd-card"><p class="rd-h">Factors & contribution</p><p class="rd-sub">${UNAV} <span class="rd-muted">(V1 /weight-adaptation: ${esc(m.errors.adaptation)})</span></p></div>`;
  const bars = m.factors.map(c => `<div class="rd-barrow"><span>${esc(c.title)}</span><div class="rd-bar"><span style="width:${Math.min(100, c.sharePct).toFixed(0)}%;background:${CAT_COLORS[c.key]}"></span></div><span>${c.sharePct.toFixed(0)}%</span></div>`).join('');
  const pol = a.policy;
  const rows = m.factors.map(c => `<tr class="rd-cat"><td colspan="6">${esc(c.title)}</td></tr>${c.rows.map(r => `<tr>
      <td>${esc(r.id)}</td><td>${r.rawScore == null ? '<span class="rd-muted">—</span>' : esc(r.rawScore.toFixed(0))}</td>
      <td>${esc(r.configuredWeight)}×${esc(r.confidence)}</td><td>${r.effectiveSharePct == null ? '—' : esc(r.effectiveSharePct.toFixed(1)) + '%'}</td>
      <td>${r.compositePoints == null ? '<span class="rd-muted">—</span>' : esc(r.compositePoints.toFixed(1))}</td>
      <td>${r.v1LeaveOneOut ? `<span class="${Math.abs(r.v1LeaveOneOut.deltaPts) >= pol.minDeltaPts ? sign(r.v1LeaveOneOut.deltaPts) : ''}">${r.v1LeaveOneOut.deltaPts >= 0 ? '+' : ''}${esc(r.v1LeaveOneOut.deltaPts.toFixed(1))}</span> <span class="rd-muted">n=${r.v1LeaveOneOut.samples}</span>` : '<span class="rd-muted">—</span>'}</td></tr>`).join('')}`).join('');
  const { n_samples, persisted, run_ts } = Ev.adaptationEvidence(a);
  const ev = a.evaluation;
  const latestChanged = a.latest ? a.latest.changed : null;
  const hist = (a.history || []).slice(0, 5);
  return `
  <div class="rd-card"><p class="rd-h">Configured share of the V1 composite</p>${bars}
    <p class="rd-foot">Share = weight × confidence over all sources (default weights, before renormalising over the sources that answered). This is configuration, not measured contribution.</p></div>
  <div class="rd-card"><p class="rd-h">Per-factor view (four quantities, kept separate)</p>
    <div class="rd-scroll"><table class="rd-table rd-factors"><tr><th>Source</th><th>Raw</th><th>W×conf</th><th>Share</th><th>Pts in V1</th><th>V1 Δhit</th></tr>${rows}</table></div>
    <p class="rd-foot">Raw = latest V1 score (0–100) ${m.v1 ? `at ${esc(dt(m.v1.ts))}; V1 composite ${m.v1.score == null ? '—' : esc(m.v1.score.toFixed(1))}` : `— ${UNAV}`}. Pts in V1 = raw × share (approximate; V1 renormalises over answering sources and boosts the Foufi driver). V1 Δhit = leave-one-out change in V1's next-24h BTC hit rate (in-sample, needs ≥${pol.minSamples} samples). <b>Incremental value to V3 predictions: not measured</b> — V3 models do not consume V1 factors.</p></div>
  <div class="rd-card"><p class="rd-h">Automatic V1 weighting</p>
    <div class="rd-row"><span>Status</span>${badge(a.mode === 'active' ? 'Active' : 'Shadow mode', a.mode === 'active' ? 'rd-b-good' : 'rd-b-warn')}</div>
    <p class="rd-sub">Proposals never change V1's weights on their own. Owner approval in V1 Settings is required, and only after an out-of-sample improvement vs the unchanged defaults.</p>
    <table class="rd-table rd-kv">
      <tr><td>Last run</td><td>${persisted ? esc(dt(run_ts)) : 'No scheduled run yet (first at 06:00 UTC) — preview below is unsaved'}</td></tr>
      <tr><td>Spaced samples</td><td>${n_samples ?? '—'} (need ${pol.minSamples})</td></tr>
      <tr><td>Proposed changes</td><td>${persisted ? esc(Array.isArray(latestChanged) ? latestChanged.join(', ') || 'none' : latestChanged ? String(latestChanged) : 'none') : esc((a.preview && a.preview.reason) || '—')}</td></tr>
      <tr><td>vs fixed weights</td><td>${ev ? `${esc(ev.verdict.replace(/_/g, ' ').toLowerCase())}${Number.isFinite(ev.shadow_hit_pct) ? ` · shadow ${esc(ev.shadow_hit_pct.toFixed(1))}% vs baseline ${esc(ev.baseline_hit_pct.toFixed(1))}% (n=${ev.samples_after})` : ''}` : INSUF}</td></tr>
      <tr><td>Bounds</td><td>${pol.minFactor}–${pol.maxFactor}× default · ≤${pol.maxStepPct}%/step · ≤${pol.maxSharePct}% share · Δ≥${pol.minDeltaPts} pts</td></tr>
      <tr><td>Next action</td><td>${esc(Ev.adaptationNextAction(a))}</td></tr>
    </table>
    ${hist.length ? `<p class="rd-note-t" style="margin-top:8px">Recent runs</p><ul class="rd-list">${hist.map(h => `<li>${esc(dt(h.run_ts))} · ${esc(h.mode)} · ${esc(h.reason)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

// ---- DOM glue -----------------------------------------------------------------

function readSnapshot() { try { return JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || 'null'); } catch (_) { return null; } }
function writeSnapshot(s) { try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(s)); } catch (_) { /* private mode */ } }

/**
 * @param {HTMLElement} root
 * @param {{ fetchers: object, onTab?: (tab:string)=>void }} opts
 */
export function mountResearchDashboard(root, { fetchers, onTab } = {}) {
  const state = { tab: 'overview', perf: 'direction', exp: 'all', model: null, changes: [], loadedAt: 0, loading: null };
  try { state.tab = localStorage.getItem('cp3_research_tab') || 'overview'; } catch (_) { /* ignore */ }

  const tabsHtml = () => `<div class="rd-tabs">${[['overview', 'Overview'], ['performance', 'Performance'], ['experiments', 'Experiments'], ['factors', 'Factors']]
    .map(([k, l]) => `<button data-rd-tab="${k}" class="${state.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;

  function render() {
    const m = state.model;
    const head = `<div class="rd-head"><div><p class="rd-title">CryptoPulse <span class="rd-v3">V3</span></p><p class="rd-muted">Research dashboard · read-only</p></div>
      <div class="rd-right"><p class="rd-muted">Last refresh</p><p class="rd-small">${state.loadedAt ? esc(dt(state.loadedAt)) : '—'}</p></div></div>`;
    let body;
    if (!m) body = `<div class="rd-card"><p class="rd-sub">${state.loading ? 'Loading live data…' : 'Not loaded.'}</p></div>`;
    else if (state.tab === 'performance') body = renderPerformance(m, state.perf);
    else if (state.tab === 'experiments') body = renderExperiments(m, state.exp);
    else if (state.tab === 'factors') body = renderFactors(m);
    else body = renderOverview(m, state.changes);
    root.innerHTML = head + tabsHtml() + `<div class="rd-body">${body}</div>`;
    if (onTab) onTab(state.tab);
  }

  root.addEventListener('click', (ev) => {
    const t = ev.target.closest('button');
    if (!t || !root.contains(t)) return;
    if (t.dataset.rdTab) { state.tab = t.dataset.rdTab; try { localStorage.setItem('cp3_research_tab', state.tab); } catch (_) { /* ignore */ } render(); }
    else if (t.dataset.rdPerf) { state.perf = t.dataset.rdPerf; render(); }
    else if (t.dataset.rdExp) { state.exp = t.dataset.rdExp; render(); }
  });

  async function load({ force = false } = {}) {
    if (state.loading) return state.loading;
    if (!force && state.model && Date.now() - state.loadedAt < REFRESH_MS) { render(); return; }
    state.loading = (async () => {
      render();
      const chartJobs = [];
      for (const coin of COINS) for (const h of HORIZONS) chartJobs.push(fetchers.chart(coin, h).then(r => [`${coin}-${h}`, r]));
      const [charts, freshness, registry, v1Latest, adaptation, hloi, v4] = await Promise.all([
        Promise.all(chartJobs).then(Object.fromEntries), fetchers.freshness(), fetchers.registry(),
        fetchers.v1Latest(), fetchers.adaptation(), fetchers.hloi(), fetchers.v4(),
      ]);
      const now = Date.now();
      const model = buildModel({ charts, freshness, registry, v1Latest, adaptation, hloi, v4 }, now);
      const snap = Ev.snapshotOf(model);
      const prev = readSnapshot();
      // "Since your last visit" compares with the last snapshot from an
      // earlier day, so it survives several opens on the same day.
      const day = new Date(now).toISOString().slice(0, 10);
      if (!prev || prev.day !== day) writeSnapshot({ day, base: prev ? prev.cur : null, cur: snap });
      else writeSnapshot({ ...prev, cur: snap });
      state.changes = Ev.diffSnapshots(prev ? (prev.day !== day ? prev.cur : prev.base) : null, snap);
      state.model = model; state.loadedAt = now;
    })().finally(() => { state.loading = null; render(); });
    return state.loading;
  }

  render();
  return { load, render, state };
}
