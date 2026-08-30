# CryptoPulseV2 — Claude / ChatGPT Collaboration Protocol

## Purpose

Define how Claude and ChatGPT collaborate during continuous development.

---

# Claude's Role

Claude is responsible for implementation.

Claude receives experiment specifications from ChatGPT and:

1. Understands the hypothesis.
2. Inspects the existing implementation.
3. Implements the smallest appropriate change.
4. Adds tests.
5. Runs regression tests.
6. Runs backtests.
7. Runs out-of-sample validation.
8. Reports quantitative results.
9. Creates a GitHub branch.
10. Creates a Pull Request.
11. Documents the result.

Claude must not assume that an experiment should improve Production.

Experiments are allowed to fail.

---

# ChatGPT's Role

ChatGPT independently reviews:

- historical predictions
- realized outcomes
- model performance
- calibration
- model variants
- market context
- market catalysts
- model failures
- statistical validity

ChatGPT creates experiment proposals only when evidence justifies them.

---

# Gemini — Market Intelligence Agent

Gemini is the dedicated external Market Intelligence agent.

Gemini answers:

> What happened in the market?

Gemini is responsible for:

- current market-event investigation
- catalyst discovery
- source collection
- event timestamp identification
- publication timestamp identification
- market-wide vs asset-specific analysis
- macro and crypto-specific context

Gemini is NOT responsible for:

- model engineering
- prediction generation
- model selection
- calibration
- experiment approval
- production deployment

---

# Three-AI Collaboration Model

## Gemini

DISCOVER

Find credible evidence about what happened.

↓

## ChatGPT

AUDIT

Determine what the evidence means for CryptoPulse and whether the model
failure/success is significant.

↓

## Claude

BUILD

Implement an experiment based on an approved hypothesis.

↓

## Human

APPROVE

Decide whether a validated Challenger should become Production.

---

# Information Flow

CryptoPulse
    |
    +--> Prediction/outcome data
    |
    +--> Market event trigger
              |
              v
          Gemini
              |
              v
       Catalyst evidence
              |
              v
      CryptoPulse validation
              |
              v
             D1
              |
              v
          ChatGPT audit
              |
              v
       Experiment proposal
              |
              v
            Claude
              |
              v
       Implementation + tests
              |
              v
             PR
              |
              v
       Independent review
              |
              v
        Human approval

---

# Independence Rule

Gemini and ChatGPT must remain analytically independent.

ChatGPT must not blindly accept Gemini's catalyst attribution.

Gemini provides evidence.

ChatGPT evaluates the evidence.

---

# Timestamp Rule

Gemini may report:

- event_timestamp
- first_public_timestamp
- publication_timestamp
- discovery_timestamp

CryptoPulse computes:

available_before_prediction

using deterministic timestamp comparison.

The LLM must never decide whether an event was available to the model.

---

# Production Safety

Gemini must never:

- modify Production model behavior
- change model weights
- change feature weights
- change calibration
- promote Challenger
- trigger deployment
- write directly to D1

Gemini output is advisory evidence until validated by CryptoPulse.

---

# Experiment Flow (Gemini-Originated Findings)

A Gemini finding does NOT automatically create an experiment.

Required flow:

Gemini finding
    ↓
ChatGPT audit
    ↓
Evidence sufficient?
    |
    +-- NO --> record finding only
    |
    +-- YES
          ↓
       hypothesis
          ↓
       experiment
          ↓
        Claude
          ↓
     backtest/OOS
          ↓
     independent review
          ↓
     human approval

---

# Required Experiment Flow

ChatGPT:

OBSERVATION
    |
    v
HYPOTHESIS
    |
    v
EXPERIMENT SPECIFICATION
    |
    v
Claude implementation
    |
    v
Tests
    |
    v
Backtest
    |
    v
Out-of-sample validation
    |
    v
Claude result
    |
    v
ChatGPT independent review
    |
    +---- FAIL --> document rejection
    |
    +---- PASS --> human review
                       |
                       v
                   promotion

---

# Experiment Communication

Every experiment must have a unique ID.

Example:

EXP-001
EXP-002
EXP-003

Experiment specifications must be stored in:

/learning/experiments/

Implementation tasks for Claude must be stored in:

/learning/claude_tasks/

Results must be stored in:

/learning/results/

---

# ChatGPT Output Contract

ChatGPT experiment proposals should contain:

## Observation

What happened?

## Evidence

What data supports the observation?

## Hypothesis

What might explain it?

## Proposed Experiment

What should Claude change?

## Control

What is the current Production baseline?

## Metrics

What should be measured?

## Acceptance Criteria

What constitutes success?

## Failure Criteria

What constitutes rejection?

## Leakage Requirements

What must be verified?

---

# Claude Result Contract

Claude must report:

- experiment ID
- commit SHA
- files changed
- tests added
- tests passed
- backtest period
- validation period
- sample sizes
- Production metrics
- Challenger metrics
- out-of-sample metrics
- known limitations
- leakage assessment
- final recommendation

Claude must never report an experiment as successful solely because accuracy improved.

---

# Promotion Rule

A model change may only be considered for Production after:

1. Tests pass.
2. No known data leakage exists.
3. Sample size is sufficient.
4. Out-of-sample performance is evaluated.
5. Relevant metrics improve or remain acceptable.
6. No severe regression exists.
7. The experiment is reviewed.
8. Human owner approves promotion.
