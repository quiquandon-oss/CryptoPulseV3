import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../api/controls.js';

const NOW = Date.UTC(2026, 9, 11, 17, 30);
const job = (id) => C.JOBS.find(j => j.id === id);
const run = (o) => ({ id: 1, workflow: 'prediction-freshness-check.yml', event: 'workflow_dispatch', status: 'completed', conclusion: 'success', created_at: NOW - 3600000, updated_at: NOW - 3500000, head_sha: 'abc1234def', ...o });

test('only the read-only persistence check is eligible for Run now; D1 jobs need outside authorization', () => {
  assert.deepEqual(C.JOBS.filter(j => j.policy === 'ELIGIBLE').map(j => j.workflow), ['prediction-freshness-check.yml']);
  for (const id of ['export-learning-data', 'exp004-timesfm', 'exp005-source-effectiveness', 'live-evidence-collection']) {
    const e = C.eligibility(job(id), [], {}, NOW);
    assert.equal(e.canRun, false); assert.equal(e.state, 'AUTH_REQUIRED'); assert.match(e.reason, /production D1/);
  }
  const x = C.eligibility(job('exp23-forward-evaluation'), [], {}, NOW);
  assert.equal(x.state, 'SCHEDULE_ONLY'); assert.equal(x.canRun, false);
});

test('a protected evaluation without an execution mechanism is blocked with the missing infrastructure', () => {
  const e = C.eligibility(job('market-moves-evaluation'), [], {}, NOW);
  assert.equal(e.state, 'BLOCKED'); assert.match(e.reason, /workflow_dispatch workflow/); assert.match(e.reason, /server-side dispatcher/);
});

test('duplicate-run prevention: an active run disables Run now', () => {
  const j = job('prediction-freshness-check');
  assert.equal(C.eligibility(j, [run({ status: 'completed' })], {}, NOW).canRun, true);
  for (const status of ['queued', 'in_progress']) {
    const e = C.eligibility(j, [run({ status, conclusion: null })], {}, NOW);
    assert.equal(e.canRun, false); assert.equal(e.state, 'IN_PROGRESS');
  }
});

test('a Run now request is not shown as started until GitHub lists a manual run after it', () => {
  const j = job('prediction-freshness-check');
  const pending = { [j.id]: NOW - 30000 };
  assert.equal(C.eligibility(j, [run({ created_at: NOW - 3600000 })], pending, NOW).state, 'AWAITING_CONFIRMATION');
  assert.equal(C.eligibility(j, [run({ id: 2, created_at: NOW - 10000 })], pending, NOW).canRun, true);
  assert.equal(C.eligibility(j, [], { [j.id]: NOW - C.PENDING_DISPATCH_WINDOW_MS - 1 }, NOW).canRun, true);
});

test('run states and scheduled vs manual labelling', () => {
  assert.equal(C.runState(run({ status: 'queued', conclusion: null })), 'QUEUED');
  assert.equal(C.runState(run({ status: 'in_progress', conclusion: null })), 'RUNNING');
  assert.equal(C.runState(run({})), 'SUCCEEDED');
  for (const c of ['failure', 'cancelled', 'timed_out', 'startup_failure']) assert.equal(C.runState(run({ conclusion: c })), 'FAILED');
  assert.equal(C.runState(run({ status: 'waiting', conclusion: null })), 'BLOCKED');
  assert.equal(C.runState(run({ conclusion: 'action_required' })), 'BLOCKED');
  assert.equal(C.triggerLabel('schedule'), 'Scheduled'); assert.equal(C.triggerLabel('workflow_dispatch'), 'Manual');
});

test('protected evaluation confirmation needs acknowledgement, the exact phrase and an execution mechanism', () => {
  const real = job('market-moves-evaluation');
  const phrase = C.confirmationPhrase(real);
  assert.equal(phrase, '51d94913b601');
  assert.equal(C.validateAuthorization(real, { acknowledged: true, phrase }).ok, false); // no mechanism today
  const withMech = { ...real, mechanism: 'test' };
  assert.equal(C.validateAuthorization(withMech, {}).ok, false);
  assert.equal(C.validateAuthorization(withMech, { acknowledged: true, phrase: 'wrong' }).ok, false);
  assert.equal(C.validateAuthorization(withMech, { acknowledged: false, phrase }).ok, false);
  assert.equal(C.validateAuthorization(withMech, { acknowledged: true, phrase }).ok, true);
  assert.equal(C.validateAuthorization(job('prediction-freshness-check'), { acknowledged: true, phrase }).ok, false);
  const rec = C.authorizationRecord(withMech, NOW);
  assert.equal(rec.plan_sha256, real.protected.plan_sha256); assert.equal(rec.run_id, null);
  assert.doesNotMatch(JSON.stringify(rec), /token|secret|bearer/i);
});

test('transitions: nothing on the first observation, then queued -> running -> succeeded', () => {
  assert.deepEqual(C.detectTransitions(null, [run({ status: 'queued', conclusion: null })]), []);
  const q = [run({ status: 'queued', conclusion: null })];
  const r = [run({ status: 'in_progress', conclusion: null })];
  assert.deepEqual(C.detectTransitions(q, r).map(x => [x.from, x.to]), [['QUEUED', 'RUNNING']]);
  assert.deepEqual(C.detectTransitions(r, [run({})]).map(x => [x.from, x.to]), [['RUNNING', 'SUCCEEDED']]);
  assert.deepEqual(C.detectTransitions(r, [run({}), run({ id: 9, status: 'queued', conclusion: null })]).map(x => x.to), ['SUCCEEDED', 'QUEUED']);
});

test('nextCronRun for the jobs\' schedules (UTC)', () => {
  assert.equal(C.nextCronRun('10 12 * * *', NOW), Date.UTC(2026, 9, 12, 12, 10));
  assert.equal(new Date(C.nextCronRun('0 9 * * 1', NOW)).getUTCDay(), 1);
  assert.equal(C.nextCronRun('0 */6 * * *', NOW), Date.UTC(2026, 9, 11, 18, 0));
  assert.equal(C.nextCronRun(null, NOW), null);
});

test('fetchRuns sends no credential, uses ETag, and handles 304 and rate limiting', async () => {
  const calls = [];
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = async (url, opts) => { calls.push({ url, headers: opts.headers });
      const hdr = new Map([['etag', 'W/"x"'], ['x-ratelimit-remaining', '59'], ['x-ratelimit-reset', '1']]);
      if (opts.headers['If-None-Match']) return { status: 304, ok: false, headers: { get: k => hdr.get(k) } };
      return { status: 200, ok: true, headers: { get: k => hdr.get(k) }, json: async () => ({ workflow_runs: [{ id: 5, path: '.github/workflows/prediction-freshness-check.yml', event: 'schedule', status: 'completed', conclusion: 'success', created_at: '2026-10-11T10:00:00Z', updated_at: '2026-10-11T10:01:00Z', html_url: 'u' }] }) };
    };
    const a = await C.fetchRuns({});
    assert.equal(a.ok, true); assert.equal(a.runs[0].workflow, 'prediction-freshness-check.yml'); assert.equal(a.etag, 'W/"x"');
    const b = await C.fetchRuns({ etag: a.etag });
    assert.equal(b.notModified, true);
    for (const c of calls) { assert.equal(c.headers.Authorization, undefined); assert.match(c.url, /^https:\/\/api\.github\.com\/repos\/quiquandon-oss\/PulseWorkerV2\/actions\/runs/); }
    globalThis.fetch = async () => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => ({ workflow_runs: [] }) });
    assert.equal((await C.fetchRuns({})).rate.remaining, null); // header not exposed -> unknown, not 0
    globalThis.fetch = async () => ({ status: 403, ok: false, headers: { get: k => (k === 'x-ratelimit-remaining' ? '0' : '1') } });
    assert.match((await C.fetchRuns({})).error, /rate limit/);
  } finally { globalThis.fetch = orig; }
});

test('dispatcher endpoint is the dedicated Worker; GitHub page stays only as a fallback link', () => {
  assert.equal(C.DISPATCH_ENDPOINT, 'https://cryptopulse-research-dispatcher.quiquandon.workers.dev');
  assert.equal(C.dispatchUrl(job('prediction-freshness-check')), 'https://github.com/quiquandon-oss/PulseWorkerV2/actions/workflows/prediction-freshness-check.yml');
  assert.deepEqual(job('prediction-freshness-check').dispatch.workflowId, 381092876);
});

function stubFetch(handler) { const calls = []; const orig = globalThis.fetch; globalThis.fetch = async (url, opts = {}) => { calls.push({ url, opts }); return handler(url, opts); }; return { calls, restore: () => { globalThis.fetch = orig; } }; }
const resp = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: k => headers[k] ?? null }, json: async () => body });

test('dispatchJob sends only job/confirm/request_id with the key to the dispatcher, and accepted is not started', async () => {
  const f = stubFetch(() => resp(202, { ok: true, status: 'accepted', dispatch_id: 'd-1', accepted_at: NOW, workflow_id: 381092876, ref: 'main' }));
  try {
    const r = await C.dispatchJob('prediction-freshness-check', 'k'.repeat(32), { requestId: 'req-abcdefgh' });
    assert.deepEqual(r, { ok: true, status: 'accepted', dispatchId: 'd-1', acceptedAt: NOW, workflowId: 381092876, ref: 'main' });
    assert.equal(f.calls[0].url, 'https://cryptopulse-research-dispatcher.quiquandon.workers.dev/dispatch');
    assert.deepEqual(JSON.parse(f.calls[0].opts.body), { job: 'prediction-freshness-check', confirm: true, request_id: 'req-abcdefgh' });
    assert.equal(f.calls[0].opts.headers.Authorization, `Bearer ${'k'.repeat(32)}`);
  } finally { f.restore(); }
});

test('dispatchJob maps auth, conflict, rate-limit, disabled, upstream and network failures to explicit errors', async () => {
  const cases = [
    [resp(401, { code: 'unauthorized' }), 'unauthorized', /rejected/],
    [resp(409, { code: 'conflict', reason: 'run_active', run_id: 99 }), 'conflict', /Run #99 is already active/],
    [resp(409, { code: 'conflict', reason: 'dispatch_in_flight' }), 'conflict', /already in flight/],
    [resp(429, { code: 'rate_limited' }, { 'Retry-After': '90' }), 'rate_limited', /Retry in 90 s/],
    [resp(503, { code: 'dispatch_disabled' }), 'dispatch_disabled', /not provisioned/],
    [resp(502, { code: 'upstream_auth' }), 'upstream_auth', /credential/],
    [resp(503, { code: 'upstream_rate_limited' }, { 'Retry-After': '60' }), 'upstream_rate_limited', /rate limit/],
    [resp(504, { code: 'upstream_timeout' }), 'upstream_timeout', /did not respond/],
  ];
  for (const [r, code, msg] of cases) {
    const f = stubFetch(() => r);
    try { const out = await C.dispatchJob('prediction-freshness-check', 'k'.repeat(32)); assert.equal(out.ok, false); assert.equal(out.code, code); assert.match(out.message, msg); } finally { f.restore(); }
  }
  const net = stubFetch(() => { throw new TypeError('Failed to fetch'); });
  try { assert.equal((await C.dispatchJob('prediction-freshness-check', 'k'.repeat(32))).code, 'unreachable'); } finally { net.restore(); }
  const none = stubFetch(() => resp(500, {}));
  try { const out = await C.dispatchJob('prediction-freshness-check', ''); assert.equal(out.code, 'unauthorized'); assert.equal(none.calls.length, 0); } finally { none.restore(); }
});

test('fetchDispatcherHealth reads enabled/version without a credential', async () => {
  const f = stubFetch(() => resp(200, { ok: true, dispatch_enabled: false, version: 'abc1234def', jobs: ['prediction-freshness-check'] }));
  try {
    assert.deepEqual(await C.fetchDispatcherHealth(), { ok: true, enabled: false, version: 'abc1234def', jobs: ['prediction-freshness-check'] });
    assert.equal(f.calls[0].opts.headers, undefined);
  } finally { f.restore(); }
});
