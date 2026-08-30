# CryptoPulse V2

A standalone BTC prediction-model tool — separate app from
[CryptoPulse](https://github.com/quiquandon-oss/CryptoPulse), built to avoid risking
the working V1 app, but sharing its market history rather than starting from zero.

## Why a separate app, shared data

- **Frontend**: this repo, deployed via GitHub Pages, fully standalone.
- **Backend**: [PulseWorkerV2](https://github.com/quiquandon-oss/PulseWorkerV2), a
  dedicated Cloudflare Worker, isolated from the original `sentiment-ff75` Worker.
- **Data**: PulseWorkerV2 binds to the *same* D1 database (`sentiment-history`) that
  the original PulseWorker writes to. Cloudflare D1 databases are account-level
  resources, not repo-scoped, so this works without touching V1's code at all — V2
  gets weeks of real sentiment/technical/regime history to build a model on from day
  one, and its own new tables (predictions log, calibration results) live alongside
  the original tables in the same database.
- The original PulseWorker's CORS is wide open (`Access-Control-Allow-Origin: *`), so
  this frontend can also call its existing routes directly (`/history` for price
  series, `/gemini-outlook` for narration) instead of duplicating that plumbing.

## Design principle

Same as V1: **compute deterministically, use an LLM only to narrate.** Gemini (free
tier) explains catalysts and regime context; it never generates the prediction number
itself. The model is a real (if small) statistical model — historical analog matching
to start, logistic regression once there's enough history — not an LLM guessing a
price.

## Plan (see PulseWorkerV2's README for the backend side)

1. ~~Scaffold: this page + PulseWorkerV2 wired to the shared D1~~ — done
2. k-NN historical analog model for BTC: P(24h return > 0)
3. Calibration loop — log every prediction, log the realized outcome, track accuracy
4. Second model (logistic regression) once there's enough history
5. More horizons, more coins, wire in whale/liquidation signals not yet used anywhere

## Free-tier constraint

Only Gemini and Cloudflare Workers AI have a genuinely sustainable free API tier.
Claude/Grok/ChatGPT don't (checked directly, not assumed) — they're used as a manual
periodic audit panel (paste a generated model report in, log the critique back),
not automated API participants.
