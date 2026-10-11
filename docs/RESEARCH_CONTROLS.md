# Research Controls (Lab › Experiments)

V3 is a static GitHub Pages site and holds no GitHub credential. Research Controls show
**execution status from GitHub's public Actions API** for the public
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

## How "Run now" works

V3 dispatches through the dedicated Worker **`cryptopulse-research-dispatcher`**
(`https://cryptopulse-research-dispatcher.quiquandon.workers.dev`, source in PulseWorkerV2 `dispatcher/`). That
Worker holds the GitHub credential server-side; see `dispatcher/README.md` there for the security model, API and
secret provisioning.

1. The owner enters the **owner dispatch key** once.
   - It is kept in session storage, or in local storage only if "remember" is ticked.
   - It is sent only to the dispatcher, in the `Authorization` header.
   - It is never rendered or logged.
2. **Run now** opens a confirmation showing the job, workflow file and ID, the fixed branch (`main`), the fixed
   repository and that no inputs are accepted. **Launch** stays disabled until it is confirmed, while a run is
   queued or running, or while the dispatcher is disabled or unreachable.
3. The dispatcher returns `accepted`. V3 shows this as *accepted by GitHub, not started yet*. Only when GitHub's
   public run list shows a new `workflow_dispatch` run does V3 mark it *verified*, with the real run ID and link.
   Status then follows that run. If the dispatcher times out, the outcome is unknown, so V3 watches for a run
   instead of allowing an immediate retry.
4. Errors are shown explicitly: rejected key (the stored key is cleared), rate limit with retry time, conflict with
   the active run's ID, dispatch disabled, dispatcher unreachable, and GitHub credential, rate-limit or timeout
   failures.

**When live dispatch is unavailable** (dispatcher disabled or unreachable), V3 says why and offers GitHub's own
*Run workflow* page as a clearly labelled alternative.

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

## Remaining prerequisites

1. **Owner provisioning (needed for live dispatch).** Create the fine-grained PAT and owner key, add them as GitHub
   Actions secrets `RESEARCH_DISPATCH_GITHUB_TOKEN` and `RESEARCH_DISPATCH_OWNER_KEY` in PulseWorkerV2, and run
   *Deploy research dispatcher* (PulseWorkerV2 `dispatcher/README.md`, "Secret provisioning"). Until then the
   dispatcher reports `dispatch_enabled: false` and V3 offers no live dispatch.
2. **Market-move sealed evaluation.** It needs a reviewed `workflow_dispatch` workflow that takes the plan sha256,
   with `contents: write` limited to a research-data branch, and then an allowlist entry on the dispatcher. Until
   then the protected review checks the confirmation but launch stays disabled.
3. **EXP-23.** Its approved schedule-only governance would have to change (adding `workflow_dispatch`) before it
   could be allowlisted.
4. **Production-D1 jobs.** Each needs the owner's explicit authorization for production data access on demand and a
   per-job review before it could be allowlisted.
