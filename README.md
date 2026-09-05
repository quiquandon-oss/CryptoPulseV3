# CryptoPulse V3

A multi-coin, mobile-first frontend for [PulseWorkerV2](https://github.com/quiquandon-oss/PulseWorkerV2)'s
prediction and selection engine.

**V3 is a visualization, monitoring, explanation and research-observability
layer. PulseWorkerV2 is the source of truth. V3 never invents, guesses, or
silently repairs a prediction value — a missing or invalid backend value is
displayed as unavailable, never as a plausible-looking default.**

See [`V3_ALIGNMENT_AUDIT.md`](./V3_ALIGNMENT_AUDIT.md) for the full audit this
principle was enforced against, including the specific fabrication bugs it
found and fixed.

## Relationship to V2 and PulseWorkerV2

- [`CryptoPulseV2`](https://github.com/quiquandon-oss/CryptoPulseV2) is the
  original single-coin (BTC) frontend for the same backend. V3 extends it to
  BTC/LINK/ETH with a mobile-first redesign, while preserving V2's core model
  semantics (k-NN historical-analog matching, raw-vs-calibrated probability,
  production/research separation) rather than reinventing them.
- [`PulseWorkerV2`](https://github.com/quiquandon-oss/PulseWorkerV2) is the
  backend both frontends call — a Cloudflare Worker that runs the k-NN model,
  the production selection layer (Bonferroni-gated LCA scoring across
  variants), calibration, and the research experiments described below. It
  owns all model logic and all D1 state. V3 contains none of it.
- `quiquandon-oss/CryptoPulse` (no version number) is a **different,
  unrelated app** — a portfolio/DCA tracker against a different Worker. Don't
  confuse it with V2/V3.

## Supported coins and horizons

- **Coins:** BTC, LINK, ETH. Adding a coin means adding one entry to
  `api/pulseworker.js`'s endpoint map and one summary/chart card in
  `index.html` — coin is an explicit dimension throughout (see
  `api/validation.js`'s `SUPPORTED_COINS`), never inferred or mixed across
  requests.
- **Horizons:** 12h and 24h — exactly what PulseWorkerV2 supports
  (`api/validation.js`'s `SUPPORTED_HORIZONS`). V3 does not display a horizon
  the backend doesn't actually serve.

## Production vs. research — mandatory separation

- **Production**: the Dashboard tab shows PulseWorkerV2's actual
  `chosen_variant` (read via `/selection-history`) and, where a selection
  record carries its own `chosen_p_up`, that value takes priority over the
  raw k-NN's own `p_up` for the headline call — because `chosen_p_up` is what
  production actually acted on.
- **Research**: the Lab tab's experiments (EXP-002 Anomaly Gate, EXP-003
  Momentum Overlay) are read-only, pull from separate research endpoints
  (`/research/anomaly-gate`, `/challenger-recent`), and are explicitly
  labeled **"Production impact: NO"**. Neither can ever replace
  `chosen_variant` — PulseWorkerV2 itself keeps `challenger_momentum` out of
  `SELECTION_VARIANTS` so this is enforced backend-side too, not just by
  frontend labeling.

## Data integrity and freshness

The dashboard's **Data Integrity panel** (top of the Dashboard tab) reports,
derived from real fetched data, never a static claim:

- Backend reachability (`ONLINE`/`OFFLINE`)
- Latest prediction timestamp and freshness (`LIVE`/`RECENT`/`STALE`/`UNAVAILABLE`)
- Latest production selection timestamp and freshness
- Research endpoint reachability (only updates once the Lab tab has actually
  been opened this session — this panel adds no API calls of its own)

Freshness thresholds are derived from PulseWorkerV2's real cron cadence (every
3 hours — see `api/validation.js`): within one cycle is `LIVE`, within ~1.5
cycles is `RECENT`, beyond that is `STALE`. A missing or future timestamp is
`UNAVAILABLE`, never `LIVE` by default.

A stale or unreachable backend renders an explicit `DATA UNAVAILABLE` /
`PREDICTION NOT AVAILABLE` state on the affected card — it is never
overwritten by a synthetic fallback.

## The backend contract layer

```
api/
  normalize.js    # strict field normalization -- absorbs legitimate backend
                  # field-name differences (chosen_variant vs selected_variant
                  # vs model_name), never invents a value. Every function
                  # returns { available: true, ...fields } or
                  # { available: false, reason }.
  validation.js   # pure helpers: supported coins/horizons, probability
                  # validation, freshness state.
  pulseworker.js  # the only place that knows PulseWorkerV2's endpoint
                  # shapes. Timeout-bounded fetches; returns { ok, ... } or
                  # { ok: false, error }, never throws to the UI layer.
```

These are plain, dependency-free ES modules — usable directly by the browser
(`<script type="module">`, bridged onto `window.PulseAPI` for `index.html`'s
classic inline-handler script; imported directly by `widget.html`) and
directly by Node's built-in test runner. No bundler, no framework.

```bash
npm test   # or: node --test
```

## Learning/calibration concept

The "AI Learning" tab **observes** PulseWorkerV2's own learning loop
(predictions → realized outcomes → model performance → selection decisions →
research experiments → future eligibility) — it does not run or train
anything itself. Its status indicators are derived from data this session
actually fetched (reachable / has resolved outcomes / has selection history),
never a hardcoded "Healthy".

## Deployment

Static site, no build step, deployed to GitHub Pages via
`.github/workflows/deploy.yml` on push to this repo's default branch.
`widget.html` (single-coin, `?coin=BTC|LINK|ETH`) and `widgets.html` (a link
hub to all three) exist for pointing a third-party "URL as home-screen
widget" Android app at.

## Testing

`tests/*.test.js` cover the dangerous cases directly: missing prediction,
missing `p_up` with a real `direction` field, invalid `p_up` (e.g. `1.7`),
stale timestamps, empty/malformed backend responses, and coin/horizon
isolation (a request for one coin/horizon never leaks another's data). See
`V3_ALIGNMENT_AUDIT.md` §4 for the specific violations these tests exist to
prevent regressions of.
