// ui/research-controls.js -- Research Controls rendering and the execution summary
// shown on the Overview. Pure: data in, HTML out (tested in
// tests/research-controls.test.js). Execution status here never feeds the
// research outcome or the data-quality status.

import * as C from '../api/controls.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dt = (ts) => (Number.isFinite(ts) ? new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');
const dts = (ts) => (Number.isFinite(ts) ? new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—');
const sha7 = (s) => (s ? String(s).slice(0, 7) : '—');
const badge = (label, cls) => `<span class="status-badge rd-badge ${cls}">${esc(label)}</span>`;
const kv = (rows) => `<dl class="rd-kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

export const STATE_UI = {
  QUEUED: ['Queued', 'status-neutral'], RUNNING: ['Running', 'status-neutral'], SUCCEEDED: ['Succeeded', 'status-ok'],
  FAILED: ['Failed', 'status-error'], BLOCKED: ['Blocked', 'status-warning'],
};
const POLICY_UI = {
  ELIGIBLE: ['Run now available', 'status-ok'], SCHEDULE_ONLY: ['Scheduled only', 'rd-badge-mute'],
  AUTH_REQUIRED: ['Needs owner authorization outside V3', 'status-warning'], PROTECTED: ['Protected evaluation', 'status-warning'],
};

/** Execution dimension for the Overview: what the job runs say, nothing about data or research. */
export function summarizeExecution(ctl, now = Date.now()) {
  if (!ctl || !Array.isArray(ctl.runs)) {
    return { status: 'UNVERIFIED', label: 'Unable to verify', detail: ctl && ctl.pollError ? `GitHub run status could not be read (${ctl.pollError}).` : 'GitHub run status has not been read yet.' };
  }
  const tracked = new Set(C.JOBS.filter(j => j.workflow).map(j => j.workflow));
  const runs = ctl.runs.filter(r => tracked.has(r.workflow)).sort((a, b) => b.created_at - a.created_at);
  const active = runs.filter(r => C.ACTIVE.has(C.runState(r)));
  const done = runs.filter(r => C.TERMINAL.has(C.runState(r)));
  const failed24 = done.filter(r => C.runState(r) === 'FAILED' && r.updated_at > now - 86400000);
  const last = done[0];
  const stale = ctl.pollError ? ` Latest status check failed (${ctl.pollError}); shown as of ${dt(ctl.lastOkPollAt)}.` : '';
  if (active.length) return { status: 'RUNNING', label: `${active.length} running`, detail: `${active.map(r => `${r.name || r.workflow} (${C.triggerLabel(r.event)}, ${C.runState(r).toLowerCase()})`).join(', ')}.${stale}` };
  if (!last) return { status: 'NONE', label: 'No recent runs', detail: `No run of a tracked job in the latest GitHub run list.${stale}` };
  const st = C.runState(last);
  return { status: st === 'SUCCEEDED' ? 'LAST_SUCCEEDED' : 'LAST_FAILED', label: `Last run ${STATE_UI[st][0].toLowerCase()}`,
    detail: `${last.name || last.workflow} · ${C.triggerLabel(last.event)} · ${dt(last.updated_at)}${failed24.length ? ` · ${failed24.length} failed in the last 24 h` : ''}.${stale}` };
}

/** What a refresh changed in the Overview's authoritative fields. */
export function summarizeModelChange(prev, next) {
  if (!prev || !next) return { changed: [], unchanged: [] };
  const fields = [
    ['Research outcome', (m) => m.overall.status],
    ['Data quality', (m) => m.dataQuality.status],
    ['Resolved predictions', (m) => m.pooled.resolved],
    ['Pending predictions', (m) => m.pooled.pending],
    ['Latest V2 persistence check', (m) => m.dataQuality.asOf],
    ['Experiments eligible for evaluation', (m) => m.experiments.filter(e => e.suggested_status === 'READY_FOR_ANALYSIS').map(e => e.experiment_id).join(', ') || 'none'],
    ['Experiment data updates', (m) => m.experiments.map(e => `${e.experiment_id}:${e.data_last_updated ?? '-'}`).join('|')],
  ];
  const changed = [], unchanged = [];
  for (const [name, f] of fields) {
    const a = f(prev), b = f(next);
    if (a === b) unchanged.push(name);
    else changed.push(name === 'Experiment data updates' ? name : name === 'Latest V2 persistence check' ? `${name}: ${dts(a)} → ${dts(b)}` : `${name}: ${a} → ${b}`);
  }
  return { changed, unchanged };
}

export function renderExecutionTile(ctl, now = Date.now()) {
  const s = summarizeExecution(ctl, now);
  const cls = s.status === 'LAST_FAILED' ? 'rd-neg' : s.status === 'UNVERIFIED' ? 'rd-muted' : '';
  const after = ctl && ctl.lastExecutionRefresh;
  return `<div class="rd-metric"><p class="rd-metric-t">Execution</p><p class="rd-metric-v ${cls}">${esc(s.label)}</p>
    <p class="rd-metric-s">${esc(s.detail)}${after ? `<br>${esc(afterRunLine(after))}` : ''}</p></div>`;
}

export function afterRunLine(a) {
  return `After run #${a.runId} (${a.trigger}, ${a.state.toLowerCase()}): Overview refresh ${a.refreshOk ? `succeeded at ${dt(a.refreshedAt)}` : `failed at ${dt(a.refreshedAt)} — values are not current`}.`;
}

function jobCard(job, ctl, now) {
  const runs = C.runsFor(job, ctl.runs);
  const latest = runs[0];
  const el = C.eligibility(job, ctl.runs || [], ctl.pending || {}, now);
  const [plabel, pcls] = POLICY_UI[job.policy];
  const lastDone = runs.find(r => C.TERMINAL.has(C.runState(r)));
  const next = C.nextCronRun(job.schedule, now);
  const statusTxt = !Array.isArray(ctl.runs) ? '<span class="rd-muted">Unable to verify (GitHub status not read)</span>'
    : latest ? `${badge(...STATE_UI[C.runState(latest)])} <span class="rd-muted">${esc(C.triggerLabel(latest.event))} · #${latest.id} · ${esc(sha7(latest.head_sha))}</span>`
      : `<span class="rd-muted">${job.workflow ? 'No run in the latest GitHub run list' : 'No execution mechanism'}</span>`;
  const rows = [
    ['Status', statusTxt],
    ['Last execution', lastDone ? `${esc(dt(lastDone.updated_at))} · ${esc(C.triggerLabel(lastDone.event))} · ${esc(STATE_UI[C.runState(lastDone)][0])}${lastDone.url ? ` · <a href="${esc(lastDone.url)}" target="_blank" rel="noopener">run #${lastDone.id}</a>` : ''}` : '—'],
    ['Next scheduled', job.schedule ? `${esc(dt(next))} <span class="rd-muted">(cron ${esc(job.schedule)} UTC; GitHub may start scheduled runs late)</span>` : 'Not scheduled'],
    ['Pinned version', esc(job.pinned)],
    ['Eligibility', el.canRun ? (job.policy === 'PROTECTED' ? 'Needs explicit authorization' : 'Eligible') : esc(el.reason)],
  ];
  let action = '';
  if (job.policy === 'ELIGIBLE') {
    action = renderDispatchAction(job, ctl, el);
  } else if (job.policy === 'PROTECTED') {
    action = `<button type="button" class="rd-btn rd-btn-ghost" data-rd-review="${esc(job.id)}">${ctl.review === job.id ? 'Close review' : 'Review and authorize'}</button>${ctl.review === job.id ? renderReview(job, ctl) : ''}`;
  }
  return `<article class="rd-src rd-job" data-job="${esc(job.id)}">
    <div class="rd-row rd-wrap"><p class="rd-src-t">${esc(job.name)}</p>${badge(plabel, pcls)}</div>
    <p class="rd-sub">${esc(job.purpose)}</p>${kv(rows)}${action}</article>`;
}

/** Dispatcher readiness for the UI, from GET /health (public). */
export function dispatcherReadiness(ctl) {
  const d = ctl.dispatcher;
  if (!d) return { ready: false, label: 'Checking the dispatcher…' };
  if (!d.ok) return { ready: false, label: `Dispatcher unreachable (${d.error}). Live dispatch is unavailable.` };
  if (!d.enabled) return { ready: false, label: 'Dispatcher deployed, but live dispatch is disabled: its secrets are not provisioned (dispatcher/README.md).' };
  return { ready: true, label: `Dispatcher ready${d.version ? ` (version ${String(d.version).slice(0, 7)})` : ''}.` };
}

export function renderDispatchAction(job, ctl, el) {
  const r = dispatcherReadiness(ctl);
  const d = job.dispatch || {};
  const ld = ctl.lastDispatch && ctl.lastDispatch.jobId === job.id ? ctl.lastDispatch : null;
  const busy = ctl.dispatching === job.id;
  let lastLine = '';
  if (ld) {
    if (ld.error) lastLine = `<p class="rd-sub rd-errs">Dispatch not accepted: ${esc(ld.error)}</p>`;
    else if (ld.runId) lastLine = `<p class="rd-sub">Dispatch accepted ${esc(dt(ld.acceptedAt))}. <b>Run <a href="${esc(ld.runUrl || '#')}" target="_blank" rel="noopener">#${esc(ld.runId)}</a> verified on GitHub</b>; its status is shown above.</p>`;
    else if (ld.unknown) lastLine = `<p class="rd-sub rd-errs">${esc(ld.unknown)}</p>`;
    else lastLine = `<p class="rd-sub">Dispatch accepted by GitHub at ${esc(dt(ld.acceptedAt))} (dispatch ${esc(String(ld.dispatchId || '').slice(0, 8))}). <b>Not started yet</b> — waiting for GitHub to list the run.</p>`;
  }
  const keyBlock = ctl.keySet
    ? `<p class="rd-muted">Owner dispatch key set ${ctl.keyRemembered ? 'on this device' : 'for this browser session'}. <button type="button" class="rd-linkbtn" data-rd-key-forget="1">Forget key</button></p>`
    : `<label class="rd-field">Owner dispatch key<input type="password" data-rd-keyinput="1" autocomplete="off" spellcheck="false" placeholder="paste the owner key"></label>
       <label class="rd-check"><input type="checkbox" data-rd-keyremember="1" ${ctl.keyRememberChoice ? 'checked' : ''}> Remember on this device (otherwise kept for this session only)</label>
       <button type="button" class="rd-btn rd-btn-ghost" data-rd-key-save="1">Use this key</button>`;
  const confirmOpen = ctl.confirm === job.id;
  const confirmPanel = confirmOpen ? `<div class="rd-review">
      ${kv([['Job', esc(job.name)], ['Workflow', `<code>${esc(job.workflow)}</code> · id ${esc(d.workflowId)}`], ['Branch / commit', esc(d.ref)], ['Inputs', esc(d.inputs)], ['Repository', 'quiquandon-oss/PulseWorkerV2 (fixed)']])}
      <label class="rd-check"><input type="checkbox" data-rd-confirmack="${esc(job.id)}" ${ctl.confirmAck ? 'checked' : ''}> Start this job now.</label>
      <button type="button" class="rd-btn" data-rd-launch="${esc(job.id)}" ${ctl.confirmAck && el.canRun && r.ready && ctl.keySet && !busy ? '' : 'disabled'}>${busy ? 'Dispatching…' : 'Launch'}</button>
      <button type="button" class="rd-btn rd-btn-ghost" data-rd-confirm="${esc(job.id)}">Cancel</button></div>` : '';
  return `<p class="rd-muted rd-mt">${esc(r.label)}</p>
    ${r.ready ? keyBlock : ''}
    ${r.ready ? `<button type="button" class="rd-btn" data-rd-confirm="${esc(job.id)}" ${el.canRun && ctl.keySet && !confirmOpen ? '' : 'disabled'}>Run now</button>${confirmPanel}` : ''}
    ${lastLine}
    ${!r.ready && job.workflow ? `<p class="rd-foot">Alternative while live dispatch is unavailable: <a href="${esc(C.dispatchUrl(job))}" target="_blank" rel="noopener" data-rd-ghpage="${esc(job.id)}">start it on GitHub ↗</a> (your GitHub sign-in starts it).</p>` : ''}
    <p class="rd-foot">"Accepted" means GitHub accepted the dispatch; the run counts as started only once GitHub lists it.</p>`;
}

export function renderReview(job, ctl) {
  const p = job.protected;
  const input = (ctl.authInput && ctl.authInput[job.id]) || {};
  const v = C.validateAuthorization(job, input);
  return `<div class="rd-review">
    ${kv([['Evaluation', esc(p.evaluation)], ['Frozen specification', esc(p.spec)], ['Definition sha256', `<code>${esc(p.definition_sha256)}</code>`],
      ['Plan sha256', `<code>${esc(p.plan_sha256)}</code>`], ['Input period', esc(p.period)], ['Code', esc(job.pinned)]])}
    <p class="rd-note-t rd-mt">Safeguards that still apply</p><ul class="rd-list">${p.safeguards.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
    <p class="rd-sub">This authorizes this evaluation only. It grants no production data access and cannot change the frozen definition or plan.</p>
    <label class="rd-check"><input type="checkbox" data-rd-ack="${esc(job.id)}" ${input.acknowledged ? 'checked' : ''}> I reviewed the specification, period and safeguards.</label>
    <label class="rd-field">Type <code>${esc(C.confirmationPhrase(job))}</code> to confirm<input type="text" data-rd-phrase="${esc(job.id)}" value="${esc(input.phrase || '')}" autocomplete="off" spellcheck="false"></label>
    <button type="button" class="rd-btn" data-rd-authorize="${esc(job.id)}" ${v.ok ? '' : 'disabled'}>Authorize and launch</button>
    ${v.errors.length ? `<ul class="rd-list rd-errs">${v.errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

export function renderControls(ctl, now = Date.now()) {
  const poll = !ctl.lastPollAt ? 'GitHub run status not read yet.'
    : ctl.pollError ? `Last status check ${dt(ctl.lastPollAt)} failed (${ctl.pollError}); showing status as of ${dt(ctl.lastOkPollAt)} — not current.`
      : `Run status from GitHub, checked ${dt(ctl.lastPollAt)}${Number.isFinite(ctl.rate && ctl.rate.remaining) ? ` · API requests left this hour: ${ctl.rate.remaining}` : ''}.`;
  const audit = (ctl.audit || []).slice(0, 15);
  return `<section class="rd-card"><p class="rd-h">Research controls</p>
    <p class="rd-muted rd-mb">${esc(poll)} Execution status shows whether a job ran; it is not evidence about data quality or prediction improvement.</p>
    ${ctl.lastExecutionRefresh ? `<div class="rd-card rd-note-info rd-after"><p class="rd-note-t">${esc(afterRunLine(ctl.lastExecutionRefresh))}</p>
      ${ctl.lastExecutionRefresh.changed.length ? `<p class="rd-sub"><b>Changed:</b> ${esc(ctl.lastExecutionRefresh.changed.join('; '))}</p>` : '<p class="rd-sub"><b>Changed:</b> nothing in the Overview.</p>'}
      ${ctl.lastExecutionRefresh.unchanged.length ? `<p class="rd-sub"><b>Unchanged:</b> ${esc(ctl.lastExecutionRefresh.unchanged.join(', '))}</p>` : ''}
      ${ctl.lastExecutionRefresh.blocker ? `<p class="rd-sub"><b>Unresolved:</b> ${esc(ctl.lastExecutionRefresh.blocker)}</p>` : ''}</div>` : ''}
    <div class="rd-src-grid">${C.JOBS.map(j => jobCard(j, ctl, now)).join('')}</div>
    <details class="rd-details"><summary>Not exposed in V3 (${C.NOT_EXPOSED.length})</summary><div class="rd-details-body">${kv(C.NOT_EXPOSED.map(([w, r]) => [w, esc(r)]))}</div></details>
    <details class="rd-details"><summary>Activity on this device (${(ctl.audit || []).length})</summary><div class="rd-details-body">
      ${audit.length ? `<ul class="rd-list">${audit.map(a => `<li>${esc(dt(a.at))} · ${esc(a.kind)} · ${esc(a.job || a.workflow || '')}${a.run_id ? ` · run #${a.run_id}` : ''}${a.trigger ? ` · ${esc(a.trigger)}` : ''}${a.head_sha ? ` · ${esc(sha7(a.head_sha))}` : ''} · ${esc(a.result || '')}</li>`).join('')}</ul>` : '<p class="rd-muted">No activity recorded on this device.</p>'}
      <p class="rd-foot">Stored in this browser only. GitHub's run history is the authoritative execution record.</p></div></details>
  </section>`;
}
