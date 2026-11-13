# CI Debugging Guide

This guide assumes you are debugging from a terminal with the `gh` CLI installed.
For production SSH access details used during deploy or incident debugging, see [`deploy/README.md` → "SSH Access (Debugging Only)"](../deploy/README.md#ssh-access-debugging-only).

## Reading iOS Build Errors

If filtered logs stop without a causal error, download the complete job log
before deciding which command failed. During [PR #3166's preview failure](https://github.com/Asherlc/dofek/actions/runs/41074540752/job/124127095782),
`gh run view --log-failed` output stopped at runtime-resolution diagnostics,
while the complete job log showed a later upload-authentication failure.
GitHub provides a [plain-text job-log download endpoint](https://docs.github.com/en/rest/actions/workflow-jobs#download-job-logs-for-a-workflow-run):

```bash
gh api repos/Asherlc/dofek/actions/jobs/<JOB_ID>/logs > /tmp/ci-job.log
rg -n 'Error:|error:|Process completed' /tmp/ci-job.log
```

The [native CI archive](../.github/workflows/build-mobile.yml) retains complete
build output. The [signed release archive](../.github/workflows/build-ios-release.yml)
also sends complete output directly to the GitHub job log, suppresses shell
environment display, and prints a stock result-bundle summary after archive
failure when a bundle exists. The original archive status still fails the job.
Older signed runs used `tail -40`; downloading their job logs cannot recover
output discarded before reaching GitHub.

Read the first causal diagnostic, not only the final failed-target summary.
For package-resolution failures, compare cold-fetch behavior with the exact
source, Xcode version and runner image. A successful archive using restored
DerivedData does not establish that a fresh dependency fetch succeeds. The
[November 12 incident](production-incident-baseline.md#separate-signed-ios-archive-failure)
records a missing SwiftPM repository path whose initial fetch cause was not
preserved. Do not infer stale-cache corruption from that path alone.

### Signed archive diagnostic confidentiality

Use the downloaded GitHub job log for signed-build diagnostics. The existing
secret loader registers known values with GitHub's log masker, but this does
not sanitize a raw file captured by `tee` or an uploaded `.xcresult` bundle.
Do not upload raw signed-build diagnostic files. Inspect the temporary bundle
on the runner and send useful stock summary output through the same masked
job-log channel. Literal masks are not a guarantee for transformed or encoded
secret values; avoid environment dumps and credential traces. See
[GitHub log masking](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#masking-a-value-in-a-log),
[secure use](https://docs.github.com/en/actions/reference/security/secure-use),
and Apple's [result-bundle tooling](https://developer.apple.com/documentation/xcode-release-notes/xcode-16_3-release-notes).

### Common iOS build failures

| Symptom | Next check |
|---------|------------|
| `ExpoWhoopBle` compile failure | Read the first Swift diagnostic and the named source/target. |
| `ExpoHealthKit` compile failure | Check the exact compiler diagnostic, API availability and deployment target. |
| Exit code 65 with no visible errors | Download the full job log; historical `tail -40` output may require a new evidence-preserving reproduction. |

## Getting Job IDs

```bash
# List failed checks for a PR
gh pr checks <PR_NUMBER> | grep fail

# Or get failed job IDs programmatically from a run
gh run view <RUN_ID> --json jobs -q '.jobs[] | select(.conclusion == "failure") | "\(.name): \(.databaseId)"'
```

## Other CI checks

| Check | How to debug |
|-------|-------------|
| Migration Lint | `gh run view <RUN_ID> --job <JOB_ID> --log` — squawk errors are inline |
| Spell Check | Same — cspell errors are inline with `Unknown word (...)` format |
| Swift Tests | Same — XCTest failures are inline |
| Coverage | Usually fails because upstream test/build jobs failed; fix those first |
| Unit & Integration Tests | Depends on unit/integration test jobs; check if they passed individually |

### Partial Codecov coverage while integration shards run

The [test workflow](../.github/workflows/test.yml) uploads five coverage reports:
one unit report and four integration shards. Codecov [merges these uploads](https://docs.codecov.com/docs/merging-reports)
for the commit. Check all five upload steps before diagnosing a project-coverage
regression; an early partial report can fall below the target even when the
complete report passes. The [repository configuration](../codecov.yml) uses
Codecov's [`after_n_builds: 5`](https://docs.codecov.com/docs/notifications#preventing-notifications-until-after-n-builds)
to wait for those reports before sending status notifications. Keep this count
aligned with the workflow's coverage uploads when changing the shard matrix.
Both upload steps enable [`fail_ci_if_error`](https://github.com/codecov/codecov-action/blob/303a32d7a59b442fa8d48b6a1cc6825c09c847a5/action.yml#L51-L54)
so an upload error fails its job instead of leaving a missing report unnoticed.

## Deploy Rollout Healthcheck Failures

If `Deploy Web Stack` fails during rollout with healthcheck output like `wget: can't connect to remote host: Connection refused`, verify whether the new container is still running startup work instead of listening yet.

### How to diagnose quickly

1. Pull full logs for the failed deploy job:
```bash
gh run view <RUN_ID> --job <JOB_ID> --log
```
2. Check if the failure happens during `docker stack deploy --detach=false` and includes repeated healthcheck failures for `web`.
3. Correlate timestamps with container logs printed by rollout. If you see migration/view logs during the healthcheck window, startup work is blocking readiness.

### Correct fix pattern

1. Keep `web` startup focused on serving traffic.
2. Run migrations as a separate explicit deploy step before `docker stack deploy`; production does this with a one-shot `migrate` container on the swarm overlay network.
3. Use `start_period` only as a bounded startup grace window, not as the primary migration strategy.

## Deploy Migration Failures (`database system is in recovery mode`)

If `Deploy Web Stack` fails with `[migrate] PostgresError: the database system is in recovery mode`, the migration started before Postgres finished startup/recovery.

### Correct fix pattern

1. Add a pre-migration DB readiness gate that checks writability, not just port reachability.
2. Use a bounded loop that runs:
   `SELECT NOT pg_is_in_recovery();`
3. Run migration only after this returns `t`.
4. Keep migration retries as a secondary guard for transient failures.

If recovery mode persists and logs show `No space left on device`, treat it as a storage incident. Follow [`metric-stream-timescaledb-runbook.md`](metric-stream-timescaledb-runbook.md), then inspect disk usage and Docker volume usage on the server before changing deploy logic.
