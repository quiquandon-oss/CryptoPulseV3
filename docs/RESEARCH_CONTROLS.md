# Research Controls (Lab › Experiments)

V3 is a static GitHub Pages site. It holds no credential and has no server. Research Controls
therefore show **execution status from GitHub's public Actions API** for the public
`quiquandon-oss/PulseWorkerV2` repository. That API needs no token, and V3 uses ETag requests,
so an unchanged run list does not count against the 60-requests-per-hour limit.

Execution, data quality and research outcome are three separate statuses. A succeeded run shows
only that the job ran.

## Verified job inventory

Taken from the workflow files on PulseWorkerV2 `main` @ `dff12cc` on 2026-10-11.

| Workflow | Trigger | Writes / secrets | V3 policy |
|---|---|---|---|
| `prediction-freshness-check.yml` | `workflow_dispatch` | none / none (public endpoints only) | **Run now** |
| `exp23-forward-evaluation.yml` | `schedule` 12:10 UTC only | pushes `research-data/exp23-evaluation` / none | Scheduled only: no dispatch trigger, by approved design |
| `research-forward-schedule.yml` | `schedule` 10:40 UTC only | pushes `research-data/risk-regime-forward` / none | Scheduled only |
| `export-learning-data.yml` | schedule 08:00 + dispatch | pushes `main` / `CLOUDFLARE_API_TOKEN` (production D1) | Owner authorization outside V3 |
| `exp004-timesfm.yml` | schedule 07:30 + dispatch | — / `CLOUDFLARE_API_TOKEN` | Owner authorization outside V3 |
| `exp005`, `exp009`, `exp010` | weekly Monday + dispatch | — / `CLOUDFLARE_API_TOKEN` | Owner authorization outside V3 |
| `live-evidence-collection.yml` | every 6 h | — / `CLOUDFLARE_API_TOKEN` | Owner authorization outside V3 |
| market-move sealed evaluation | none (local script `research/market_moves/evaluate.py` @ `4ea1bc1`) | report only / none | Protected: blocked, no execution mechanism |
| deploy, canary/production audits, stage7, test | — | production/staging write access | Not exposed |

**What a click can and cannot grant:**
- A click in V3 never authorizes production data access. That's why the jobs that read D1 are
  not startable from V3.
- A click never changes a frozen definition or plan.
- The protected-evaluation review only supplies the plan sha256 that the evaluator itself
  requires.

## How "Run now" works today

For the one eligible job, V3 opens GitHub's own *Run workflow* page. The owner's GitHub sign-in
is what authorizes the dispatch.

V3 then records the request locally as *not yet confirmed*. It shows the run as started only once
GitHub lists a new `workflow_dispatch` run created after the request. If no run appears within
10 minutes, it records that nothing was started.

V3 offers no Run now while a run is queued or running.

## Overview after executions

V3 checks GitHub run status:
- every 60 s while a tracked run is active or a request is waiting for confirmation;
- every 5 min otherwise, while the Lab is visible;
- immediately on Refresh Data.

When a tracked run changes state:
- **Queued or started:** the Overview re-fetches its sources. This is rate-limited to once per
  2 min.
- **Finished, failed or blocked:** a final full refresh always runs. V3 records the run, its
  trigger and commit, whether the refresh succeeded, what changed and what didn't, and any
  unresolved blocker.

Each source is merged in a fixed order:
- **Older responses:** an out-of-order or older response, judged by request order and the
  backend's `generated_ts`, never replaces a newer one.
- **Failed refreshes:** a failure keeps the last verified value, marked *not current*.

## Missing infrastructure for one-click and protected launches

1. **Server-side dispatcher.** A Worker endpoint, for example
   `POST /api/research-controls/dispatch {workflow, ref, inputs}`. It would need:
   - a fine-grained GitHub token limited to `actions: write` on PulseWorkerV2;
   - owner authentication on every call (for example, an admin token checked in the Worker,
     never in V3);
   - an allowlist of dispatchable workflow files;
   - a server-side audit record (who, what, run id, commit, timestamps).

   `api/controls.js` has `DISPATCH_ENDPOINT = null` until it exists.
2. **A reviewed `workflow_dispatch` workflow for the market-move sealed evaluation.**
   - It would pass the plan sha256 as an input to `evaluate.py --authorize-evaluation`.
   - It needs `contents: write` limited to a research-data branch, no secrets and no D1.
3. **EXP-23 manual runs.** These would need a reviewed change adding `workflow_dispatch` to
   `exp23-forward-evaluation.yml`. Its approved design is schedule-only.

Until (1) and (2) exist, the protected-evaluation panel shows the exact specification, period and
safeguards and checks the confirmation, but its launch button stays disabled with the reason.
Nothing is recorded as authorized and nothing is launched.
