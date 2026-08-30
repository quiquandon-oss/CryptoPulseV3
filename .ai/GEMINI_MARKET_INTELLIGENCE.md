# CryptoPulseV2 — Gemini Market Intelligence Agent

## Purpose

Introduce Gemini as the dedicated Market Intelligence and Catalyst Attribution
agent for CryptoPulseV2.

Gemini's responsibility is to investigate significant crypto market movements
using current external information and produce structured, timestamped evidence.

Gemini is NOT a prediction model.

Gemini must NOT modify:

- Production predictions
- model weights
- feature weights
- calibration
- challenger selection
- DCS / selectBestVariant
- experiment status
- Production database state directly

Gemini provides market evidence to the CryptoPulse learning system.

---

# AI Architecture

The three AI roles are intentionally separated.

## Gemini — Market Intelligence

Gemini answers:

> What happened in the market?

Gemini investigates:

- price movements
- market-wide movements
- asset-specific movements
- macro events
- Federal Reserve / rates
- inflation
- employment
- USD
- ETF flows
- regulation
- exchange events
- stablecoin events
- liquidations
- leverage
- technical events
- on-chain events
- geopolitical events
- security/protocol events

Gemini must provide source evidence and timestamps.

---

## ChatGPT — Independent Auditor

ChatGPT answers:

> What does what happened mean for CryptoPulse?

ChatGPT receives:

- CryptoPulse prediction data
- realized outcomes
- model metrics
- Gemini catalyst findings
- source URLs
- event timestamps
- publication timestamps

ChatGPT determines:

- whether the model actually failed
- whether the event was knowable
- whether the model had an observable warning
- whether similar failures exist historically
- whether an experiment is justified

ChatGPT must remain independent from Gemini.

Gemini's conclusion must never automatically become ChatGPT's conclusion.

---

## Claude — Model Engineer

Claude answers:

> What should we build to test the hypothesis?

Claude implements approved experiments.

Claude:

- writes code
- writes tests
- performs backtests
- performs out-of-sample validation
- documents results
- creates pull requests

Claude must not automatically promote experiments.

---

# Operating Principle

The pipeline is:

MARKET EVENT
    |
    v
Gemini investigation
    |
    v
Structured evidence
    |
    v
CryptoPulse validation
    |
    v
D1 catalyst record
    |
    v
ChatGPT independent audit
    |
    v
Experiment hypothesis
    |
    v
Claude implementation
    |
    v
Backtest / validation
    |
    v
Human approval

---

# Triggering Strategy

Do NOT call Gemini continuously.

Gemini investigations should be triggered only when an event is significant
enough to justify analysis.

Initial trigger candidates:

1. Significant price movement.
2. Significant volatility increase.
3. High-confidence prediction failure.
4. Multiple correlated asset failures.
5. Market-wide regime change.
6. Unusual divergence between assets.
7. Large realized prediction error.

The exact thresholds must be configurable.

Example initial configuration:

MARKET_MOVE_TRIGGER_PCT = 3
HIGH_CONFIDENCE_TRIGGER = 0.75
MULTI_ASSET_TRIGGER_COUNT = 3

These are initial defaults only and must not be treated as scientifically
validated thresholds.

---

# Investigation Window

For every triggered event, define:

event_start
event_end
prediction_timestampes
affected_assets

Gemini should investigate information relevant to the event window.

The system must explicitly distinguish:

- event timestamp
- first known/public timestamp
- publication timestamp
- Gemini discovery timestamp

---

# Critical Timestamp Rule

Gemini MUST NOT determine:

available_before_prediction

CryptoPulse determines this.

For each catalyst:

prediction_timestamp = T0
first_public_timestamp = T1

Then:

if T1 <= T0:
    available_before_prediction = true

else:
    available_before_prediction = false

If T1 cannot be established reliably:

available_before_prediction = unknown

Never guess.

---

# Hindsight Protection

A source discovered by Gemini after the prediction may still describe an event
that happened earlier.

Therefore:

discovery_timestamp != event_timestamp

and:

discovery_timestamp != first_public_timestamp

The system must preserve all three concepts where available.

The fact that Gemini discovered information later does NOT mean that the
information was unavailable earlier.

Conversely, an event that happened earlier must not automatically be assumed
to have been public earlier.

---

# Gemini Search Requirements

Gemini should use web/search grounding when investigating current events.

Search should prioritize:

1. Primary sources
2. Official announcements
3. Regulatory sources
4. Government sources
5. Official company/project announcements
6. High-quality financial/news sources

Secondary sources may be used to corroborate an event.

Do not rely on a single low-quality source when the catalyst is material.

---

# Source Requirements

Every catalyst should contain:

- source title
- source URL
- publisher
- publication timestamp if available
- event timestamp if available
- source reliability assessment

Gemini must not invent URLs or timestamps.

If a timestamp cannot be verified:

set the corresponding field to null/unknown.

---

# Structured Gemini Output

Gemini must return machine-readable JSON.

Conceptual schema:

```
{
  "investigation_id": "MI-001",
  "investigation_timestamp": "...",
  "assets": ["BTC", "ETH"],
  "window_start": "...",
  "window_end": "...",
  "market_classification": "MARKET_WIDE",
  "catalysts": [
    {
      "category": "MACRO",
      "event_timestamp": "...",
      "first_public_timestamp": "...",
      "discovery_timestamp": "...",
      "direction": "DOWN",
      "confidence": 0.87,
      "description": "...",
      "sources": [
        {
          "title": "...",
          "publisher": "...",
          "url": "...",
          "published_at": "..."
        }
      ]
    }
  ]
}
```

The exact implementation schema may be adapted to the existing
coin_catalyst_log schema.

---

# Allowed Categories

MACRO
FED_RATES
INFLATION
EMPLOYMENT
USD
ETF_FLOWS
REGULATION
EXCHANGE
STABLECOIN
LIQUIDATION
LEVERAGE
TECHNICAL
ON_CHAIN
GEOPOLITICAL
SECURITY
PROTOCOL
OTHER

---

# Market Classification

Allowed:

MARKET_WIDE
SECTOR_SPECIFIC
ASSET_SPECIFIC
NO_CLEAR_CATALYST

Gemini may propose a classification.

CryptoPulse must preserve that it is an AI-generated classification.

Do not treat it as objective truth without validation.

---

# Confidence

Gemini may assign:

HIGH
MEDIUM
LOW

or a numeric confidence if the schema requires it.

Confidence describes confidence in the catalyst attribution,
NOT confidence in the crypto price direction.

Do not confuse the two.

---

# Catalyst Validation

Before writing a catalyst to D1:

Validate:

1. Required fields.
2. Allowed category.
3. Allowed market classification.
4. Valid timestamps.
5. Source URL format.
6. No impossible timestamp ordering.
7. No duplicate catalyst.
8. No fabricated timestamp.
9. No fabricated URL.

CryptoPulse computes:

available_before_prediction

from timestamps.

Gemini does not write this field.

---

# Duplicate Detection

The same catalyst may affect multiple assets.

Do not create unnecessary duplicate event records.

Prefer:

one market event
+
multiple affected assets

when appropriate.

However, asset-specific catalysts should remain separate where their causes
are genuinely different.

---

# Failure Handling

If Gemini:

- times out
- returns malformed JSON
- returns no useful source
- cannot establish a credible catalyst
- exceeds rate limits
- produces contradictory timestamps

then:

1. Do not write an unreliable catalyst.
2. Record the investigation failure.
3. Preserve the market event for later retry.
4. Do not block prediction generation.
5. Do not block the daily learning report.

Market intelligence is auxiliary infrastructure.

It must never become a dependency for making predictions.

---

# Rate Limiting

Gemini usage must be bounded.

Implement configurable limits:

MAX_INVESTIGATIONS_PER_DAY
MAX_INVESTIGATIONS_PER_HOUR
MAX_ASSETS_PER_INVESTIGATION

Do not hard-code assumptions about Gemini pricing or free-tier limits.

Configuration must allow the limits to be changed without modifying model logic.

---

# API Key Security

The Gemini API key must never be:

- committed to Git
- stored in frontend code
- returned by an API
- included in logs
- exposed to the dashboard

Use Cloudflare Worker secrets/environment configuration.

---

# Cost Control

Prefer event-triggered investigation over continuous monitoring.

Prioritize:

1. high-confidence model failures
2. large market movements
3. correlated failures
4. unusual regime changes

Do not investigate every normal daily price fluctuation.

---

# D1 Write Policy

Gemini must never directly access D1 credentials.

The Worker owns database access.

The Worker:

1. requests Gemini analysis
2. validates response
3. computes timestamp-derived fields
4. deduplicates
5. writes validated catalyst records

---

# Auditability

Every Gemini investigation must be traceable.

Store or make available:

- investigation ID
- request timestamp
- model identifier
- trigger reason
- affected assets
- event window
- response status
- source count
- validation status

Do not necessarily store the full Gemini prompt/response if storage or privacy
considerations make that undesirable.

At minimum, preserve enough metadata to reproduce or audit the investigation.

---

# No Prediction Feedback

Gemini catalyst output must NOT initially become a feature of the prediction
model.

Phase 1:

Market analysis only.

Later:

Historical analysis may determine whether catalyst categories are predictive.

Only then may a formal experiment be proposed.

---

# Future Experiments

Potential future experiments include:

- event-risk regime detection
- macro-event confidence adjustment
- volatility-event detection
- catalyst-aware variant selection
- market-wide shock detection
- post-event recovery behavior

Each must follow `.ai/EXPERIMENT_PROTOCOL.md`.

---

# Definition of Done

Gemini Market Intelligence is complete only when:

[ ] Gemini integration is isolated from prediction logic.

[ ] API key is securely stored.

[ ] Significant-event triggers are configurable.

[ ] Gemini output is structured.

[ ] Source URLs are preserved.

[ ] Event/publication/discovery timestamps are preserved.

[ ] available_before_prediction is computed by CryptoPulse, not Gemini.

[ ] Invalid responses cannot corrupt D1.

[ ] Duplicate catalysts are handled.

[ ] Rate limits are configurable.

[ ] Gemini failure cannot stop predictions.

[ ] Catalyst investigations are auditable.

[ ] Automated tests cover timestamp and validation logic.

[ ] No Gemini output is used as a prediction feature.

[ ] No Production model behavior changes.
