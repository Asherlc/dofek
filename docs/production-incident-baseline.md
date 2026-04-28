# Production Incident Baseline

<!-- cspell:ignore Hetzner Hypertables rollups fanout Checkpointed subcheck MISCONF docuum anchore -->

This document summarizes production failure modes observed so far. It is not a
full incident log or a replacement for runbooks. Use it to build shared memory
about the kinds of issues this system encounters, the signals that identified
them, and the durability work they suggest.

## 2026-04-28: Garmin Sync Lost Status During DB Recovery

### Impact

Garmin Connect sync appeared to lose status in the web UI while sync jobs were
still present in Redis. Some Garmin jobs failed or stalled instead of cleanly
resuming from the point where database writes stopped.

### What Happened

Redis showed a Garmin sync job still active with provider progress marked
`running`, while prior Garmin jobs had failed or stalled. Production Postgres was
periodically entering recovery at the same time the Garmin sync tried to persist
records and update `fitness.user_settings` for `garmin_sync_cursor`.

### Evidence That Mattered

- UI message source: `pollSyncJob()` returns `Lost sync status` when
  `sync.syncStatus` returns `null`.
- Redis job evidence: Garmin job `525` remained active while jobs `519` through
  `524` had failed or stalled.
- Postgres fatal line: `FATAL: the database system is in recovery mode`.
- Kernel evidence: repeated Postgres OOM kills inside the DB cgroup.
- Heavy workload correlation: active
  `REFRESH MATERIALIZED VIEW CONCURRENTLY fitness.deduped_sensor`.

### Root Cause

A memory-heavy `fitness.deduped_sensor` materialized-view refresh pushed
Postgres into OOM/recovery. Garmin sync treated the resulting database failures
as ordinary provider errors, so BullMQ could not reliably retry the same job
from an in-progress checkpoint.

### Fix Or Mitigation

The active `fitness.deduped_sensor` refresh was canceled after confirming
Postgres had recovered. Sync jobs now store a fixed `sinceIso`, pass
provider-owned checkpoint state through BullMQ job data, and rethrow retryable
infrastructure failures so BullMQ retries the same job. Garmin now checkpoints
completed phases and dates, then resumes from the saved checkpoint on retry.

### Remaining Risk

Checkpointed retries make provider sync more durable, but they do not remove the
underlying DB memory pressure from expensive materialized-view refreshes. The
refresh workflow still needs bounded execution and stronger scheduling so it
cannot compete with live sync writes.

## 2026-04-28: Review App Hetzner Placement Unavailable

### Impact

PR #1037 failed the `Deploy Review App` check before a review server could be
created. Application build and test checks were not implicated.

### What Happened

The review-app workflow reached Terraform apply, planned one new
`hcloud_server.review` named `dofek-pr-1037`, and requested the configured
review-app server type in `nbg1`.

### Evidence That Mattered

- Failing step: `Apply review app infrastructure`
- First fatal line:
  `Error: error during placement (resource_unavailable, 9f92993d621029d2c01b7868edfa5bb5)`
- Terraform resource: `hcloud_server.review` in `server.tf` line 27
- Planned server attributes included `server_type = "cax11"` and
  `location = "nbg1"`

### Root Cause

Hetzner could not place the configured review-app server type in the configured
location. This differed from the previous `resource_limit_exceeded` quota
failure; the account can still have free server quota when regional placement
capacity is unavailable.

### Fix Or Mitigation

The review-app workflow now treats `resource_unavailable` / `error during
placement` as a non-code review-app skip. It posts a PR comment explaining that
Hetzner could not allocate the configured review server and exits successfully,
while preserving hard failures for unrelated Terraform errors.

### Remaining Risk

The PR will not receive a live review app until Hetzner can allocate the
configured server or the review-app location/server type is changed.

## 2026-04-26: Review App Server Quota Exhausted

### Impact

PR review-app deployment failed before the app could be provisioned. Application
test, build, lint, typecheck, and security checks were not affected.

### What Happened

The `Deploy Review App` workflow reached the Terraform apply step for PR 1036
and failed while creating the temporary server `dofek-pr-1036`.

### Evidence That Mattered

- Failing step: `Apply review app infrastructure`
- First fatal line:
  `Error: server limit reached (resource_limit_exceeded, 47100d408ee44ebf63c5f721a811d92a)`
- Terraform resource: `hcloud_server.review` in `server.tf` line 27

### Root Cause

The Hetzner project/account had reached its server quota, so Terraform could not
create another temporary review-app server.

### Fix or Mitigation

No code mitigation was applied. The direct fix is to free unused review-app
servers or raise the Hetzner server quota, then let the existing workflow create
the server normally.

### Remaining Risk

Review apps will keep failing for new PRs until server capacity is available.

## 2026-04-25: Materialized View Refresh Saturated Production

### Impact

Production became effectively unavailable:

- Public `/healthz` and `/` requests timed out without a useful response.
- Direct host checks accepted TCP but did not return normal HTTP responses.
- SSH to the host timed out during banner exchange.
- Dashboard routes depending on activity/training analytics failed when
  materialized views were missing or unpopulated.

### What Happened

A deploy path triggered materialized-view sync work in production. The refresh
attempt involved heavy full-history work for views such as
`fitness.deduped_sensor`, `fitness.activity_summary`, and `fitness.provider_stats`.
Those views read from the large `fitness.metric_stream` hypertable.

The dangerous behavior was the combination of:

- automatic deploy-triggered materialized-view maintenance;
- destructive drop/create rebuild behavior for existing views;
- asynchronous refresh acceptance without waiting for a verified successful end
  state;
- a small single-node production host with a 2 GiB DB container memory cap;
- large historical `metric_stream` data and indexes;
- concurrent dashboard queries, materialized-view refreshes, and Timescale
  maintenance competing for the same DB resources.

When the refresh failed or was canceled, production could be left with missing
or stale materialized-view state. Follow-up repair required inspecting
`pg_matviews`, `pg_indexes`, active sessions, lock waits, and the
`drizzle.__view_hashes` metadata.

### Evidence That Mattered

Useful signals:

- External health checks timed out from both the public domain and direct host.
- Axiom showed `[views-refresh] Started` / accepted refresh logs without a
  matching completion log.
- Postgres logs showed missing `fitness.deduped_sensor` and
  `fitness.activity_summary` relations.
- Active sessions showed materialized-view refreshes, lock waits, and long
  dashboard queries blocking each other.
- `pg_stat_statements` and slow statement logs helped identify `metric_stream`
  as the main heavy table, although OOM-killed statements may not survive long
  enough to appear clearly in cumulative stats.

### Root Cause

Normal deploy/runtime paths could start full-history materialized-view
maintenance against live production data. That work was expensive enough to
saturate or OOM the small DB host, and the destructive rebuild path could remove
serving views before replacements were safely available.

### Fixes Applied

- Deploy no longer silently proceeds when materialized-view maintenance is
  required.
- Existing changed materialized views are no longer dropped/rebuilt
  automatically by `syncMaterializedViews()`.
- Missing views can still be created, but definition drift now requires explicit
  maintenance.
- A blocking materialized-view maintenance CLI and runbook were added, including
  quiet-DB preflight and a concurrent-refresh inventory.
- Production materialized-view metadata and missing indexes/views were repaired.
- Blocking materialized-view refresh fallback was removed in the follow-up PR.
- `metric_stream` was converted to a compressed Timescale workload:
  - compression enabled;
  - segment by `user_id, provider_id, channel`;
  - order by `recorded_at DESC`;
  - compression policy for chunks older than 7 days;
  - existing old chunks manually backfilled.
- Migrations were compacted into `drizzle/0000_baseline.sql`, with explicit
  Timescale setup preserved because schema dumps do not capture hypertable
  registration as ordinary table DDL.
- A runbook was added for `metric_stream` Timescale maintenance.

### Remaining Risks

- Materialized-view definition changes still require a safe planned maintenance
  workflow. The system now refuses dangerous automatic rebuilds, but the manual
  path should become blocking, observable, and bounded.
- Full-history analytical SQL can still overwhelm the single-node DB if run
  without limits.
- Compression reduces storage and IO pressure but does not solve unbounded raw
  data growth.
- The current architecture needs explicit retention policy decisions before a
  larger beta.
- Backups exist operationally, but point-in-time restore and restore drills
  should be proven separately.

### Lessons

- Hypertables do not make data smaller by themselves. Compression, retention,
  chunk sizing, and query shape determine whether large time-series data is
  operationally safe.
- Full-history maintenance must not run as an invisible side effect of normal
  deploys.
- An async `202 Accepted` maintenance endpoint is not a durability guarantee.
  It must be paired with completion tracking and post-condition checks.
- Canceling individual DB backends is only a temporary recovery action if the
  process issuing the work is still alive and can restart it.
- Compression backfill and materialized-view refresh should not run together;
  they compete for locks, IO, CPU, and memory.
- `pg_dump`-based migration compaction needs explicit checks for Timescale
  metadata and materialized-view population state.

## 2026-04-26: Review App Server Quota Blocked PR CI

### Impact

Multiple pull requests had otherwise green CI but failed the `Deploy Review App`
check. The affected PRs could not reach fully green status even though app,
test, coverage, lint, typecheck, migration lint, E2E, CodeQL, Semgrep, and
GitGuardian checks passed.

PRs that add permanent infrastructure, such as a staging server, can also reduce
available Hetzner capacity enough that draft review apps fail before the PR is
ready for review.

### Evidence That Mattered

The failed GitHub Actions jobs reached Terraform apply, planned a new
`hcloud_server.review`, then failed at server creation with:

```text
Error: server limit reached (resource_limit_exceeded, ...)
  with hcloud_server.review,
  on server.tf line 27, in resource "hcloud_server" "review":
```

The review app image build completed successfully before the deploy failure.
That separated application build health from Hetzner account capacity.

### Root Cause

The Hetzner account had no remaining server quota for additional review app
servers. Each same-repo pull request currently expects one dedicated review
server, so several concurrent PRs can exhaust the account even when the code is
healthy.

### Fix Or Mitigation

Draft PRs now skip review app image builds and deploys. Marking a PR ready for
review triggers the review app workflow. If ready-for-review PRs hit the quota,
the immediate safe operations are still to close or destroy stale review apps to
release their Hetzner servers, or raise the account server limit.

### Remaining Risk

Review apps can continue to block otherwise healthy ready-for-review PRs
whenever open PR count exceeds Hetzner server quota. Docs-only PRs still consume
review app capacity after they are marked ready unless they are closed or their
review app is manually destroyed through a supported workflow.

### Follow-Up Work

- Add a supported manual review-app destroy workflow for a specific PR number.
- Consider skipping dedicated review app servers for docs-only PRs.
- Add a visible quota/capacity note to PR check output when Hetzner returns
  `resource_limit_exceeded`.

## 2026-04-26: Terraform Provider Download Failed PR CI

### Impact

The aggregate `Test / Lint & Static Analysis` PR check failed because the
`Test / Terraform Validate` subcheck could not initialize Terraform providers.
The application code checks were not the failing path.

### Evidence That Mattered

The failing job stopped during `terraform init -backend=false` while installing
the pinned Cloudflare provider:

```text
Error while installing cloudflare/cloudflare v5.19.0: could not query provider registry
failed to retrieve authentication checksums ... 502 Bad Gateway returned from github.com
```

### Root Cause

Terraform validation downloaded provider metadata and plugin checksums from the
registry path on every uncached run. A transient upstream GitHub/registry 502 was
therefore enough to fail PR CI before validation could run.

### Fix Or Mitigation

Terraform provider plugin caching was added to both validate and deploy
workflows, keyed by `deploy/.terraform.lock.hcl`. This keeps provider binaries
available across runs while preserving the lockfile as the source of truth for
provider versions and checksums.

### Remaining Risk

The first run after a lockfile change still depends on the upstream provider
registry. If provider download availability remains a recurring failure mode,
consider mirroring providers or prewarming the cache through a scheduled job.

## Patterns To Watch

### Long-Running DB Work During Deploy

Symptoms:

- deploy appears stuck after migrations or stack update;
- `/healthz` slows or times out;
- Axiom has a start log without a done/fail log;
- `pg_stat_activity` shows long-running `REFRESH MATERIALIZED VIEW`,
  `CREATE MATERIALIZED VIEW`, compression, migration, or dashboard SQL.

Rule of thumb: identify the first fatal/blocking DB statement before changing
deploy behavior. Do not add retries, sleeps, or longer timeouts until the
blocking SQL is understood.

### Missing Or Unpopulated Materialized Views

Symptoms:

- dashboard/API errors mention missing relations;
- `pg_matviews.ispopulated = false`;
- planner reports view maintenance required;
- stored hashes do not match canonical `drizzle/_views` definitions.

Treat this as a repair/maintenance incident, not a reason to re-enable
automatic drop/create rebuilds.

### Unbounded Time-Series Storage

Symptoms:

- `metric_stream` dominates database size;
- indexes are close to table data size;
- future-dated chunks appear;
- compression policy leaves unexpected chunks uncompressed;
- dashboard queries scan wide historical ranges.

Compression is a mitigation. Retention and rollups are the slope-changing fix.

Current product constraint: raw data should not be permanently deleted. That
means the long-term mitigation is not simple deletion from Postgres. The likely
roadmap direction is a three-tier storage model:

- recent raw data stays in Postgres/Timescale for detailed app queries, sync
  repair, and deduplication;
- durable rollups stay in Postgres for long-range and year-over-year charts;
- old raw data is archived immutably to object storage such as R2, with
  manifests, checksums, schema versions, and rehydration metadata.

Before old raw rows leave the hot DB, the system must verify that required
rollups exist for that range and that the cold archive has been written and
read back successfully. This is roadmap work, not an immediate mitigation.

### Maintenance Jobs Fighting Each Other

Symptoms:

- compression waits on relation locks;
- materialized-view refresh and chunk compression run at the same time;
- active writer chunks resist compression;
- inserts queue behind metadata/DDL locks.

Maintenance should be serialized with advisory locks or an explicit maintenance
window. Record resistant chunks and retry later instead of forcing active writer
chunks under live traffic.

### Single-Node Capacity Limits

Symptoms:

- DB memory approaches the container cap during analytical work;
- SSH and Traefik degrade together with Postgres;
- worker fanout can enqueue more write work than the DB can absorb;
- one user's import/sync can dominate the host.

This is the main reason broader beta readiness requires global DB backpressure,
retention, restore drills, and capacity tests.

## Follow-Up Durability Work

Prioritized next work:

1. Continue hardening the materialized-view maintenance workflow with restore
   drills and production rehearsal notes.
2. Design the hot-rollup-cold storage roadmap for `metric_stream`: hot raw
   retention, durable rollups for long-range charts, and cold raw archive in R2
   or equivalent object storage.
3. Add point-in-time recovery with WAL archiving and a restore drill.
4. Add global sync/import backpressure across all BullMQ queues, separate from
   per-provider API rate limits.
5. Convert simple time-bucketed summaries to Timescale continuous aggregates
   where the query shape fits.
6. Add a synthetic capacity test for 10, 50, and 100 active users.
7. Document migration compaction steps, including Timescale and materialized-view
   verification.

## Related Docs

- [deploy/README.md](../deploy/README.md): production architecture, deploy flow,
  DB diagnostics, and rollback boundaries.
- [metric-stream-timescaledb-runbook.md](metric-stream-timescaledb-runbook.md):
  Timescale conversion, compression, and chunk backfill maintenance.
- [materialized-view-maintenance-runbook.md](materialized-view-maintenance-runbook.md):
  blocking materialized-view maintenance, preflight, and refresh inventory.
- [schema.md](schema.md): materialized-view and continuous-aggregate modeling
  rules.
- [ci-debugging.md](ci-debugging.md): CI/deploy log inspection patterns.

## 2026-04-27: CI failures from missing `fitness.user_billing`

### Impact

PR checks for `stripe-subscriptions-access-gating` (PR #1045) failed even after
code changes were applied to related code paths, preventing merge despite green
security and app/build checks. The failing checks were:

- `Test / Integration Tests`
- `Test / Mutation Testing`
- `Test / Stryker`
- `Test / Unit & Integration Tests`
- `Test / Test Gate`
- `CI Gate`
- `Deploy Review App`

### Evidence That Mattered

The first fatal line in both integration and mutation logs was:

```text
relation "fitness.user_billing" does not exist
```

This was observed in run `25003346764` and in database logs for the test
container during table bootstrap/migration setup.

### Root Cause

The `stripe-subscriptions-access-gating` branch did not include the migration that
creates `fitness.user_billing`, while later queries in the branch (and derived
jobs) expected that table to exist.

### Fix or Mitigation

A new migration was added in this branch as
`drizzle/0004_add_user_billing.sql`:

- Create `fitness.user_billing` with the expected columns and indexes.
- Backfill existing users as `existing_account`.

The CI run for PR `1049` (head `f190a7e6`) then passed all gates after this
change.

### Remaining Risk

The failing access-gating branch (`stripe-subscriptions-access-gating`) remains
red until it includes the same migration and corresponding test path. This is a
schema drift risk if downstream branches diverge from the core migration lineage.

## 2026-04-27: Redis RDB Persistence Failure (MISCONF)

### Impact

Production was experiencing errors due to Redis halting writes: `MISCONF Redis is configured to save RDB snapshots, but it's currently unable to persist to disk. Commands that may modify the data set are disabled...`.
This blocked all new background jobs (BullMQ) and queue operations, degrading any feature depending on workers (like syncing providers).

### Evidence That Mattered

While the Redis container printed a startup warning about `vm.overcommit_memory`, the actual background saving errors in the Redis logs were: `Write error while saving DB to the disk(rdbSaveRio): No space left on device`. Running `df -h` on the production server confirmed that the root filesystem (`/dev/sdb1`) was 100% full (38G/38G).

### Root Cause

The host server (`ubuntu-24.04`) ran out of disk space on its root partition. Docker images, containers, and build cache had accumulated until the 38GB disk was completely full. Since the Redis data volume was bind-mounted to the root partition rather than the dedicated persistent storage volume, it was unable to write its RDB snapshot to disk.

### Fix or Mitigation

1. Executed `docker system prune -a -f` via SSH on the host, which reclaimed 18GB of space and immediately allowed Redis to complete its background save and unblock writes.
2. Moved Redis persistence from the root-disk Docker volume to `/mnt/dofek-data/redis` on dedicated Hetzner block storage, with Terraform creating the directory and copying the legacy Docker volume contents on existing hosts.
3. Changed docuum from a 10GB image-cache threshold to a 0GB threshold so unused Docker images are pruned aggressively before they can fill the root disk again.
4. (Incidental) Added `sysctl -w vm.overcommit_memory=1` to Terraform and `deploy/server/cloud-init.yml` to satisfy the Redis kernel memory warning, though this was not the primary cause of the outage.

### Remaining Risk

Docker volumes and non-image artifacts can still accumulate on the root disk. Redis is no longer exposed to root-disk exhaustion for RDB snapshots, but the host still needs disk monitoring and periodic review of `docker system df` output.

## 2026-04-28: PR 1041 mobile dashboard integration failure

### Impact

PR checks for `Asher-Cohen/mobile-pages-take-too-long-to-render` (PR #1041)
were blocked by failing test gates:

- `Test / Integration Tests`
- `Test / Mutation Testing`
- `Test / Stryker (0)`
- `Test / Unit & Integration Tests`
- `Test / Test Gate`
- `CI Gate`

### Evidence That Mattered

The first fatal database log line in run `25027801889` was:

```text
ERROR: column "deep_pct" does not exist at character 185
```

The failing query came from `mobileDashboard.dashboard` and selected
`deep_pct`, `rem_pct`, `light_pct`, and `awake_pct` directly from
`fitness.v_sleep`.

### Root Cause

`fitness.v_sleep` exposes raw sleep-stage minute columns, not derived percentage
columns, while the mobile dashboard route expected percentage columns to exist.

### Fix or Mitigation

The mobile dashboard sleep query now derives stage percentages from
`deep_minutes`, `rem_minutes`, `light_minutes`, `awake_minutes`, and
`duration_minutes` in SQL.

### Remaining Risk

No remaining risk is known for this failure mode after the targeted mobile
dashboard integration test and changed-test suite passed locally.

## 2026-04-28: False HRV anomaly from mixed provider baseline

### Impact

Production showed a `Health Warning` for Heart Rate Variability:

```text
Heart Rate Variability: 24.336102 (baseline: 57.5 +/- 11.8, z-score: -2.81)
```

The warning was misleading because the displayed value came from Apple Health,
while the baseline was mostly derived from WHOOP-backed `v_daily_metrics` rows.

### Evidence That Mattered

Production `fitness.daily_metrics` had `2026-04-28` HRV `24.336102` from
`apple_health` / `Asher's Apple Watch`. WHOOP had recent HRV rows on prior days
but no `2026-04-28` daily HRV row at the time of the warning. Comparing the same
Apple Watch series against itself showed `2026-04-28` at about `-0.89` standard
deviations, not an anomaly.

Production also had `0` rows in both `fitness.provider_priority` and
`fitness.device_priority`, and the server image did not copy
`provider-priority.json`, so post-sync maintenance could not populate priority
tables in the deployed container.

### Root Cause

Anomaly detection computed HRV baselines from `fitness.v_daily_metrics`, which
can switch providers day to day. When the preferred WHOOP HRV row was missing
for the target date, the target value fell back to Apple Health but was still
compared to the WHOOP-shaped baseline.

### Fix or Mitigation

HRV anomaly detection now selects the target day's best HRV source and computes
the HRV baseline only from prior rows with the same `provider_id` and
`source_name`. The server image now includes `provider-priority.json`, and
post-sync maintenance syncs provider priorities before refreshing materialized
views so the same run uses current priorities.

### Remaining Risk

Resting heart rate anomaly detection still uses `v_daily_metrics`; if provider
scale differences appear there too, it should get the same same-source baseline
treatment.

## 2026-04-28: Production deploy blocked by duplicate billing migration

### Impact

The `Deploy Web` workflow failed before `docker stack deploy`, so production did
not roll forward to image `sha-245e71a`.

### Evidence That Mattered

GitHub Actions run `25065442578`, job `73431274787`, failed in `Run migrations`.
The first fatal migration line was:

```text
error: [migrate] error: relation "user_billing_stripe_customer_idx" already exists
```

The log showed `0002_add_user_billing.sql` being retried while earlier deploys
had already applied the same billing table/index shape through
`0004_add_user_billing.sql`.

### Root Cause

Concurrent migration numbering left two billing migrations in the history.
Production had already created the billing indexes from `0004_add_user_billing.sql`,
then later saw `0002_add_user_billing.sql` as pending and failed because its
index creation statements were not idempotent.

### Fix or Mitigation

Changed `drizzle/0002_add_user_billing.sql` to use
`CREATE INDEX IF NOT EXISTS` for the two billing indexes, matching the already
idempotent `0004_add_user_billing.sql`. Added an integration test that applies
the pending `0002_add_user_billing.sql` against a database where the billing
indexes already exist.

### Remaining Risk

The failed job log also appeared to print Infisical-exported environment values
in plain text. Those credentials should be treated as exposed until the relevant
secrets are rotated and the deploy workflow masks or avoids logging exported
secrets.

## 2026-04-28: Redis bind-mount deploy rollback gap and secret log exposure

### Impact

The `Deploy Web` workflow run `25067751341` stalled in `Deploy stack` and was
cancelled after the stack rollout could not converge. Production Redis stayed at
`0/1`, web tasks crash-looped because Redis DNS was unavailable, and the job log
exposed Infisical-exported environment values during later step cleanup output.

### Evidence That Mattered

The first fatal Swarm task error was:

```text
invalid mount config for type "bind": bind source path does not exist: /mnt/dofek-data/redis
```

`dofek_web` reported `rollback_completed`, but `dofek_redis` reported
`update paused due to failure or early termination of task ...` and retained the
new bind mount spec. Terraform in the same run printed `No changes` and
`Resources: 0 added, 0 changed, 0 destroyed`, proving the updated directory
creation command did not execute on the existing server.

### Root Cause

Commit `04756404` moved Redis persistence from a Docker named volume to
`/mnt/dofek-data/redis`, but the existing
`terraform_data.data_volume_mount_alias` trigger was not changed, so Terraform
did not rerun the remote provisioner that creates that directory. The Redis
service also lacked `deploy.update_config.failure_action: rollback`, so Swarm
paused the failed Redis update instead of reverting it. Separately, the deploy
workflow appended the entire Infisical dotenv file to `GITHUB_ENV`, causing
GitHub Actions to print Infisical-only secrets in later step environment blocks.

### Fix or Mitigation

- Bumped the production and staging Terraform mount-alias triggers so directory
  creation and legacy Redis volume copy run on existing servers.
- Added a pre-deploy host bind-mount path validation step before any
  `docker stack deploy`.
- Added Redis `failure_action: rollback` so a failed Redis service update reverts
  instead of pausing on the broken spec.
- Stopped appending the Infisical dotenv file to `GITHUB_ENV`; stack deploy now
  runs through a temporary Node helper that injects the dotenv values only into
  the child `docker stack deploy` process.
- Added masking for every rendered Infisical dotenv value immediately after
  export.
- Deleted GitHub Actions logs for the unsafe runs `25067751341` and
  `25069173318` after capturing the incident evidence.

### Remaining Risk

The values already printed in the unsafe deploy logs should still be rotated;
log deletion reduces exposure but does not prove the values were never read.
Future deploys should fail before stack mutation if a required host bind path is
missing.

## 2026-04-28: Image Vulnerability Scan Grype installer failure

### Impact

PR #1059 failed the `Test / Image Vulnerability Scan` CI job before the image
vulnerability scan could run. The server image build completed, but the security
gate was blocked by scanner installation.

### Evidence That Mattered

The failing step was `Scan server image (Grype)`. The first fatal log lines were:

```text
[error] received HTTP status=502 for url='https://github.com/anchore/grype/releases/download/v0.97.1/grype_0.97.1_linux_amd64.tar.gz'
[error] hash_sha256_verify checksum for '/tmp/tmp.eLZxdHctKO/grype_0.97.1_linux_amd64.tar.gz' did not verify
```

The log then showed `gzip: stdin: not in gzip format`, `tar: Error is not
recoverable`, and `Error installing grype`, proving the job failed while
installing the scanner, not because Grype found a critical vulnerability.

### Root Cause

The workflow used `anchore/scan-action`, whose pinned action version installs
its default Grype binary (`v0.97.1`) from a GitHub release asset on each fresh
runner. GitHub returned a 502 body for the tarball URL, so the installer
downloaded non-tarball content and failed checksum verification before scanning
the Docker image.

### Fix or Mitigation

The image scan now runs Grype through the official `anchore/grype:v0.111.1`
container image pinned by manifest digest. CI pulls that scanner image with a
bounded retry, then runs the same policy against `e2e-server:latest`:
`--only-fixed --fail-on critical`.

### Remaining Risk

The scanner still needs registry and vulnerability database access at runtime.
The removed failure mode was the un-cached GitHub release tarball installer in
the action step.

## 2026-04-28: Materialized view definition-change deploy gate

### Impact

A deploy could not proceed after the planner reported required materialized-view
maintenance for `fitness.provider_stats`. App serving was protected because the
deploy failed before attempting an automatic full-history rebuild under traffic.

### Evidence That Mattered

The deploy emitted:

```text
Materialized view maintenance is required but automatic view sync is disabled:
view_definition_changed:fitness.provider_stats:b65eca7aff54a516a141c7ed496c2415ec39b07fde249e9fa4272cc9c760a795
```

That reason maps to an existing materialized view whose canonical SQL changed.
The normal `sync` command intentionally refuses to drop and recreate such a view
without an explicit maintenance action.

### Root Cause

The canonical `fitness.provider_stats` materialized-view definition changed, but
the available operator path required rerunning deploy with the correct manual
input or hand-running the container command. There was no dedicated GitHub
Actions button for the safe explicit rebuild path.

### Fix or Mitigation

Added an explicit `rebuild <view>` maintenance command and a manual
`Materialized View Maintenance` GitHub Action. The action defaults to rebuilding
`fitness.provider_stats`, runs the quiet-DB preflight, rebuilds the selected
canonical view, runs normal blocking sync, and verifies the planner reports
`required=false`.

### Remaining Risk

Rebuilding a materialized view is still heavy database maintenance. Operators
should run it during a planned maintenance window and stop if preflight reports
recovery mode, active lock waits, or other full-history maintenance.

## 2026-04-28: Manual materialized-view maintenance blocked by post-sync refresh

### Impact

A manually requested deploy with `refresh_materialized_views=true` failed after
the swarm rollout completed. The app stayed up, but the required blocking
materialized-view maintenance did not run.

### Evidence That Mattered

The failing step was `Run blocking materialized view maintenance`, and the first
fatal line was:

```text
Error: quiet database preflight failed: 1 lock wait is active
```

Production Postgres activity at the same time showed two active statements for
the same view:

```text
REFRESH MATERIALIZED VIEW CONCURRENTLY fitness.deduped_sensor
REFRESH MATERIALIZED VIEW CONCURRENTLY fitness.deduped_sensor
```

One session was actively refreshing and the other was waiting on a relation
lock.

### Root Cause

Worker post-sync maintenance was already refreshing materialized views while the
manual maintenance action started. The manual maintenance preflight correctly
refused to begin while an overlapping refresh was waiting on a lock.

### Fix or Mitigation

The manual maintenance workflow now cancels in-progress
`REFRESH MATERIALIZED VIEW` statements for the selected view before running the
quiet database preflight and destructive rebuild.

### Remaining Risk

The maintenance workflow only cancels refreshes for the target view. Other
active database work can still make the quiet preflight fail, which is
intentional for planned maintenance.

## 2026-04-28: Branch verification rebuild failed in post-rebuild sync

### Impact

A manual `Materialized View Maintenance` workflow run from branch
`Asherlc/cancel-view-refreshes` rebuilt `fitness.provider_stats` successfully
from the PR image, but the workflow still failed before the final planner
verification. The rebuild did not run for an hour; the rebuild command reported
about 70 seconds of database work.

### Evidence That Mattered

The first attempt used `image_tag=pr-1064` before the review-app image tag was
available and failed in `Pull maintenance images`:

```text
Error response from daemon: failed to resolve reference "ghcr.io/asherlc/dofek:pr-1064": ghcr.io/asherlc/dofek:pr-1064: not found
```

After the image tag existed, the rerun reached the changed path and completed
the target rebuild:

```text
rebuilt=fitness.provider_stats mode=rebuild duration_ms=70132
```

A follow-up run after the workflow was split into separate cancellation and
rebuild steps showed both target steps passing independently:

```text
canceling_refreshes=fitness.provider_stats
canceled_refreshes=fitness.provider_stats
rebuilt=fitness.provider_stats mode=rebuild duration_ms=105478
```

The first fatal line was in `Run post-rebuild materialized view sync`:

```text
Error: Materialized view maintenance required: fitness.v_activity (live definition differs from canonical definition), fitness.v_sleep (live definition differs from canonical definition), fitness.v_body_measurement (live definition differs from canonical definition), fitness.v_daily_metrics (live definition differs from canonical definition), fitness.deduped_sensor (live definition differs from canonical definition), fitness.activity_summary (live definition differs from canonical definition), fitness.provider_stats (live definition differs from canonical definition)
```

### Root Cause

The branch verification exercised the target-refresh cancellation path and
rebuild path, including the later split into separate workflow steps, but
production still reported live-definition drift for every canonical
materialized view during the existing post-rebuild sync step. Follow-up
investigation found that `syncMaterializedViews()` treated PostgreSQL's
`pg_get_viewdef()` output as a second source of truth even when the stored
canonical SQL hash and dependency fingerprint matched. That PostgreSQL-rendered
definition comparison produced false drift for tracked, hash-clean production
views.

### Fix or Mitigation

`syncMaterializedViews()` now treats the stored canonical SQL hash plus
dependency fingerprint as authoritative for already-tracked views. It still
requires manual maintenance when the stored hash changes, when the dependency
fingerprint changes, or when a tracked view is missing and must be recreated.
Live definition comparison remains limited to adopting untracked existing
views.

### Remaining Risk

The manual action can still fail after a successful target rebuild when a stored
canonical hash or dependency fingerprint genuinely changes. Operators should not
interpret a successful target rebuild as proof that no other view needs explicit
maintenance; the final planner verification remains the source of truth.

## 2026-04-28: Manual view maintenance verification was too indirect

### Impact

The manual `Materialized View Maintenance` workflow could end with
`synced=0 skipped=7 refreshed=0`, which only proved the post-rebuild sync had no
remaining view work. That was not meaningful evidence that the selected target
view had actually been rebuilt during the workflow.

### Evidence That Mattered

The weak verification output was:

```text
warning=1 long-running maintenance-like query is active
synced=0 skipped=7 refreshed=0
```

### Root Cause

The final evidence came from the global post-rebuild sync step, not from the
target rebuild step. The workflow also depended on pulling Docker images even
though the production database is reachable through a private SSH tunnel to the
server's loopback-only Postgres port.

### Fix or Mitigation

The manual workflow now runs the checked-out branch directly with `pnpm tsx`
over an SSH tunnel instead of pulling Docker images. It also adds target-specific
verification steps: one checks for `rebuilt=<view> mode=rebuild` in the rebuild
output, and another confirms the target materialized view exists and is
populated after the rebuild. A follow-up change simplifies dispatch to a single
`environment` choice (`production` or `staging`) and derives the matching
Infisical environment plus SSH tunnel target internally.

### Remaining Risk

The target populated check proves the rebuilt view exists and is usable, but it
does not prove query-level correctness for the view contents. The final planner
check still verifies that no canonical materialized-view maintenance remains.
Staging dispatch is wired through the same workflow field, but a branch
verification run found the staging Infisical environment currently exports no
`POSTGRES_PASSWORD` and the staging host has no running `dofek-staging` services.
Staging maintenance will fail loudly until the staging stack and secrets are
provisioned.
