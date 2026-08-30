# CryptoPulseV2 — Market Catalyst Attribution

## Objective

Determine why significant crypto price movements occurred.

This is an analytical layer, not a prediction feature initially.

---

# Gemini Market Intelligence Integration

Gemini is the external market-intelligence provider for catalyst discovery.

Gemini is responsible for finding and explaining possible catalysts.

CryptoPulse remains responsible for:

- timestamp validation
- prediction-time availability
- schema validation
- deduplication
- D1 persistence

ChatGPT remains responsible for independent interpretation.

---

# Catalyst Evidence Levels

Every catalyst should be considered one of:

EVIDENCE_CONFIRMED
EVIDENCE_PROBABLE
EVIDENCE_WEAK
NO_CLEAR_CATALYST

Gemini may initially propose the classification.

The system should preserve the distinction between AI attribution and
verified source evidence.

---

# Three Timestamp Model

Catalyst analysis must distinguish:

## Event Timestamp

When the underlying event actually occurred.

## First Public Timestamp

When credible public information about the event became available.

## Discovery Timestamp

When Gemini discovered the information.

These timestamps are NOT interchangeable.

Example:

Event:
12:00

First public report:
12:15

Gemini discovery:
13:00

Prediction:
12:30

Result:

available_before_prediction = false

Even though the event occurred before the prediction, credible public
information was not available until after the prediction.

---

# Deterministic Availability

CryptoPulse must calculate:

available_before_prediction

using:

first_public_timestamp <= prediction_timestamp

If first_public_timestamp is unknown:

available_before_prediction = unknown

Never infer availability from event_timestamp alone.

---

# Catalyst Provenance

Every AI-derived catalyst must retain provenance.

At minimum:

- investigation_id
- source URL
- source title
- publisher
- publication timestamp
- event timestamp
- first public timestamp
- discovery timestamp
- Gemini confidence
- validation status

---

# Gemini Failure

If Gemini cannot establish a credible catalyst:

store:

NO_CLEAR_CATALYST

or retain the event as unresolved.

Do not manufacture an explanation.

---

# ChatGPT Interpretation

ChatGPT may classify the final analytical interpretation as:

PREDICTABLE_EVENT
PARTIALLY_PREDICTABLE
UNPREDICTABLE_EVENT
INSUFFICIENT_EVIDENCE

This is an audit conclusion and must remain separate from Gemini's original
catalyst attribution.

---

# Catalyst → Model Learning

A catalyst must NOT automatically become a model feature.

First establish historical evidence.

Example:

If 30 high-confidence prediction failures occurred around major macro events,
ChatGPT may propose:

EXP-XXX — Event-risk regime experiment

Claude then tests the hypothesis.

Only successful out-of-sample evidence can justify production consideration.

---

# Core Question

For every significant resolved prediction:

1. What happened in the market?
2. What credible catalyst explains the movement?
3. When did the event occur?
4. When did credible public information become available?
5. When did Gemini discover it?
6. Was the information available at prediction time?
7. Did the model have an observable warning?
8. Does historical evidence show similar failures?

---

# Market Classification

Classify events as:

MARKET_WIDE
SECTOR_SPECIFIC
ASSET_SPECIFIC
NO_CLEAR_CATALYST

---

# Catalyst Categories

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

# Catalyst Record

Store:

- event_id
- event_timestamp
- discovery_timestamp
- asset
- category
- direction
- magnitude
- description
- source
- source_url
- confidence
- available_before_prediction

---

# Timestamp Integrity

This is mandatory.

For prediction:

T0 = prediction timestamp

For catalyst:

T1 = catalyst publication/event timestamp

If:

T1 <= T0

then:

available_before_prediction = true

Otherwise:

available_before_prediction = false

Do not use information published after T0 to explain why the model should have predicted the event.

---

# Market-Wide Detection

Compare the asset move against:

- BTC
- ETH
- major crypto index if available
- relevant sector assets

Example:

BTC -5%
ETH -6%
SOL -8%
LINK -7%

Likely:

MARKET_WIDE

Example:

BTC -5%
ETH +1%
SOL +2%

Potentially:

ASSET_SPECIFIC

---

# Catalyst Confidence

Use:

HIGH
MEDIUM
LOW

Never force a catalyst attribution when evidence is weak.

"NO_CLEAR_CATALYST" is a valid result.

---

# Learning Use

Catalyst attribution must initially be analytical only.

Do not directly feed LLM-generated catalyst labels into the prediction model.

After sufficient historical evidence exists, investigate whether catalyst categories systematically correspond to model errors.

Possible future experiments:

- event-risk regime
- macro-event confidence reduction
- volatility-event detection
- catalyst-aware model selection

These must be experiments, not automatic production changes.

---

# Market Analysis Report

For each major event report:

1. What happened?
2. Which assets moved?
3. How large was the move?
4. What was the likely catalyst?
5. When did the catalyst become public?
6. Was it known before the prediction?
7. Did the model have any observable warning?
8. Did similar historical situations exist?
9. Did the model systematically fail under similar conditions?
10. Should this become a future experiment?
