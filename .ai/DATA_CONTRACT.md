# CryptoPulseV2 — Learning Data Contract

## Objective

Create an immutable historical record of every prediction and its eventual outcome.

The prediction record must never be rewritten after creation.

---

# Prediction Record

Every prediction must contain:

- prediction_id
- created_at
- asset
- horizon_hours
- model_variant
- model_version
- git_commit_sha

---

# Prediction Values

Store:

- raw_probability_up
- calibrated_probability_up
- final_probability_up
- predicted_direction
- confidence
- significance
- k_neighbors

---

# Feature Snapshot

Store the exact values used by the model:

- score
- technical_score
- regime_mag
- bottom_score

If additional features are added later, they must be versioned.

The feature snapshot represents information available at prediction time.

---

# Neighbor Snapshot

Store enough information to reproduce the decision.

At minimum:

- number of neighbors
- up neighbors
- down neighbors
- aggregate outcome
- distance summary
- weighted outcome
- selected neighbor IDs if practical

The neighbor snapshot must represent only information available at prediction time.

---

# Data Quality

Store:

- missing feature count
- stale feature count
- source timestamps
- data freshness
- data quality status

---

# Outcome Record

Outcome data must be stored separately from prediction data.

Store:

- resolved_at
- reference_price
- final_price
- realized_return
- realized_direction
- maximum_favorable_excursion
- maximum_adverse_excursion

---

# Outcome Integrity

Outcome timestamps must always be after prediction timestamps.

The system must never use outcome data during prediction generation.

---

# Versioning

Every prediction must identify the exact model version and Git commit.

Example:

model_version = "knn-v2.3.1"
git_commit_sha = "abc123..."

---

# Immutability

Once a prediction is created:

DO NOT update:

- original features
- original probability
- original model variant
- original neighbor set
- original confidence

Corrections must be represented as separate records.

---

# Required Queries

Implement efficient queries for:

1. unresolved predictions
2. predictions resolved in last 24h
3. last 7 days
4. last 30 days
5. performance by asset
6. performance by horizon
7. performance by model
8. performance by confidence bucket
9. performance by market regime
10. most confident mistakes

---

# Historical Compatibility

The new system must preserve compatibility with existing:

- btc_data
- history
- predictions
- calibration_curve
- challenger_predictions
- challenger_calibration_curve

Do not remove existing tables without a migration plan.
