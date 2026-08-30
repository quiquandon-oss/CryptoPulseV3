# CryptoPulseV2 — Continuous Learning Implementation Plan

## Objective

Implement the foundation required for daily ChatGPT auditing and
Claude-driven model experimentation.

Do not implement speculative model improvements during this phase.

---

# PHASE 1 — Audit Existing Architecture

Before coding:

1. Inspect PulseWorkerV2.
2. Inspect CryptoPulseV2.
3. Inspect existing D1 migrations/schema.
4. Inspect prediction generation.
5. Inspect calibration.
6. Inspect challenger model.
7. Inspect selection layer.
8. Inspect existing tests.
9. Inspect cron jobs.

Produce:

/learning/ARCHITECTURE_AUDIT.md

Document:

- existing tables
- existing prediction flow
- existing outcome resolution
- existing calibration
- existing challenger flow
- missing components
- potential leakage risks

Do not modify production behavior yet.

---

# PHASE 2 — Prediction Ledger

Implement immutable prediction snapshots.

Reuse existing tables where safe.

If schema changes are required, create a migration.

Every prediction must capture:

- timestamp
- asset
- horizon
- model
- version
- Git commit
- probabilities
- confidence
- features
- neighbor information
- data freshness

---

# PHASE 3 — Outcome Resolution

Implement deterministic resolution.

For every resolved prediction:

- reference price
- future price
- realized return
- realized direction
- resolution timestamp

Resolution must be reproducible.

---

# PHASE 4 — Learning Metrics

Implement calculations for:

- accuracy
- Brier score
- log loss
- calibration error
- confidence buckets
- model comparison
- regime comparison
- feature analysis
- confident mistakes

All calculations must have automated tests.

---

# PHASE 5 — Daily Learning Report

Implement:

GET /api/learning/daily

and:

GET /api/learning/chatgpt

Both must be read-only.

The ChatGPT endpoint should return compact JSON.

---

# PHASE 6 — Market Catalyst Infrastructure

Implement the database/schema and data contract for market catalysts.

Do not yet make catalysts prediction features.

The system must preserve:

- event timestamp
- publication/discovery timestamp
- source
- URL
- category
- direction
- confidence
- available_before_prediction

---

# PHASE 7 — Experiment Registry

Implement experiment metadata.

Create:

/learning/experiments/
/learning/claude_tasks/
/learning/results/

Add templates.

---

# PHASE 8 — Leakage Audit

Before declaring Phase 1 complete, test:

- look-ahead bias
- feature leakage
- calibration leakage
- neighbor leakage
- selection leakage
- timestamp errors

Document findings.

---

# PHASE 9 — Tests

All existing tests must continue to pass.

Add tests for:

- immutable prediction snapshots
- outcome resolution
- daily metrics
- catalyst timestamps
- leakage protection
- API output
- experiment lifecycle

---

# PHASE 10 — Documentation

Create:

.ai/ARCHITECTURE.md
.ai/AI_COLLABORATION.md
.ai/DATA_CONTRACT.md
.ai/DAILY_AUDIT.md
.ai/MARKET_CATALYST.md
.ai/EXPERIMENT_PROTOCOL.md

Document all implementation decisions.

---

# PHASE 11 — Pull Request

Create a dedicated branch:

feature/continuous-learning-foundation

Create a Pull Request.

The PR description must contain:

## What changed

## Database changes

## API changes

## Tests

## Leakage findings

## Security considerations

## Remaining work

## How ChatGPT will consume the data

---

# Critical Restrictions

DO NOT:

- change Production model weights
- change feature weights
- promote Challenger
- introduce new prediction features
- use LLM output as prediction input
- automatically deploy model changes
- remove existing prediction data

This phase is infrastructure + measurement only.

---

# Definition of Done

Phase 1 is complete only when:

[ ] Every prediction is immutably recorded.

[ ] Every prediction can be resolved.

[ ] Performance metrics can be calculated reproducibly.

[ ] Daily report exists.

[ ] ChatGPT-compatible report exists.

[ ] Catalyst schema exists.

[ ] Experiment registry exists.

[ ] Leakage audit exists.

[ ] Automated tests pass.

[ ] Existing functionality remains intact.

[ ] Pull Request created.

[ ] No Production model behavior was changed.
