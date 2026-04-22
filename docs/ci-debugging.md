# CI Debugging Guide

When fixing failing GitHub Actions checks, prefer using the `github:gh-fix-ci` skill so triage, logs, and fixes follow one consistent workflow.
For production SSH access details used during deploy/incident debugging, see [`deploy/README.md` → "SSH Access (Debugging Only)"](../deploy/README.md#ssh-access-debugging-only).

## Reading iOS Build Errors

The "iOS Native Build" CI job runs `xcodebuild archive` piped through `tail -40`, which only keeps the last 40 lines. Swift compiler errors are printed **mid-build** and get truncated. The job log only shows the final summary ("The following build commands failed") and exit code 65, not the actual error messages.

### How to get the actual Swift errors

**Option 1: Check annotations**
```bash
gh api repos/Asherlc/dofek/check-runs/<JOB_ID>/annotations
```
Sometimes Xcode errors show up as GitHub annotations, but usually only the exit code is annotated.

**Option 2: Download the full log and search**
```bash
gh api repos/Asherlc/dofek/actions/jobs/<JOB_ID>/logs > /tmp/ios-build-log.txt
grep "error:" /tmp/ios-build-log.txt | grep -v "Werror\|error_\|error-limit\|error="
```
Note: even the full log may not contain inline Swift errors because the `| tail -40` in the workflow truncates the xcodebuild output before it reaches the log.

**Option 3: Reproduce locally**
The most reliable approach — build the iOS project locally:
```bash
cd packages/mobile/ios
xcodebuild build \
  -workspace Dofek.xcworkspace \
  -scheme Dofek \
  -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  CODE_SIGNING_ALLOWED=NO 2>&1 | grep "error:"
```

**Option 4: Look at the "build commands failed" section**
The last 40 lines usually include which **target** failed (e.g., `ExpoHealthKit`, `ExpoWhoopBle`). From the target name, you can infer which Swift files have errors and check them manually.

### Common iOS build failures

| Symptom | Cause |
|---------|-------|
| `ExpoWhoopBle` compile failure | Duplicate method definition (e.g., merge conflict leaving two `ensureCentralManager()` functions) |
| `ExpoHealthKit` compile failure | Invalid iOS 26 API usage (wrong factory methods, types referenced outside `if #available` blocks) |
| Exit code 65 with no visible errors | xcodebuild output truncated by `tail -40` — reproduce locally |

## Getting Job IDs

```bash
# List failed checks for a PR
gh pr checks <PR_NUMBER> | grep fail

# The URL at the end contains the run ID and job ID
# Format: https://github.com/Asherlc/dofek/actions/runs/<RUN_ID>/job/<JOB_ID>

# Or get job IDs programmatically
gh run view <RUN_ID> --json jobs -q '.jobs[] | select(.conclusion == "failure") | "\(.name): \(.databaseId)"'
```

## Other CI checks

| Check | How to debug |
|-------|-------------|
| Migration Lint | `gh api repos/Asherlc/dofek/actions/jobs/<JOB_ID>/logs` — squawk errors are inline |
| Spell Check | Same — cspell errors are inline with `Unknown word (...)` format |
| Swift Tests | Same — XCTAssert failures are inline |
| Coverage | Usually fails because upstream test/build jobs failed; fix those first |
| Unit & Integration Tests | Depends on unit/integration test jobs; check if they passed individually |

## Deploy Rollout Healthcheck Failures

If `Deploy App` fails during rollout with healthcheck output like `wget: can't connect to remote host: Connection refused`, verify whether the new container is still running startup work instead of listening yet.

### How to diagnose quickly

1. Pull full logs for the failed deploy job:
```bash
gh run view <RUN_ID> --job <JOB_ID> --log
```
2. Check if the failure happens during `rollout web` and includes repeated healthcheck failures.
3. Correlate timestamps with container logs printed by rollout. If you see migration/view logs during the healthcheck window, startup work is blocking readiness.

### Correct fix pattern

1. Keep `web` startup focused on serving traffic.
2. Run migrations as a separate explicit deploy step before `rollout web` (for example `compose run --rm web migrate`).
3. Use `start_period` only as a bounded startup grace window, not as the primary migration strategy.

## Deploy Migration Failures (`database system is in recovery mode`)

If `Deploy App` fails with `[migrate] PostgresError: the database system is in recovery mode`, the migration started before Postgres finished startup/recovery.

### Correct fix pattern

1. Add a pre-migration DB readiness gate that checks writability, not just port reachability.
2. Use a bounded loop that runs:
   `SELECT NOT pg_is_in_recovery();`
3. Run migration only after this returns `t`.
4. Keep migration retries as a secondary guard for transient failures.

If recovery mode persists and logs show `No space left on device`, treat it as a storage incident and follow `docs/metric-stream-timescaledb-runbook.md` plus the agent skill `.agents/skills/db-incident-response/SKILL.md`.
