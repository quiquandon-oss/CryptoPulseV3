# CryptoPulseV2 — Experiment Protocol

## Objective

Ensure that model improvements are evidence-based and reproducible.

---

# Experiment Lifecycle

PROPOSED
    ↓
IMPLEMENTED
    ↓
BACKTESTING
    ↓
OUT_OF_SAMPLE
    ↓
REVIEW
    ↓
PASSED / FAILED
    ↓
PROMOTED / REJECTED

---

# Experiment ID

Use:

EXP-001
EXP-002
EXP-003

IDs are permanent.

Never reuse an ID.

---

# Required Experiment Specification

Every experiment must define:

## Hypothesis

What do we believe?

## Observation

What evidence produced the hypothesis?

## Mechanism

Why should the proposed change improve the model?

## Baseline

What Production version is being compared?

## Change

Exactly what is being modified?

## Metrics

Which metrics determine success?

## Validation

How will out-of-sample performance be measured?

## Failure Criteria

When will the experiment be rejected?

---

# Required Metrics

At minimum:

- sample size
- accuracy
- Brier score
- log loss
- calibration error

Depending on the experiment:

- precision
- recall
- directional accuracy
- return capture
- maximum adverse excursion
- maximum favorable excursion

---

# Statistical Requirements

Do not declare success based only on accuracy.

Consider:

- sample size
- confidence intervals
- stability across time
- stability across regimes
- multiple testing
- selection bias

---

# Data Splitting

Experiments must preserve temporal order.

Do not randomly shuffle time-series observations for validation.

Use:

TRAIN
    →
VALIDATION
    →
OUT-OF-SAMPLE

The future must never influence the past.

---

# Leakage Review

Every experiment must answer:

1. Can future prices enter features?
2. Can future outcomes enter calibration?
3. Can future predictions influence neighbor selection?
4. Can future data influence feature weights?
5. Can the experiment indirectly use post-prediction news?

---

# Challenger Rule

A Challenger must run alongside Production long enough to produce meaningful evidence.

Do not promote immediately after a successful backtest.

---

# Promotion Criteria

Promotion requires:

- passing tests
- no leakage
- sufficient sample size
- positive out-of-sample result
- acceptable calibration
- no major regression
- documented result
- human approval

---

# Rejection

A failed experiment is valuable.

Document:

- what was tried
- why it failed
- evidence
- lesson

Do not delete failed experiments.

---

# Research Principle

A model improvement must generalize.

If a change improves only one historical period or one narrow market regime, treat it as research rather than production-ready.
