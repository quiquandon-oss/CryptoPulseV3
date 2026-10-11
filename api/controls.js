// api/controls.js -- Research Controls: which PulseWorkerV2 jobs exist, which can
// be started from V3, and what GitHub says about their runs.
//
// Execution status comes only from GitHub's public Actions API for the public
// PulseWorkerV2 repository (no token in the browser). V3 has no server-side
// dispatcher holding a GitHub credential, so "Run now" uses GitHub's own
// workflow_dispatch page, where the owner is signed in; V3 reports a run as
// started only once GitHub lists it. See docs/RESEARCH_CONTROLS.md for the
// verified inventory and the missing infrastructure.
//
// Execution status is independent of data quality and of research outcome: a
// succeeded run proves only that the job ran.

import { fetchWithTimeout } from './pulseworker.js';

export const JOB_REPO = Object.freeze({ owner: 'quiquandon-oss', repo: 'PulseWorkerV2', ref: 'main' });
export const GITHUB_API = 'https://api.github.com';
// Server-side dispatcher (PulseWorkerV2 dispatcher/, Worker cryptopulse-research-dispatcher). It holds the
// GitHub credential; V3 only sends the owner key the owner types in, and only to this origin.
export const DISPATCH_ENDPOINT = 'https://cryptopulse-research-dispatcher.quiquandon.workers.dev';
export const PENDING_DISPATCH_WINDOW_MS = 10 * 60000;

/**
 * Trigger policy, verified against the workflow files on PulseWorkerV2 main (dff12cc):
 *  ELIGIBLE        workflow_dispatch exists, no secrets, no writes -> may be started from V3.
 *  AUTH_REQUIRED   reads production D1 with the Cloudflare token: production data access needs the
 *                  owner's explicit authorization outside V3; a click here cannot grant it.
 *  SCHEDULE_ONLY   no workflow_dispatch trigger by approved design; cannot be started manually.
 *  PROTECTED       a frozen, sealed evaluation that needs an explicit, recorded authorization.
 */
export const JOBS = Object.freeze([
  { id: 'prediction-freshness-check', workflow: 'prediction-freshness-check.yml', name: 'V2 persistence check',
    purpose: 'Reads /prediction-freshness, V1 /hl-oi and the experiment registry (public endpoints). No secrets, writes nothing.',
    schedule: null, policy: 'ELIGIBLE', pinned: 'workflow file on main', affects: ['dataQuality'],
    dispatch: { via: 'dispatcher', workflowId: 381092876, ref: 'main (fixed by the dispatcher; cannot be changed from V3)', inputs: 'None permitted' } },
  { id: 'exp23-forward-evaluation', workflow: 'exp23-forward-evaluation.yml', name: 'EXP-23 forward evaluation',
    purpose: 'Daily forward evaluation of the BTC 12-hour early-warning spec v0.4.0; writes only research-data/exp23-evaluation.',
    schedule: '10 12 * * *', policy: 'SCHEDULE_ONLY', pinned: '111eea180f897ecf5eff2df2316e45c842ef00d6',
    reason: 'Schedule-only by its approved design (no workflow_dispatch). A manual run would need a reviewed change to the workflow.', affects: ['experiments'] },
  { id: 'research-forward-schedule', workflow: 'research-forward-schedule.yml', name: 'Risk-regime forward collection',
    purpose: 'Daily collection into research-data/risk-regime-forward (input to EXP-23).',
    schedule: '40 10 * * *', policy: 'SCHEDULE_ONLY', pinned: 'workflow file on main',
    reason: 'Schedule-only by its approved design (no workflow_dispatch).', affects: ['experiments'] },
  { id: 'export-learning-data', workflow: 'export-learning-data.yml', name: 'Learning-data export',
    purpose: 'Exports prediction and selection tables to data-exports/ on main.',
    schedule: '0 8 * * *', policy: 'AUTH_REQUIRED', pinned: 'workflow file on main',
    reason: 'Reads production D1 with the Cloudflare token and pushes to main. Production data access needs explicit owner authorization outside V3.', affects: ['experiments'] },
  { id: 'exp004-timesfm', workflow: 'exp004-timesfm.yml', name: 'EXP-004 TimesFM run',
    purpose: 'Daily TimesFM forecasts for the EXP-004 comparison.', schedule: '30 7 * * *', policy: 'AUTH_REQUIRED', pinned: 'workflow file on main',
    reason: 'Uses the Cloudflare token against production D1. Needs explicit owner authorization outside V3.', affects: ['experiments'] },
  { id: 'exp005-source-effectiveness', workflow: 'exp005-source-effectiveness.yml', name: 'EXP-005 source effectiveness',
    purpose: 'Weekly V1 source-effectiveness research.', schedule: '0 9 * * 1', policy: 'AUTH_REQUIRED', pinned: 'workflow file on main',
    reason: 'Uses the Cloudflare token against production D1. Needs explicit owner authorization outside V3.', affects: ['experiments'] },
  { id: 'exp009-event-source-evidence', workflow: 'exp009-event-source-evidence.yml', name: 'EXP-009 event-source evidence',
    purpose: 'Weekly event/source evidence research.', schedule: '0 10 * * 1', policy: 'AUTH_REQUIRED', pinned: 'workflow file on main',
    reason: 'Uses the Cloudflare token against production D1. Needs explicit owner authorization outside V3.', affects: ['experiments'] },
  { id: 'exp010-source-dialogue-validation', workflow: 'exp010-source-dialogue-validation.yml', name: 'EXP-010 source-dialogue validation',
    purpose: 'Weekly source-dialogue validation.', schedule: '0 11 * * 1', policy: 'AUTH_REQUIRED', pinned: 'workflow file on main',
    reason: 'Uses the Cloudflare token against production D1. Needs explicit owner authorization outside V3.', affects: ['experiments'] },
  { id: 'live-evidence-collection', workflow: 'live-evidence-collection.yml', name: 'Live event & evidence collection',
    purpose: 'Six-hourly event and evidence collection.', schedule: '0 */6 * * *', policy: 'AUTH_REQUIRED', pinned: 'workflow file on main',
    reason: 'Uses the Cloudflare token against production D1. Needs explicit owner authorization outside V3.', affects: ['experiments'] },
  { id: 'market-moves-evaluation', workflow: null, name: 'Market-move detection: sealed evaluation period',
    purpose: 'Scores detectors B0h/B1/B2/B3 on the untouched evaluation period of plan v1.0.0.',
    schedule: null, policy: 'PROTECTED', pinned: '4ea1bc1 (research/market_moves/evaluate.py)',
    protected: {
      evaluation: 'research/market_moves/evaluate.py --period evaluation',
      spec: 'definition market-moves-primary v1.0.0 · evaluation plan market-moves-evaluation v1.0.0',
      definition_sha256: 'c3ef65830c3bf729354749a94c2038c072fa72f99b5977608f41aa6bd19c0b92',
      plan_sha256: '51d94913b6011a966ffd7b881e3f47509e20dc176b1c6ba4c821dfd084d2e41d',
      period: '2026-07-22T00:00:00Z to 2026-10-09T21:00:00Z (scored); data snapshot research-data/market-moves @ 0eb5be0',
      safeguards: [
        'The evaluator refuses unless it is given the plan sha256; this authorization supplies it and nothing else.',
        'Frozen definition and plan are verified against their pinned sha256 before anything is computed.',
        'Snapshot files are verified against the plan\'s pinned hashes; no production data (no D1) is read.',
        'Writes only a report; definitions, thresholds and detectors cannot change.',
        'Per the plan\'s claims rule, no detector is called better because it detects more events.',
      ],
    },
    mechanism: null,
    missing: 'No workflow runs research/market_moves/evaluate.py. Launching from V3 needs (1) a reviewed workflow_dispatch workflow on PulseWorkerV2 main taking the plan sha256 as input, with contents: write limited to a research-data branch, and (2) a server-side dispatcher holding a GitHub credential, behind owner authentication.',
    affects: ['experiments'] },
]);

/** Workflows deliberately not exposed in V3 (deploys, audits, staging), with the reason. */
export const NOT_EXPOSED = Object.freeze([
  ['deploy.yml', 'Production Worker deploy (push-triggered)'],
  ['canary-audit.yml', 'Uses Cloudflare and GitHub write tokens'],
  ['production-chain-audit.yml', 'Writes audit results to main'],
  ['deploy-stage7-staging.yml', 'Staging deploy'],
  ['stage7-research-pipeline.yml', 'Staging pipeline'],
  ['stage7-staging-dispatcher.yml', 'Starts other workflows (actions: write)'],
  ['test.yml', 'CI and staging jobs'],
]);

// ---- runs ----------------------------------------------------------------

export function normalizeRun(r) {
  if (!r || typeof r !== 'object' || !Number.isFinite(r.id)) return null;
  const path = typeof r.path === 'string' ? r.path : '';
  return {
    id: r.id, workflow: path.split('/').pop() || null, name: r.name || null, event: r.event || null,
    status: r.status || null, conclusion: r.conclusion ?? null, head_sha: r.head_sha || null, head_branch: r.head_branch || null,
    created_at: Date.parse(r.created_at) || null, started_at: Date.parse(r.run_started_at) || null,
    updated_at: Date.parse(r.updated_at) || null, url: r.html_url || null, attempt: r.run_attempt ?? 1,
  };
}

/** GitHub run -> one of QUEUED | RUNNING | SUCCEEDED | FAILED | BLOCKED. */
export function runState(run) {
  if (!run) return null;
  if (['queued', 'requested', 'pending'].includes(run.status)) return 'QUEUED';
  if (run.status === 'waiting' || run.conclusion === 'action_required') return 'BLOCKED';
  if (run.status === 'in_progress') return 'RUNNING';
  if (run.status === 'completed') {
    if (run.conclusion === 'success') return 'SUCCEEDED';
    if (run.conclusion === 'skipped' || run.conclusion === 'neutral') return 'SUCCEEDED';
    return 'FAILED'; // failure, cancelled, timed_out, startup_failure, stale
  }
  return 'QUEUED';
}
export const ACTIVE = new Set(['QUEUED', 'RUNNING']);
export const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'BLOCKED']);

export function triggerLabel(event) {
  return event === 'schedule' ? 'Scheduled' : event === 'workflow_dispatch' ? 'Manual' : event === 'push' ? 'Push' : event || 'Unknown';
}

export function runsFor(job, runs) {
  return job.workflow ? (runs || []).filter(r => r.workflow === job.workflow).sort((a, b) => b.created_at - a.created_at) : [];
}

/**
 * Whether V3 may offer "Run now" for a job right now.
 * pending: { [jobId]: requestedAt } -- set when the owner opened GitHub's Run workflow page.
 */
export function eligibility(job, runs, pending = {}, now = Date.now()) {
  if (job.policy === 'SCHEDULE_ONLY') return { canRun: false, state: 'SCHEDULE_ONLY', reason: job.reason };
  if (job.policy === 'AUTH_REQUIRED') return { canRun: false, state: 'AUTH_REQUIRED', reason: job.reason };
  if (job.policy === 'PROTECTED' && !job.mechanism) return { canRun: false, state: 'BLOCKED', reason: `Blocked: ${job.missing}` };
  const mine = runsFor(job, runs);
  const active = mine.find(r => ACTIVE.has(runState(r)) || runState(r) === 'BLOCKED' && r.status !== 'completed');
  if (active) return { canRun: false, state: 'IN_PROGRESS', reason: `Run #${active.id} is ${runState(active).toLowerCase()}; a second run is not started while one is active.` };
  const req = pending[job.id];
  if (Number.isFinite(req) && now - req < PENDING_DISPATCH_WINDOW_MS) {
    const seen = mine.find(r => r.event === 'workflow_dispatch' && r.created_at >= req - 60000);
    if (!seen) return { canRun: false, state: 'AWAITING_CONFIRMATION', reason: 'Waiting for GitHub to list the run you started; it is not shown as started until GitHub confirms it.' };
  }
  return { canRun: true, state: job.policy === 'PROTECTED' ? 'NEEDS_AUTHORIZATION' : 'ELIGIBLE', reason: null };
}

/** GitHub's own Run workflow page for a job (the owner's GitHub sign-in authorizes the dispatch). */
export function dispatchUrl(job) {
  return job.workflow ? `https://github.com/${JOB_REPO.owner}/${JOB_REPO.repo}/actions/workflows/${job.workflow}` : null;
}

// ---- protected evaluations -------------------------------------------------

/** The confirmation phrase: the first 12 characters of the frozen plan sha256 the evaluation will run under. */
export function confirmationPhrase(job) {
  return job.protected ? job.protected.plan_sha256.slice(0, 12) : null;
}

export function validateAuthorization(job, input) {
  const errors = [];
  if (!job || job.policy !== 'PROTECTED' || !job.protected) errors.push('Not a protected evaluation.');
  else {
    if (!input || input.acknowledged !== true) errors.push('Confirm that you reviewed the specification, period and safeguards.');
    if (!input || String(input.phrase || '').trim() !== confirmationPhrase(job)) errors.push(`Type the first 12 characters of the plan sha256 (${confirmationPhrase(job)}) to confirm.`);
    if (!job.mechanism) errors.push(`Cannot launch: ${job.missing}`);
  }
  return { ok: errors.length === 0, errors };
}

/** Audit record for an authorization. It records intent and identity of what was authorized; never a secret. */
export function authorizationRecord(job, now = Date.now()) {
  return { kind: 'authorization', at: now, job: job.id, evaluation: job.protected.evaluation, spec: job.protected.spec,
    plan_sha256: job.protected.plan_sha256, definition_sha256: job.protected.definition_sha256, period: job.protected.period,
    pinned: job.pinned, run_id: null, result: 'AUTHORIZED_NOT_YET_LAUNCHED' };
}

// ---- transitions, audit ----------------------------------------------------

/** Runs whose state changed since the previous poll (a new run counts, from null). */
export function detectTransitions(prev, runs) {
  if (!Array.isArray(prev)) return []; // first observation: nothing to compare with
  const before = new Map(prev.map(r => [r.id, runState(r)]));
  const out = [];
  for (const r of runs || []) {
    const to = runState(r), from = before.has(r.id) ? before.get(r.id) : null;
    if (from !== to) out.push({ run: r, from, to });
  }
  return out;
}

export function appendAudit(list, entry, max = 100) {
  return [entry, ...(Array.isArray(list) ? list : [])].slice(0, max);
}

// ---- cron (the subset the jobs use: numbers, *, */n, lists, ranges; day-of-month and month must be *) ----

function field(spec, lo, hi) {
  const vals = new Set();
  for (const part of spec.split(',')) {
    const [range, stepS] = part.split('/');
    const step = stepS ? Number(stepS) : 1;
    let [a, b] = range === '*' ? [lo, hi] : range.split('-').map(Number);
    if (b === undefined) b = stepS ? hi : a;
    for (let v = a; v <= b; v += step) vals.add(v);
  }
  return vals;
}

/** Next UTC time a cron fires after `now`, or null for unsupported expressions. GitHub may start it later. */
export function nextCronRun(cron, now = Date.now()) {
  if (!cron) return null;
  const [m, h, dom, mon, dow] = cron.trim().split(/\s+/);
  if (dom !== '*' || mon !== '*') return null;
  const M = field(m, 0, 59), Hs = field(h, 0, 23), W = field(dow, 0, 6);
  const start = Math.floor(now / 60000) * 60000 + 60000;
  for (let t = start; t < now + 8 * 86400000; t += 60000) {
    const d = new Date(t);
    if (M.has(d.getUTCMinutes()) && Hs.has(d.getUTCHours()) && W.has(d.getUTCDay())) return t;
  }
  return null;
}

// ---- adapter ---------------------------------------------------------------

/**
 * Recent runs of the job repository from GitHub's public API. Uses ETag so an
 * unchanged list costs no rate limit (304). Never sends a credential.
 */
export async function fetchRuns({ etag = null, perPage = 60, apiBase = GITHUB_API } = {}) {
  try {
    const headers = { Accept: 'application/vnd.github+json' };
    if (etag) headers['If-None-Match'] = etag;
    const res = await fetchWithTimeout(`${apiBase}/repos/${JOB_REPO.owner}/${JOB_REPO.repo}/actions/runs?per_page=${perPage}`, { headers, timeoutMs: 10000 });
    // Missing headers (not exposed via CORS) stay unknown -- never read as 0.
    const hdr = (k) => { const v = res.headers.get(k); return v == null || v === '' ? null : Number(v); };
    const reset = hdr('x-ratelimit-reset');
    const rate = { remaining: hdr('x-ratelimit-remaining'), reset: reset == null ? null : reset * 1000 };
    if (res.status === 304) return { ok: true, notModified: true, etag, rate };
    if (!res.ok) return { ok: false, error: res.status === 403 && rate.remaining === 0 ? 'GitHub API rate limit reached' : `HTTP ${res.status}`, rate };
    const body = await res.json();
    const runs = (body.workflow_runs || []).map(normalizeRun).filter(Boolean);
    return { ok: true, notModified: false, etag: res.headers.get('etag'), runs, rate };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'timeout' : String((e && e.message) || e) };
  }
}

// ---- dispatcher adapter ------------------------------------------------------

const DISPATCH_ERRORS = {
  unauthorized: 'The owner dispatch key was rejected. Check the key; repeated failures are rate-limited.',
  rate_limited: 'Rate limited by the dispatcher.',
  conflict: 'A run of this job is already active.',
  dispatch_disabled: 'Dispatch is disabled: the dispatcher secrets are not provisioned.',
  job_not_allowed: 'This job is not allowlisted on the dispatcher.',
  origin_not_allowed: 'The dispatcher refused this page\'s origin.',
  upstream_auth: 'GitHub rejected the dispatcher\'s credential (expired or insufficient permission).',
  upstream_rate_limited: 'GitHub\'s API rate limit was reached.',
  upstream_timeout: 'GitHub did not respond in time.',
  upstream_not_found: 'GitHub did not find the allowlisted workflow.',
  upstream_rejected: 'GitHub rejected the dispatch.',
  workflow_mismatch: 'The allowlisted workflow is missing, renamed or disabled on GitHub.',
};

/** Dispatcher health: whether live dispatch is enabled. Public, no credential. */
export async function fetchDispatcherHealth({ base = DISPATCH_ENDPOINT } = {}) {
  if (!base) return { ok: false, error: 'no dispatcher configured' };
  try {
    const res = await fetchWithTimeout(`${base}/health`, { timeoutMs: 8000 });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const b = await res.json();
    return { ok: true, enabled: b.dispatch_enabled === true, version: typeof b.version === 'string' ? b.version : null, jobs: Array.isArray(b.jobs) ? b.jobs : [] };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'timeout' : 'dispatcher unreachable' };
  }
}

/**
 * Ask the dispatcher to start an allowlisted job. Sends only {job, confirm, request_id}; the owner key goes in the
 * Authorization header to the dispatcher origin only. An accepted result means GitHub accepted the dispatch -- the
 * run is not started until GitHub lists it.
 */
export async function dispatchJob(jobId, ownerKey, { base = DISPATCH_ENDPOINT, requestId } = {}) {
  if (!base) return { ok: false, code: 'no_dispatcher', message: 'No dispatcher configured.' };
  if (!ownerKey) return { ok: false, code: 'unauthorized', message: 'Enter the owner dispatch key first.' };
  try {
    const res = await fetchWithTimeout(`${base}/dispatch`, {
      method: 'POST', timeoutMs: 20000,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerKey}` },
      body: JSON.stringify({ job: jobId, confirm: true, ...(requestId ? { request_id: requestId } : {}) }),
    });
    let b = null;
    try { b = await res.json(); } catch (_) { b = null; }
    if (res.status === 202 && b && b.status === 'accepted') {
      return { ok: true, status: 'accepted', dispatchId: b.dispatch_id, acceptedAt: b.accepted_at, workflowId: b.workflow_id, ref: b.ref };
    }
    const code = (b && (b.reason === 'run_active' ? 'conflict' : b.code)) || `http_${res.status}`;
    const retry = Number(res.headers.get('Retry-After'));
    let message = DISPATCH_ERRORS[code] || (b && b.message) || `Dispatcher returned HTTP ${res.status}.`;
    if (b && b.reason === 'run_active' && b.run_id) message = `Run #${b.run_id} is already active; no second run was started.`;
    if (b && b.reason === 'dispatch_in_flight') message = 'A dispatch for this job is already in flight.';
    if (Number.isFinite(retry) && retry > 0) message += ` Retry in ${retry} s.`;
    return { ok: false, code, status: res.status, message, runId: b && b.run_id ? b.run_id : null };
  } catch (e) {
    return { ok: false, code: e && e.name === 'AbortError' ? 'timeout' : 'unreachable', message: e && e.name === 'AbortError' ? 'The dispatcher did not respond in time; the dispatch may or may not have been accepted — check the run list before retrying.' : 'The dispatcher could not be reached.' };
  }
}
