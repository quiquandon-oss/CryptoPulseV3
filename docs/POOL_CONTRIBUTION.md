# Standalone outcome vs pool contribution

Each experiment in the Lab has two separate dimensions. Neither is derived from the other.

| Dimension | Question | Source | States |
|---|---|---|---|
| **Standalone** | Did the experiment's own frozen hypothesis and plan show value? | `standalone_evaluations` in the registry | Status: `NOT_RUN`, `BLOCKED`, `INCOMPLETE`, `EVALUATED`. Outcome: `SUPPORTED`, `NOT_SUPPORTED`, `INCONCLUSIVE`, `NOT_APPLICABLE` |
| **Pool contribution** | Does the experiment's component add value to a defined pool? | `pool_component` and `pool_evaluations` in the registry | `NOT_TESTED`, `CANDIDATE`, `VALIDATED_INCREMENTAL_VALUE`, `REDUNDANT`, `DEGRADING`, `INCONCLUSIVE`, `BLOCKED` |

## Rules
- **The two dimensions never infer each other.**
  - A standalone failure can be a pool candidate and still stays a standalone failure.
  - A standalone success says nothing about pool value.
- **Records are append-only** (PulseWorkerV2 migration 0022).
  - A correction is a new row with `supersedes_id`.
  - A pool record can never change a standalone record.
  - The history shows every record, including rejected claims.
- **`CANDIDATE` is a designation, not a measurement.** It is shown as "Candidate — not evidence of value". It is never counted as a validated contributor.
- **A conclusive pool state** (`VALIDATED_INCREMENTAL_VALUE`, `REDUNDANT`, `DEGRADING`) is accepted by `api/pool.js` only when every condition holds:
  1. It cites an **approved** protocol id, with the sha256 listed in `APPROVED_POOL_PROTOCOLS`.
  2. Its pool id and version match the protocol's. An incompatible pool version is blocked.
  3. It has a valid evaluation window marked out-of-sample.
  4. It reports integer `baseline_n`, `candidate_n` and `overlap_n`, with the overlap at least the protocol's `min_sample`.
  5. If the eligible observations differ between the two pools, the composition change is stated (`composition_change`).
  6. It gives baseline and with-component values for the protocol's metric. Any other metric is ignored.
  7. Its uncertainty interval contains `candidate − baseline`.
  8. It carries an evidence sha256, evidence references and an evaluator version.
  9. The recorded state equals the state given by the protocol's own rule. The rule compares the interval with the protocol's `min_effect` and `equivalence_margin`; no threshold is built into V3.

  Any failure shows the record as **Blocked**, with the reason and the rejected claim.
- **Malformed records are listed as ignored.** That covers missing provenance, an unknown state or an invalid count. They never become current and never touch the other dimension.

## Current position (2026-10-12)
- **No pool protocol is approved** (`APPROVED_POOL_PROTOCOLS = {}`), so no component can be validated, judged redundant or judged degrading.
- **Pool status:**
  - EXP-004: TimesFM BTC direction is a candidate.
  - EXP-005: individual V1 sources are candidates (research-only).
  - EXP-009: not tested, because it is descriptive and has no predictive component.
- **Standalone:** EXP-004, EXP-005 and EXP-009 are each **Blocked**, with the exact reason in the registry record. EXP-009's outcome is *Not applicable*, because it is not a hypothesis test.

## What a pool test needs before any candidate can be validated
1. **A frozen, approved pool protocol**, with its sha256 added here. It must define:
   - the pool (members, combination rule, version) and the baseline pool without the candidate;
   - the label and outcome definition, the eligible-observation rule and the overlap handling;
   - the out-of-sample window and the split;
   - the metric and its direction, `min_effect`, `equivalence_margin` and `min_sample`;
   - the interval method and level, and any multiple-testing correction.
2. **A reproducible evaluator, pinned by version**, that runs the baseline and candidate pools on the same eligible observations in temporal order. It must:
   - report the composition change when the candidate alters eligibility;
   - record negative, null and inconclusive results as well as positive ones.
3. **Authorized read access** to the evaluation data. For EXP-004 and EXP-005 that data is in production D1. The protocol must also not consume a sealed holdout.

## Compatibility
- Registries that predate these fields are read as **Not reported**, never as a default outcome. All existing fields are unchanged.
- The Lab works with or without migration 0022:
  - **Without it:** only the code-defined records are shown, and the Overview says so.
  - **If the tables cannot be read:** the error is shown.
