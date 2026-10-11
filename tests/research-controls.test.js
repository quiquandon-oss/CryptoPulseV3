import test from 'node:test';
import assert from 'node:assert/strict';
import { mountResearchDashboard, mergeSources, buildModel, renderOverview } from '../ui/research-dashboard.js';
import { renderControls, renderDispatchAction, summarizeExecution, summarizeModelChange } from '../ui/research-controls.js';
import { JOBS } from '../api/controls.js';
import { acceptSource } from '../api/dataquality.js';

const H = 3600000;
let clock = Date.UTC(2026, 9, 11, 17, 30);
const p = (i, o = {}) => { const ts = Date.UTC(2026, 9, 1) + i * 3 * H; return { ts, target_ts: ts + 24 * H, direction: 'UP', p_up: 0.6, correct: i % 2 === 0, actualMove: 0.5, ...o }; };
const freshRows = (bad = {}) => ['BTC', 'ETH', 'LINK'].flatMap(coin => ['12', '24'].map(horizon => ({ coin, horizon, track: 'core', status: bad[`${coin}-${horizon}`] || 'FRESH', latest_ts: clock - H })));
const run = (o) => ({ id: 77, workflow: 'prediction-freshness-check.yml', name: 'Prediction Freshness Check', event: 'workflow_dispatch', status: 'completed', conclusion: 'success', created_at: clock - 60000, updated_at: clock, head_sha: 'dff12ccd94', url: 'https://github.com/x', ...o });

// minimal stand-ins for the DOM the mount uses; timers are captured, not run
function harness({ fetchersOver = {}, runsScript, dispatchJob = async () => ({ ok: false, code: 'x', message: 'x' }), health = { ok: true, enabled: true, version: 'abc1234' } }) {
  globalThis.document = { hidden: false, activeElement: null };
  const store = () => ({ _m: new Map(), getItem(k) { return this._m.get(k) ?? null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } });
  globalThis.localStorage = store(); globalThis.sessionStorage = store();
  const timers = [];
  globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  globalThis.clearTimeout = () => {};
  const root = { innerHTML: '', isConnected: true, offsetParent: {}, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, contains: () => false };
  const loads = { n: 0 };
  let fresh = { ok: true, generated_ts: clock - 30000, rows: freshRows() };
  const fetchers = {
    chart: async () => { return { ok: true, predictions: [...Array(30)].map((_, i) => p(i)) }; },
    freshness: async () => { loads.n++; return typeof fresh === 'function' ? fresh() : fresh; },
    registry: async () => ({ ok: true, experiments: [] }),
    v1Latest: async () => ({ ok: true, ts: clock, score: 50, sources: {} }),
    adaptation: async () => ({ ok: true, mode: 'shadow', policy: { minSamples: 30, minDeltaPts: 2, minFactor: 0.5, maxFactor: 1.5, maxStepPct: 10, maxSharePct: 20 }, defaults: { fng: [2, 1] }, default_shares_pct: { fng: 100 }, latest: null, preview: { n_samples: 0, evidence: {} }, evaluation: null, history: [] }),
    hloi: async () => ({ ok: true, status: 'INSUFFICIENT_HISTORY' }),
    ...fetchersOver,
  };
  let k = 0;
  const api = mountResearchDashboard(root, { fetchers, fetchRuns: async () => runsScript[Math.min(k++, runsScript.length - 1)], dispatchJob, fetchHealth: async () => health, now: () => clock, openUrl: () => {} });
  return { api, root, loads, setFresh: (f) => { fresh = f; }, timers };
}

test('Overview refreshes on queued/started (rate-limited) and always on completion; success is recorded with what changed', async () => {
  const h = harness({ runsScript: [
    { ok: true, runs: [], etag: 'a' },
    { ok: true, runs: [run({ status: 'queued', conclusion: null })], etag: 'b' },
    { ok: true, runs: [run({ status: 'in_progress', conclusion: null })], etag: 'c' },
    { ok: true, runs: [run({})], etag: 'd' },
  ] });
  await h.api.load({ force: true });
  const base = h.loads.n;
  await h.api.poll();                       // first observation
  await h.api.poll(); clock += 1000;        // a new queued run appears -> refresh is rate-limited (just loaded)
  assert.equal(h.loads.n, base);
  clock += 3 * 60000;
  await h.api.poll();                       // running -> interim refresh allowed
  assert.equal(h.loads.n, base + 1);
  clock += 1000;
  await h.api.poll();                       // succeeded -> final refresh, always
  assert.equal(h.loads.n, base + 2);
  const after = h.api.state.ctl.lastExecutionRefresh;
  assert.equal(after.state, 'SUCCEEDED'); assert.equal(after.trigger, 'Manual'); assert.equal(after.refreshOk, true);
  assert.ok(Array.isArray(after.changed) && Array.isArray(after.unchanged));
  assert.ok(h.api.state.ctl.audit.some(a => a.kind === 'overview-refresh' && a.run_id === 77 && a.head_sha === 'dff12ccd94'));
  assert.equal(h.api.state.lastSuccessAt, after.refreshedAt);
});

test('failed and blocked executions also trigger a final refresh and are reported as such', async () => {
  for (const [o, want] of [[{ conclusion: 'failure' }, 'FAILED'], [{ conclusion: 'action_required' }, 'BLOCKED']]) {
    const h = harness({ runsScript: [{ ok: true, runs: [run({ status: 'in_progress', conclusion: null })] }, { ok: true, runs: [run(o)] }] });
    await h.api.poll(); const before = h.loads.n;
    await h.api.poll();
    assert.equal(h.loads.n, before + 1);
    assert.equal(h.api.state.ctl.lastExecutionRefresh.state, want);
  }
});

test('a refresh that fails after a run leaves an explicit not-current state, never a healthy one', async () => {
  const h = harness({ runsScript: [{ ok: true, runs: [run({ status: 'in_progress', conclusion: null })] }, { ok: true, runs: [run({})] }] });
  await h.api.load({ force: true });
  assert.equal(h.api.state.model.dataQuality.status, 'HEALTHY');
  h.setFresh({ ok: false, error: 'HTTP 503' });
  await h.api.poll(); clock += 60000; await h.api.poll();
  const r = h.api.state.ctl.lastExecutionRefresh;
  assert.equal(r.refreshOk, false); assert.match(r.blocker, /freshness/);
  assert.equal(h.api.state.model.dataQuality.status, 'UNVERIFIED');
  assert.ok(h.api.state.model.staleSources.some(s => s.name === 'freshness' && s.stale));
  assert.match(renderOverview(h.api.state.model, { lastSuccessAt: h.api.state.lastSuccessAt }), /Not current/);
});

test('a stale response does not overwrite a newer verified result', () => {
  const t = clock;
  let held = {};
  held = mergeSources(held, { freshness: { ok: true, generated_ts: t, rows: freshRows() } }, { seq: 2, fetchedAt: t }).held;
  const late = mergeSources(held, { freshness: { ok: true, generated_ts: t - 3 * H, rows: freshRows({ 'BTC-12': 'STALE' }) } }, { seq: 3, fetchedAt: t + 1 });
  assert.equal(late.values.freshness.rows.find(r => r.coin === 'BTC' && r.horizon === '12').status, 'FRESH');
  const outOfOrder = mergeSources(held, { freshness: { ok: true, generated_ts: t + 1, rows: freshRows({ 'BTC-12': 'STALE' }) } }, { seq: 1, fetchedAt: t + 2 });
  assert.equal(outOfOrder.values.freshness.rows.find(r => r.coin === 'BTC' && r.horizon === '12').status, 'FRESH');
});

test('execution, data quality and research outcome stay independent', () => {
  const d = { charts: Object.fromEntries(['BTC', 'ETH', 'LINK'].flatMap(c => [12, 24].map(hh => [`${c}-${hh}`, { ok: true, predictions: [...Array(30)].map((_, i) => p(i)) }]))),
    registry: { ok: true, experiments: [] }, freshness: { ok: true, generated_ts: clock - 1000, rows: freshRows({ 'BTC-24': 'STALE' }) } };
  const bad = buildModel(d, clock);
  const good = buildModel({ ...d, freshness: { ok: true, generated_ts: clock - 1000, rows: freshRows() } }, clock);
  assert.equal(bad.dataQuality.status, 'PROBLEM'); assert.equal(good.dataQuality.status, 'HEALTHY');
  assert.equal(bad.overall.status, good.overall.status);                         // data quality never changes research outcome
  const ctl = { runs: [run({})] };
  assert.equal(summarizeExecution(ctl, clock).status, 'LAST_SUCCEEDED');          // a succeeded run says nothing about data
  assert.equal(summarizeExecution({ runs: [run({ conclusion: 'failure' })] }, clock).status, 'LAST_FAILED');
  assert.equal(summarizeExecution({ runs: null, pollError: 'timeout' }, clock).status, 'UNVERIFIED');
});

test('Research controls render scheduled vs manual, disable duplicates, and keep protected launch blocked', () => {
  const ctl = { runs: [run({ status: 'in_progress', conclusion: null }), run({ id: 5, workflow: 'exp23-forward-evaluation.yml', event: 'schedule' })], pending: {}, audit: [], lastPollAt: clock, lastOkPollAt: clock, review: 'market-moves-evaluation', authInput: {},
    dispatcher: { ok: true, enabled: true, version: 'abc1234' }, keySet: true };
  const html = renderControls(ctl, clock);
  assert.match(html, /data-rd-confirm="prediction-freshness-check" disabled>Run now/);
  assert.match(html, /Manual · #77/); assert.match(html, /Scheduled · #5/);
  assert.match(html, /Needs owner authorization outside V3/);
  assert.match(html, /data-rd-authorize="market-moves-evaluation" disabled/);
  assert.match(html, /Cannot launch: No workflow runs research\/market_moves\/evaluate.py/);
  assert.match(html, /51d94913b6011a966ffd7b881e3f47509e20dc176b1c6ba4c821dfd084d2e41d/);
  assert.doesNotMatch(html, /token=|Bearer /);
});

test('summarizeModelChange lists changed and unchanged Overview fields', () => {
  const a = { overall: { status: 'INCONCLUSIVE' }, dataQuality: { status: 'PROBLEM', asOf: 1 }, pooled: { resolved: 10, pending: 2 }, experiments: [] };
  const b = { ...a, dataQuality: { status: 'HEALTHY', asOf: 2 }, pooled: { resolved: 12, pending: 2 } };
  const c = summarizeModelChange(a, b);
  assert.ok(c.changed.some(x => /Data quality: PROBLEM → HEALTHY/.test(x)) && c.changed.some(x => /Resolved predictions: 10 → 12/.test(x)));
  assert.ok(c.unchanged.includes('Research outcome') && c.unchanged.includes('Pending predictions'));
});

const job = JOBS.find(j => j.id === 'prediction-freshness-check');
const el = { canRun: true };

test('dispatch action: disabled or unreachable dispatcher shows why, no Run now, GitHub page only as a fallback', () => {
  for (const d of [{ ok: true, enabled: false }, { ok: false, error: 'dispatcher unreachable' }]) {
    const html = renderDispatchAction(job, { dispatcher: d }, el);
    assert.doesNotMatch(html, /data-rd-confirm=/);
    assert.match(html, d.ok ? /live dispatch is disabled/ : /Dispatcher unreachable/);
    assert.match(html, /data-rd-ghpage="prediction-freshness-check"/);
  }
});

test('dispatch action: key entry, explicit confirmation with job/branch/inputs, launch disabled until confirmed', () => {
  const ready = { dispatcher: { ok: true, enabled: true, version: 'abc1234' } };
  assert.match(renderDispatchAction(job, { ...ready, keySet: false }, el), /type="password" data-rd-keyinput/);
  assert.match(renderDispatchAction(job, { ...ready, keySet: false }, el), /data-rd-confirm="prediction-freshness-check" disabled/);
  const open = renderDispatchAction(job, { ...ready, keySet: true, confirm: job.id, confirmAck: false }, el);
  assert.match(open, /prediction-freshness-check\.yml<\/code> · id 381092876/); assert.match(open, /main \(fixed by the dispatcher/); assert.match(open, /None permitted/);
  assert.match(open, /data-rd-launch="prediction-freshness-check" disabled/);
  assert.doesNotMatch(renderDispatchAction(job, { ...ready, keySet: true, confirm: job.id, confirmAck: true }, el), /data-rd-launch="prediction-freshness-check" disabled/);
  assert.match(renderDispatchAction(job, { ...ready, keySet: true, confirm: job.id, confirmAck: true }, { canRun: false }), /data-rd-launch="prediction-freshness-check" disabled/);
});

test('dispatch action distinguishes accepted from started, and shows the verified run id', () => {
  const ready = { dispatcher: { ok: true, enabled: true }, keySet: true };
  const acc = renderDispatchAction(job, { ...ready, lastDispatch: { jobId: job.id, dispatchId: 'abcdef123', acceptedAt: clock, runId: null } }, el);
  assert.match(acc, /Dispatch accepted by GitHub/); assert.match(acc, /Not started yet/); assert.doesNotMatch(acc, /verified on GitHub/);
  const ver = renderDispatchAction(job, { ...ready, lastDispatch: { jobId: job.id, dispatchId: 'abcdef123', acceptedAt: clock, runId: 31415, runUrl: 'https://github.com/r/31415' } }, el);
  assert.match(ver, /Run <a href="https:\/\/github.com\/r\/31415"[^>]*>#31415<\/a> verified on GitHub/);
  assert.match(renderDispatchAction(job, { ...ready, lastDispatch: { jobId: job.id, error: 'GitHub rejected the dispatch.' } }, el), /Dispatch not accepted: GitHub rejected the dispatch/);
});

test('launch flow: accepted dispatch waits for GitHub, then the real run id is recorded and the Overview refreshes on completion', async () => {
  let sent = null;
  const h = harness({
    dispatchJob: async (id, key, o) => { sent = { id, key, o }; return { ok: true, status: 'accepted', dispatchId: 'disp-1', acceptedAt: clock, workflowId: 381092876, ref: 'main' }; },
    runsScript: [{ ok: true, runs: [] }, { ok: true, runs: [] }, { ok: true, runs: [run({ id: 9001, status: 'queued', conclusion: null, created_at: clock + 5000 })] }, { ok: true, runs: [run({ id: 9001, created_at: clock + 5000 })] }],
  });
  sessionStorage.setItem('cp3_dispatch_key', 'owner-key-0123456789-abcdefgh');
  await h.api.poll();                                         // health + first observation
  h.api.state.ctl.keySet = true; h.api.state.ctl.confirm = 'prediction-freshness-check'; h.api.state.ctl.confirmAck = true;
  await h.api.launchForTest('prediction-freshness-check');
  assert.equal(sent.id, 'prediction-freshness-check'); assert.equal(sent.key, 'owner-key-0123456789-abcdefgh');
  assert.equal(h.api.state.ctl.lastDispatch.runId, null);     // accepted, not started
  assert.ok(h.api.state.ctl.audit.some(a => a.kind === 'dispatch-accepted'));
  await h.api.poll();                                         // GitHub has not listed it yet
  assert.equal(h.api.state.ctl.lastDispatch.runId, null);
  clock += 10000; await h.api.poll();                         // GitHub lists run 9001
  assert.equal(h.api.state.ctl.lastDispatch.runId, 9001);
  assert.ok(h.api.state.ctl.audit.some(a => a.kind === 'run-confirmed' && a.run_id === 9001));
  clock += 60000; await h.api.poll();                         // run completes -> final Overview refresh
  assert.equal(h.api.state.ctl.lastExecutionRefresh.runId, 9001);
  assert.equal(h.api.state.ctl.lastExecutionRefresh.refreshOk, true);
});

test('launch flow: a rejected key is cleared and reported; nothing is shown as accepted', async () => {
  const h = harness({ dispatchJob: async () => ({ ok: false, code: 'unauthorized', message: 'The owner dispatch key was rejected.' }), runsScript: [{ ok: true, runs: [] }] });
  sessionStorage.setItem('cp3_dispatch_key', 'wrong-key-0123456789-abcdefgh');
  await h.api.poll();
  Object.assign(h.api.state.ctl, { keySet: true, confirm: 'prediction-freshness-check', confirmAck: true });
  await h.api.launchForTest('prediction-freshness-check');
  assert.equal(h.api.state.ctl.keySet, false); assert.equal(sessionStorage.getItem('cp3_dispatch_key'), null);
  assert.match(h.api.state.ctl.lastDispatch.error, /rejected/);
  assert.deepEqual(h.api.state.ctl.pending, {});
});

test('launch is refused while a run is active, without confirmation, or when the dispatcher is disabled', async () => {
  let calls = 0;
  for (const [over, health, runs] of [
    [{ confirmAck: true }, { ok: true, enabled: true }, [run({ status: 'in_progress', conclusion: null })]],
    [{ confirmAck: false }, { ok: true, enabled: true }, []],
    [{ confirmAck: true }, { ok: true, enabled: false }, []]]) {
    const h = harness({ dispatchJob: async () => { calls++; return { ok: true }; }, health, runsScript: [{ ok: true, runs }] });
    sessionStorage.setItem('cp3_dispatch_key', 'owner-key-0123456789-abcdefgh');
    await h.api.poll();
    Object.assign(h.api.state.ctl, { keySet: true, confirm: 'prediction-freshness-check' }, over);
    await h.api.launchForTest('prediction-freshness-check');
  }
  assert.equal(calls, 0);
});
