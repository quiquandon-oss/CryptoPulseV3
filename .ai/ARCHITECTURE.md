# CryptoPulseV2 — Continuous Learning Architecture

## Objective

Transform CryptoPulseV2 from a prediction application into an experiment-driven,
continuously evaluated learning system.

The system must:

1. Make predictions.
2. Permanently record the exact information available when each prediction was made.
3. Resolve predictions against future market outcomes.
4. Measure model performance.
5. Analyze why predictions succeeded or failed.
6. Analyze market catalysts surrounding significant moves.
7. Detect recurring failure patterns.
8. Generate scientifically testable improvement proposals.
9. Allow Claude to implement approved experiments.
10. Never automatically modify production based on a single observation.

---

# AI Responsibilities

## Claude AI

Claude is the Model Engineer.

Claude is responsible for:

- implementing model changes
- implementing experiments
- writing tests
- running backtests
- running out-of-sample validation
- reviewing code
- creating GitHub branches
- creating pull requests
- documenting implementation results

Claude must NOT automatically promote experimental changes to production.

---

## ChatGPT

ChatGPT is the Independent Auditor and Market Intelligence Analyst.

ChatGPT is responsible for:

- statistical auditing
- model performance analysis
- detecting possible leakage
- detecting overfitting
- analyzing model errors
- analyzing confidence errors
- analyzing regime-specific performance
- analyzing market catalysts
- determining whether catalysts were known before predictions
- identifying recurring patterns
- proposing experiments
- reviewing Claude's implementation/results

ChatGPT must not directly modify production code.

---

## Human Owner

The repository owner has final authority over:

- production model promotion
- major architecture changes
- changes to prediction methodology
- external data providers
- risk policies

---

# Three-Agent Intelligence Architecture

CryptoPulseV2 uses three specialized AI roles.

## Gemini — Market Intelligence Agent

Purpose:

Discover and structure external market information.

Primary question:

> What happened?

Inputs:

- market event
- asset
- event window
- relevant prediction timestamps

Outputs:

- candidate catalysts
- sources
- timestamps
- market classification
- confidence
- evidence

Gemini does not modify model behavior.

---

## ChatGPT — Independent Auditor

Purpose:

Evaluate CryptoPulse performance and interpret market evidence.

Primary question:

> What does what happened mean for the model?

Inputs:

- predictions
- outcomes
- model metrics
- Gemini catalyst evidence
- historical performance

Outputs:

- audit findings
- causal interpretation
- recurring failure patterns
- experiment hypotheses

ChatGPT does not directly modify Production.

---

## Claude — Model Engineer

Purpose:

Implement and validate experiments.

Primary question:

> What can we build and test?

Inputs:

- experiment specification
- hypothesis
- acceptance criteria

Outputs:

- code
- tests
- backtests
- out-of-sample validation
- Pull Request

Claude does not automatically promote Production.

---

# Market Intelligence Data Flow

Market event
     |
     v
Trigger engine
     |
     v
Gemini
     |
     v
Structured catalyst evidence
     |
     v
CryptoPulse validation
     |
     +--> timestamp validation
     +--> source validation
     +--> deduplication
     +--> availability calculation
     |
     v
D1 catalyst log
     |
     v
Daily Learning Report
     |
     v
ChatGPT
     |
     v
Experiment hypothesis

---

# System Architecture

The target architecture is:

Market Data
    |
    v
CryptoPulse signal engine
    |
    v
Prediction Engine
    |
    v
Immutable Prediction Ledger
    |
    v
Outcome Resolution
    |
    v
Daily Learning Engine
    |
    +---- Performance Analysis
    |
    +---- Calibration Analysis
    |
    +---- Regime Analysis
    |
    +---- Error Analysis
    |
    +---- Market Catalyst Attribution
    |
    +---- Model Drift Detection
    |
    v
Daily Intelligence Report
    |
    v
ChatGPT Audit
    |
    v
Experiment Specification
    |
    v
Claude Implementation
    |
    v
Tests + Backtest + Out-of-Sample Validation
    |
    v
Pull Request
    |
    v
Human Approval
    |
    v
Production

---

# Production / Challenger / Research

The system must maintain three conceptual levels.

## Production

The currently deployed model.

## Challenger

A candidate model being evaluated against Production.

## Research

Experimental code that must not influence Production.

No Research or Challenger implementation may silently alter Production behavior.

---

# Core Principle

The system must learn from evidence, not from individual mistakes.

A single incorrect prediction is not sufficient reason to change the model.

Changes require:

- sufficient sample size
- reproducible evidence
- out-of-sample validation
- leakage review
- comparison against the current Production model

---

# Required Design Principle

All prediction-time information must be timestamped.

The system must be able to answer:

"What did the model know at the exact moment this prediction was generated?"

This requirement overrides convenience.

---

# Security

AI-facing APIs must be:

- read-only
- authenticated where appropriate
- rate limited
- free of secrets
- free of unrestricted database access

Do not expose raw D1 credentials.

Do not expose administrative endpoints to AI consumers.

---

# AI Boundary Rules

Gemini is an evidence provider.

ChatGPT is an auditor.

Claude is an engineer.

No AI agent may silently assume another agent's output is ground truth.

All AI-generated information must remain identifiable as AI-derived until
validated by deterministic system logic or reliable source evidence.

---

# External Intelligence Is Non-Critical

Failure of Gemini must never prevent:

- prediction generation
- prediction storage
- outcome resolution
- daily metric calculation

Market intelligence is an enrichment layer.

Prediction infrastructure must remain operational if Gemini is:

- unavailable
- rate limited
- malformed
- misconfigured
- returning no useful result

---

# Non-goals

Do NOT initially implement:

- autonomous production promotion
- autonomous feature deletion
- autonomous weight rewriting
- LLM-generated features directly used in prediction
- automatic model retraining from one day's results
- uncontrolled self-modifying behavior

---

# Dashboard Contract

Any dashboard or standalone presentation surface (including the production
CryptoPulseV2 frontend and any scratch/prototype dashboard built alongside it)
consumes data through the Worker/API layer. It does not independently recompute
accuracy, calibration, Brier score, or any other metric the learning engine already
owns.

```
CoinGecko / market sources
          |
          v
     CryptoPulse API
          |
          v
       D1 / Worker
          |
 +--------+---------+
 v                  v
Dashboard       AI Learning
                    |
                ChatGPT
                    |
              Claude tasks
```

The Worker/API is the single source of truth for any number a dashboard displays
about model performance. This prevents the dashboard and the learning API from
silently disagreeing about the same underlying prediction history.

Status: documented, not yet implemented. The current standalone dashboard prototype
predates the `/api/learning/*` endpoints and does not yet consume them — see the
continuous-learning-foundation PR's "Remaining work" for tracking.

---

# Learning Intelligence Stack

```
                    CryptoPulse
                         |
             +-----------+-----------+
             |                       |
             v                       v
        Prediction               Market Event
          Ledger                   Trigger
             |                       |
             |                       v
             |                    Gemini
             |                       |
             |                 Catalyst Evidence
             |                       |
             +-----------+-----------+
                         |
                         v
                    Learning D1
                         |
                         v
                      ChatGPT
                         |
                         v
                 Experiment Proposal
                         |
                         v
                       Claude
                         |
                         v
                  Tests / Backtest
                         |
                         v
                        PR
                         |
                         v
                 Human Approval
```
