// Pure validation helpers — no DOM, no fetch, no fabricated defaults.
// Usable from the browser (import as an ES module) and directly from
// Node's built-in test runner.

export const SUPPORTED_COINS = ['BTC', 'LINK', 'ETH'];
export const SUPPORTED_HORIZONS = [12, 24];

// PulseWorkerV2's prediction/selection cron runs every 3 hours
// (wrangler.toml: "0 */3 * * *"). Freshness thresholds are defined relative
// to that real cadence, not an arbitrary guess:
//   - within one cycle -> LIVE
//   - within ~1.5 cycles (allows for a delayed/slow cron run) -> RECENT
//   - beyond that -> STALE
// A missing timestamp is never "LIVE" by default; it's UNAVAILABLE.
export const CRON_INTERVAL_MS = 3 * 60 * 60 * 1000;
export const LIVE_THRESHOLD_MS = CRON_INTERVAL_MS;
export const RECENT_THRESHOLD_MS = CRON_INTERVAL_MS * 1.5;

export function isSupportedCoin(coin) {
  return SUPPORTED_COINS.includes(coin);
}

export function isSupportedHorizon(horizon) {
  return SUPPORTED_HORIZONS.includes(Number(horizon));
}

// Rejects anything that isn't a finite probability in [0, 1] -- callers
// must treat a failed check as "no valid p_up", never coerce/clamp it into
// range (clamping a corrupt 1.7 into 1.0 would silently manufacture a
// 100%-confidence reading that was never actually produced).
export function isValidProbability(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function isValidTimestamp(ts) {
  return typeof ts === 'number' && Number.isFinite(ts) && ts > 0;
}

// nowMs is an explicit parameter (not Date.now() read internally) so this
// stays pure and trivially testable.
export function getFreshnessState(latestTs, nowMs) {
  if (!isValidTimestamp(latestTs)) return 'UNAVAILABLE';
  const age = nowMs - latestTs;
  if (age < 0) return 'UNAVAILABLE'; // clock skew / corrupt future timestamp -- don't claim LIVE
  if (age <= LIVE_THRESHOLD_MS) return 'LIVE';
  if (age <= RECENT_THRESHOLD_MS) return 'RECENT';
  return 'STALE';
}

export function formatAge(latestTs, nowMs) {
  if (!isValidTimestamp(latestTs)) return 'unavailable';
  const ageMs = Math.max(0, nowMs - latestTs);
  const mins = Math.round(ageMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
