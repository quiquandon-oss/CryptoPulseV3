import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registryTitle, formatProgress, formatEtaText, statusLabel, classifyDataFreshness,
  summarizeRegistry, normalizePredictionFreshness, HOUR_MS, DAY_MS,
} from '../api/research.js';

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);

test('registryTitle: prefers backend display_label, so EXP-005 and Experiment 5 (EXP-011) cannot collide', () => {
  assert.equal(registryTitle({ experiment_id: 'EXP-011', title: 'x', display_label: 'EXP-011 · Experiment 5 — Agentic Market Evidence' }),
    'EXP-011 · Experiment 5 — Agentic Market Evidence');
  assert.equal(registryTitle({ experiment_id: 'EXP-002', title: 'Anomaly gate' }), 'EXP-002 · Anomaly gate');
  assert.equal(registryTitle({ experiment_id: 'EXP-002', title: 'Anomaly gate', display_label: '  ' }), 'EXP-002 · Anomaly gate');
});

test('formatProgress: only when both progress and required are numbers', () => {
  assert.equal(formatProgress(12, 60), '12 / 60');
  assert.equal(formatProgress(0, 30), '0 / 30');
  assert.equal(formatProgress(null, 30), null);
  assert.equal(formatProgress(12, null), null);
  assert.equal(formatProgress('12', 60), null);
});

test('formatEtaText: reached / projected / not estimable', () => {
  assert.equal(formatEtaText({ estimable: true, reached: true, progress: 30, required: 30 }), 'Sample requirement met');
  assert.equal(
    formatEtaText({ estimable: true, reached: false, progress: 10, required: 60, rate_per_day: 2.5, eta_date: '2026-10-31', basis: 'x' }),
    'ETA ≈ 2026-10-31 (2.5/day, linear projection)');
  assert.equal(
    formatEtaText({ estimable: true, reached: false, rate_per_day: 1 / 3, eta_date: '2026-12-01' }),
    'ETA ≈ 2026-12-01 (0.33/day, linear projection)');
  assert.equal(formatEtaText({ estimable: false, reason: 'no required_sample' }), 'ETA not yet estimable — no required_sample');
  assert.match(formatEtaText(null), /^ETA not yet estimable/);
  // estimable but no eta_date -> never invents a date
  assert.match(formatEtaText({ estimable: true, reached: false, rate_per_day: 1 }), /^ETA not yet estimable/);
});

test('statusLabel: underscores to spaces, unknown statuses pass through generically', () => {
  assert.equal(statusLabel('READY_FOR_ANALYSIS'), 'READY FOR ANALYSIS');
  assert.equal(statusLabel('SOME_NEW_STATUS'), 'SOME NEW STATUS');
  assert.equal(statusLabel(null), '—');
});

test('classifyDataFreshness: 36h default bar, 8-day bar for weekly experiments, none when null', () => {
  assert.equal(classifyDataFreshness('EXP-002', NOW - 35 * HOUR_MS, NOW).state, 'fresh');
  assert.equal(classifyDataFreshness('EXP-002', NOW - 37 * HOUR_MS, NOW).state, 'stale');
  for (const id of ['EXP-005', 'EXP-009', 'EXP-010']) {
    assert.equal(classifyDataFreshness(id, NOW - 7 * DAY_MS, NOW).state, 'fresh', id);
    assert.equal(classifyDataFreshness(id, NOW - 9 * DAY_MS, NOW).state, 'stale', id);
  }
  const none = classifyDataFreshness('EXP-006', null, NOW);
  assert.equal(none.state, 'none');
  assert.equal(none.age_ms, null);
});

test('summarizeRegistry: counts by status group, ready/live_error lists, latest data update', () => {
  const sum = summarizeRegistry([
    { experiment_id: 'EXP-001', status: 'ON_DEMAND_AUDIT', conclusion: null, data_last_updated: null },
    { experiment_id: 'EXP-002', status: 'ACCUMULATING', suggested_status: 'READY_FOR_ANALYSIS', conclusion: null, data_last_updated: NOW - HOUR_MS },
    { experiment_id: 'EXP-006', status: 'PROPOSED', conclusion: null, data_last_updated: null },
    { experiment_id: 'EXP-011', status: 'BUILT_NOT_ACTIVATED', conclusion: null, data_last_updated: null },
    { experiment_id: 'EXP-012', status: 'STAGING_ONLY', conclusion: null, data_last_updated: null },
    { experiment_id: 'EXP-023', status: 'ACCUMULATING', live_error: 'D1 timeout', conclusion: null, data_last_updated: NOW - 40 * HOUR_MS },
    { experiment_id: 'EXP-024', status: 'COLLECTING', conclusion: 'done', data_last_updated: NOW - 2 * HOUR_MS },
    { experiment_id: 'EXP-099', status: 'WEIRD_NEW' },
  ], NOW);
  assert.equal(sum.total, 8);
  assert.deepEqual(sum.groups, { running: 3, proposed: 1, staging: 2, on_demand: 1, other: 1 });
  assert.equal(sum.byStatus.ACCUMULATING, 2);
  assert.equal(sum.byStatus.WEIRD_NEW, 1);
  assert.deepEqual(sum.ready, ['EXP-002']);
  assert.deepEqual(sum.liveErrors, [{ experiment_id: 'EXP-023', error: 'D1 timeout' }]);
  assert.deepEqual(sum.stale, ['EXP-023']);
  assert.equal(sum.latest_data_update, NOW - HOUR_MS);
  assert.equal(sum.latest_data_experiment, 'EXP-002');
  assert.equal(sum.awaitingEvidence.length, 7);
});

test('summarizeRegistry: empty/invalid input -> zero counts, no latest update', () => {
  const sum = summarizeRegistry(undefined, NOW);
  assert.equal(sum.total, 0);
  assert.equal(sum.latest_data_update, null);
  assert.deepEqual(sum.ready, []);
});

function freshnessCell(overrides = {}) {
  return { latest_ts: NOW - HOUR_MS, latest_age_hours: 1, rows_24h: 9, cron_rows_24h: 8, latest_cron_ts: NOW - HOUR_MS,
    latest_git_commit_sha: 'c75e2ee0123456789', status: 'FRESH', ...overrides };
}

test('normalizePredictionFreshness: flattens coin x horizon x track in fixed order, commit to 7 chars', () => {
  const coin = () => ({ price_data: {}, horizons: { 12: { core: freshnessCell(), challenger: freshnessCell() }, 24: { core: freshnessCell(), challenger: freshnessCell({ status: 'STALE', latest_git_commit_sha: null }) } } });
  const out = normalizePredictionFreshness({ ok: true, generated_ts: NOW, expected_cron_ticks_24h: 8, coins: { LINK: coin(), BTC: coin(), ETH: coin() } });
  assert.equal(out.ok, true);
  assert.equal(out.generated_ts, NOW);
  assert.equal(out.expected_cron_ticks_24h, 8);
  assert.equal(out.rows.length, 12);
  assert.deepEqual(out.rows.slice(0, 4).map((r) => `${r.coin}/${r.horizon}/${r.track}`),
    ['BTC/12/core', 'BTC/12/challenger', 'BTC/24/core', 'BTC/24/challenger']);
  assert.equal(out.rows[4].coin, 'ETH');
  assert.equal(out.rows[0].commit, 'c75e2ee');
  assert.equal(out.rows[3].status, 'STALE');
  assert.equal(out.rows[3].commit, null);
  assert.deepEqual(out.counts, { FRESH: 9, STALE: 3 });
});

test('normalizePredictionFreshness: a missing cell is kept as MISSING with nulls, not dropped or invented', () => {
  const out = normalizePredictionFreshness({ ok: true, coins: { BTC: { horizons: { 12: { core: freshnessCell({ status: 'NONE', latest_ts: null, rows_24h: 0 }) } } } } });
  assert.equal(out.rows.length, 4);
  assert.equal(out.rows[0].status, 'NONE');
  assert.equal(out.rows[0].latest_ts, null);
  assert.equal(out.rows[0].rows_24h, 0);
  assert.equal(out.rows[1].status, 'MISSING');
  assert.equal(out.rows[1].rows_24h, null);
  assert.equal(out.generated_ts, null);
});

test('normalizePredictionFreshness: malformed / ok:false -> explicit failure', () => {
  assert.equal(normalizePredictionFreshness(null).ok, false);
  assert.equal(normalizePredictionFreshness({ ok: true }).ok, false);
  const failed = normalizePredictionFreshness({ ok: false, error: 'boom' });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'boom');
});
