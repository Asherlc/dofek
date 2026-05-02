# Production Incident Baseline

<!-- cspell:ignore Hetzner Hypertables rollups fanout Checkpointed subcheck MISCONF docuum anchore -->

This document summarizes production failure modes observed so far. It is not a
full incident log or a replacement for runbooks. Use it to build shared memory
about the kinds of issues this system encounters, the signals that identified
them, and the durability work they suggest.

## 2026-04-29: PR 1075 CI Blocked by ClickHouse Bootstrap and Web E2E Drift

### Impact

PR #1075 could not merge because CI failed in the database migration and web E2E
jobs.

### What Happened

The branch introduced ClickHouse-backed activity read models and a new
`metric_stream` replica identity requirement. CI initially failed while
bootstrapping the ClickHouse PostgreSQL bridge for activity views, and the web
E2E suite separately failed because Cypress seeded rows with UTC calendar dates
while the app queried local dates and reused stale per-user query-cache state
between tests.

### Evidence That Mattered

- ClickHouse fatal line:
  `Table postgres_fitness.metric_stream has no primary key and no replica identity index`
- ClickHouse bridge failure came from using the `fitness` schema bridge for
  activity membership data instead of a dedicated scalar-only `clickhouse`
  schema/view bridge.
- Web E2E failure symptoms:
  - nutrition queries returned zero rows for a seeded "today" date
  - dashboard chart tests fell back to `No data available`
  - Cypress cleanup hit `food_entry_provider_id_provider_id_fk`
  - cached empty query results survived between tests

### Root Cause

Two separate root causes blocked CI:

- `fitness.metric_stream` lacked a replica-safe primary key / replica identity
  for ClickHouse `MaterializedPostgreSQL`.
- Cypress test setup was not aligned with the app's local-date semantics and
  did not fully clear dependent data plus server query cache between tests.

### Fix Or Mitigation

- Added an `id` column plus composite primary key `(id, recorded_at)` for
  `fitness.metric_stream`, set replica identity to that key, and updated the
  ClickHouse bridge to read from `clickhouse.v_activity` and
  `clickhouse.v_activity_members`.
- Synced Postgres materialized views before ClickHouse migrations.
- Switched Cypress seeds to local-date formatting, expanded cleanup to remove
  dependent rows and `user_settings`, invalidated the per-user query cache, and
  made the dashboard assertion verify the rendered section rather than a brittle
  canvas selector.

### Remaining Risk (native backfill and CDC transition)

Any future date-sensitive E2E seeds that use UTC string slicing can still drift
 around local-midnight boundaries, and any new cached server query path added to
 Cypress fixtures needs explicit invalidation or isolated cache keys.

## 2026-04-29: PR 1075 Stryker Failed on metric_stream PK Migration

### Impact

PR #1075 remained blocked after the review-comment patch because the `Test /
Stryker (0)` job could not finish database setup.

### What Happened

The new `metric_stream` replica-identity migration tried to validate a temporary
`CHECK (id IS NOT NULL)` constraint on a Timescale hypertable that already had
columnstore enabled.

### Evidence That Mattered

- Failing job: `Test / Stryker (0)`
- First fatal line:
  `ERROR: operation not supported on hypertables that have columnstore enabled`
- Failing SQL:
  `ALTER TABLE fitness.metric_stream VALIDATE CONSTRAINT metric_stream_id_not_null_chk;`

### Root Cause

The migration used a PostgreSQL-style staged `NOT NULL` rollout that Timescale
does not allow once columnstore is enabled on the hypertable.

### Fix Or Mitigation

The migration now keeps the supported steps only: add nullable `id`, set the
UUID default, backfill existing rows, add the composite primary key directly,
and then set replica identity to that key. A focused integration test now
covers that exact columnstore-enabled path.

### Remaining Risk

Future schema changes on `fitness.metric_stream` still need Timescale-specific
validation. Standard PostgreSQL `VALIDATE CONSTRAINT` / staged `SET NOT NULL`
patterns are not safe assumptions once columnstore is enabled.

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

## 2026-04-28: Manual view maintenance inputs were over-condensed

### Impact

The manual `Materialized View Maintenance` workflow correctly condensed
environment selection to `production` or `staging`, but the initial follow-up
risked making target selection too narrow for operators who need to rebuild more
than one materialized view in one maintenance window.

### Evidence That Mattered

The workflow had a single-select target input:

```text
view_name=fitness.provider_stats
```

That preserved choosing one target, but not choosing multiple target views.

### Root Cause

GitHub Actions `choice` inputs are single-select. Keeping target selection as a
choice field made the UI simple but did not represent the operational need to
select one or more canonical materialized views.

### Fix or Mitigation

The workflow now keeps one environment selector and uses a `view_names` string
input for targets. Operators can provide one view name, comma-separated view
names, newline-separated view names, or `all`. The workflow resolves that input
against the canonical inventory, preserves dependency order, cancels refreshes
for each target, rebuilds each target one at a time, and verifies every selected
view was rebuilt and populated.

### Remaining Risk

The `view_names` field is free text because workflow dispatch does not support a
multi-select choice input. Invalid names fail before database maintenance starts,
and the runbook lists the accepted format.

## 2026-04-29: Direct admin user URLs returned Express 404

### Impact

Direct navigation to web admin user detail pages, such as
`/admin/users/f923fed7-d934-4cd9-8cb9-8e83020d0e69`, did not load the app.
Users already inside the single-page app could still navigate through client-side
routes, but hard refreshes and copied links failed.

### Evidence That Mattered

The production response for the direct URL was:

```text
HTTP/2 404
Cannot GET /admin/users/f923fed7-d934-4cd9-8cb9-8e83020d0e69
```

The new regression test reproduced the same failure locally before the fix:

```text
expected 404 to be 200
```

### Root Cause

The Express single-page app fallback excluded every `/admin/` path so that the
server-owned Bull Board route at `/admin/queues` would not be served by the web
app. That exclusion was broader than the actual server route and blocked web app
routes under `/admin/users/...`.

### Fix or Mitigation

The fallback now excludes only `/admin/queues`, leaving other `/admin/...` paths
to receive `index.html` and load TanStack Router. Server tests now cover both the
admin user route fallback and the existing `/admin/queues` middleware behavior.

### Remaining Risk

The fix is covered by server unit tests. Production still needs the normal web
deploy before the live URL changes from 404 to the app shell.

## 2026-04-29: iOS AI meal input surfaced raw JSON parse errors

### Impact

iOS users could see a low-level AI structured-output error such as "bad JSON
character" or "No object generated" when the AI meal parser could not turn the
input into valid food items.

### Evidence That Mattered

Production Axiom traces showed recent `food.analyzeItemsWithAi` traffic reaching
Gemini, with intermittent Gemini `503` responses followed by successful retries.
Sentry had no matching mobile error events. A local call to
`analyzeNutritionItems("p", ...)` reproduced the server-side structured-output
failure:

```text
AI_NoObjectGeneratedError: No object generated: response did not match schema.
```

### Root Cause

The `food.analyzeItemsWithAi` router passed AI SDK structured-output parse and
validation failures straight through to the client, so the iOS screen rendered a
provider/parser implementation detail instead of an actionable user message.

### Fix or Mitigation

The router now maps AI structured-output failures to a `BAD_REQUEST` tRPC error
with the message `Describe the foods and amounts you want to log.` Other
unexpected errors still propagate and are reported by the existing tRPC error
handler.

### Remaining Risk

This improves the user-facing failure mode but does not add deeper provider
telemetry for malformed AI responses. If structured-output failures become
frequent for well-formed meal descriptions, add provider/output diagnostics that
do not record raw food text.

## 2026-04-29: Staging deploy blocked by empty Infisical environment

### Impact

The `Deploy Web` workflow could not complete for staging. Production deploys
were unaffected, but staging could not be bootstrapped from CI until required
secrets and maintenance state were repaired.

### Evidence That Mattered

Run `25114876237`, job `73599120397`, failed in
`Bootstrap stack (if DB service is missing)` with:

```text
required variable PGADMIN_DEFAULT_EMAIL is missing a value
```

The staging Infisical template export rendered zero non-empty variables, while
the production export rendered 56. The staging host also had an empty Postgres
data directory with no `PG_VERSION`, so generating a new staging-only
`POSTGRES_PASSWORD` was safe.

A later rerun reached stack deploy and migrations, then the OTA service logged:

```text
EXPO_APP_ID not set
```

After secrets were present, the planner reported required materialized-view
maintenance for all seven canonical views because the newly bootstrapped staging
database had no acknowledged canonical view fingerprints.

### Root Cause

The `staging` Infisical environment was effectively empty. Stack interpolation
failed on required deploy secrets first, then OTA startup failed on
`EXPO_APP_ID`, and finally the fresh staging database needed the normal blocking
materialized-view sync before the deploy gate could pass.

The public staging app URL also exposed a separate DNS issue: Cloudflare was
proxying `staging.dofek.asherlc.com`, but the edge TLS certificate did not cover
that second-level hostname, so HTTPS failed before reaching Traefik.

### Fix or Mitigation

Populated staging Infisical with generated staging-safe secrets, copied the
shared infrastructure credentials that the existing stack requires, added
`EXPO_APP_ID`, and reran staging deploy with
`refresh_materialized_views=true`. Run `25116944316` completed successfully,
including Terraform apply, stack deploy, migrations, and blocking
materialized-view maintenance.

Changed the Terraform-managed `staging.dofek.asherlc.com` record to DNS-only so
Traefik serves the origin Let's Encrypt certificate directly.

### Remaining Risk

Staging still does not have Stripe test keys or provider OAuth credentials unless
they are added intentionally. Add fail-fast deploy validation for OTA-only
runtime requirements such as `EXPO_APP_ID`, and document the minimum staging
Infisical secret checklist.

## 2026-04-29: Review app deploy failed on Docker SSH transport

### Impact

PR #1073 had otherwise green CI, but `Deploy Review App` failed before the
review stack could start. The application image built successfully and the
dedicated review server was created.

### Evidence That Mattered

Run `25117699121`, job `73610459050`, failed in `Deploy review stack` with:

```text
Connection timed out during banner exchange
Connection to 116.203.81.197 port 22 timed out
```

The previous `Wait for review server bootstrap` step had succeeded, and later
SSH inspection showed `ssh` and `docker` active on `dofek-pr-1073`. `docker
version` over `DOCKER_HOST=ssh://root@116.203.81.197` also succeeded once the
host key was trusted locally.

### Root Cause

The readiness gate only proved a normal SSH session that ran `docker info`
inside the host. The failing deploy command used Docker's SSH transport, which
can fail separately while a freshly provisioned review server is still settling.

### Fix or Mitigation

The review-app bootstrap gate now also verifies `DOCKER_HOST=ssh://root@...`
with `docker version` before the workflow starts `docker compose`.

### Remaining Risk

This moves Docker SSH transport readiness into the existing 300-second bootstrap
gate. If future review-app failures occur after that gate passes, inspect the
first fatal line before adding broader retries.
## 2026-04-29: Admin user URL rendered admin overview instead of detail

### Impact

After the Express 404 fix deployed, direct navigation to
`/admin/users/f923fed7-d934-4cd9-8cb9-8e83020d0e69` returned the single-page app
shell but still did not show the user detail page. Admins remained on the admin
overview content even though the URL matched the nested user detail route.

### Evidence That Mattered

Production returned the app shell successfully:

```text
HTTP/2 200
cache-control: no-cache
```

The focused router regression test reproduced the remaining client-side failure:

```text
Unable to find an element with the text: Billing.
```

The rendered DOM showed the admin overview page and tab bar, not the user detail
page.

### Root Cause

The TanStack Router `/admin/users/$userId` route was nested under `/admin`, but
the lazy `/admin` route rendered `AdminPage` directly and did not render an
`<Outlet />`. The child route matched, but React never mounted the user detail
component.

### Fix or Mitigation

The `/admin` route is now a parent layout that renders `<Outlet />`, and the
admin dashboard moved to the `/admin/` index child route. A router regression
test now renders `/admin/users/:userId` through the generated route tree and
asserts that the user detail page appears.

### Remaining Risk

The fix is covered by route and page unit tests. Production needs a web deploy
containing the route tree update before the live admin user URL renders the
detail page.

## 2026-04-29: Review app workflow and Stryker failed on stale shell/test assumptions

### Impact

PR `#1075` had two failing CI paths: `Deploy Review App` exited before writing
review app overrides, and `Test / Stryker (1)` repeatedly errored during the
trends integration test setup. The umbrella `Test / Mutation Testing` job then
failed because the Stryker shard failed.

### Evidence That Mattered

Review app fatal lines:

```text
warning: here-document at line 4 delimited by end-of-file (wanted `EOF')
unexpected EOF while looking for matching `)'
```

Stryker fatal DB line:

```text
ERROR: relation "cagg_metric_daily" is not a continuous aggregate
STATEMENT: CALL refresh_continuous_aggregate('fitness.cagg_metric_daily', NULL, NULL)
```

### Root Cause

The review-app workflow generated encoded database URLs with a Node heredoc
whose closing `EOF` was indented inside the YAML `run` block, so Bash never saw
the terminator. Separately, `packages/server/src/routers/trends-data.integration.test.ts`
still assumed `fitness.cagg_metric_daily` and `fitness.cagg_metric_weekly` were
continuous aggregates even though the baseline schema defines them as plain
views.

### Fix or Mitigation

The workflow now uses `node --eval` instead of a heredoc to derive encoded
`DATABASE_URL` and `CLICKHOUSE_URL` values. The trends integration test no
longer calls `refresh_continuous_aggregate()` for those relations and instead
documents that the baseline test schema exposes the inserted rows through views
immediately.

### Remaining Risk

The fixes are covered by a direct shell probe of the workflow snippet, the
targeted trends integration test, and full local changed-test coverage. If a
future review-app failure mentions shell parsing again, inspect the rendered
`run` script first; if a future trends test failure mentions continuous
aggregates, verify the schema object type before adding refresh logic.

## 2026-04-29: Review app readiness probe and Stryker shard failed on uncovered guard branches

### Impact

PR `#1075` still had two failing CI paths after the previous fixes:
`Deploy Review App` timed out waiting for ClickHouse, and `Test / Stryker (1)`
failed the mutation threshold. The umbrella `Test / Mutation Testing` job then
failed because that shard failed.

### Evidence That Mattered

Review app fatal lines:

```text
wget: can't connect to remote host: Connection refused
##[error]Review app ClickHouse did not become ready within 180s
```

Local repro inside the review ClickHouse container:

```text
wget -qO- http://127.0.0.1:8123/ping  # Ok.
wget -qO- http://localhost:8123/ping   # Connection refused
getent hosts localhost                 # ::1 localhost localhost
```

Stryker fatal line from the local shard repro of the exact CI file set:

```text
Final mutation score 73.74 under breaking threshold 75
```

The surviving mutants were concentrated in:
`packages/server/src/routers/duration-curves.ts`,
`packages/server/src/routers/power.ts`,
`packages/server/src/trpc.ts`, and `src/db/run-migrate.ts`.

### Root Cause

The review-app workflow probed ClickHouse with `http://localhost:8123/ping`
inside the container. In that image, `localhost` resolved to IPv6 `::1`, while
ClickHouse was listening on IPv4; the compose healthcheck already used
`127.0.0.1`, which is why the container was healthy but the workflow probe
timed out.

Separately, the Stryker shard was not crashing; it was correctly reporting
surviving mutants because recently added ClickHouse-required branches and tRPC
metrics/logging paths did not have sufficiently specific tests.

### Fix or Mitigation

The workflow probe now uses `http://127.0.0.1:8123/ping` to match the container
healthcheck and the actual listening socket.

Targeted tests now cover:

- missing `sensorStore` preconditions in duration-curve and power routers
- admin middleware propagation of `accessWindow`
- cache-hit duration metrics and slow-query logging in `trpc`
- `run-migrate` early `CLICKHOUSE_URL` failure and optional ClickHouse client
  shutdown

The exact local Stryker shard rerun for the CI file set finished at a mutation
score of `94.95`, above the break threshold of `75`.

### Remaining Risk

The direct-run footer in `src/db/run-migrate.ts` is still uncovered by Stryker,
but it no longer affects the threshold for this shard. If a future review-app
ClickHouse check fails again, inspect name resolution inside the container
before changing waits or retries.

## 2026-04-30: Cypress E2E CI job hung until GitHub Actions cancelled it

### Impact

PR `#1075` still had a failing CI path even after the review-app and Stryker
fixes. `Test / E2E Tests (Web)` never exited from `pnpm e2e:web:run`, so the
job sat for about six hours until GitHub Actions cancelled it. The gate jobs
then failed because they depend on that E2E job.

### Evidence That Mattered

The failing job completed every setup step and then remained in the Cypress run
step for the rest of the job lifetime:

```text
Run pnpm e2e:web:run
...
completedAt: 2026-04-30T09:54:34Z
conclusion: cancelled
```

The local full E2E suite reproduced the relevant behavior boundary:

```text
pnpm e2e:web:run
7 specs passed
process exited cleanly
```

The only Cypress plugin path that touched the shared query cache was in
`cypress.config.ts`:

```ts
await queryCache.invalidateByPrefix(`${userId}:`);
```

That plugin process did not run with `NODE_ENV=test` or
`DISABLE_QUERY_CACHE=true`, while the server container already had
`DISABLE_QUERY_CACHE: "true"` in `docker-compose.e2e.yml`.

### Root Cause

The Cypress host-side plugin imported the shared cache singleton and used it in
the `cleanTestData` task solely to invalidate query-cache keys. In the E2E job,
that plugin process did not get the test/cache-disabling environment that the
server container gets, so it could take the Redis-backed cache path and keep a
host-side handle open. That kept `cypress run` from exiting even after specs
finished.

### Fix or Mitigation

Removed the plugin-side `queryCache` import and cache invalidation call from
`cypress.config.ts`. The E2E server already disables the query cache in the
compose stack, so the plugin-side invalidation was redundant.

Validated with:

- `pnpm exec cypress run --spec cypress/e2e/login.cy.ts`
- `pnpm e2e:web:run`
- `TEST_DATABASE_URL=postgres://health:health@127.0.0.1:5435/health REDIS_URL=redis://127.0.0.1:6379 pnpm test:changed`

### Remaining Risk

If a future Cypress job hangs after specs appear to finish, inspect host-side
plugin imports for long-lived clients or timers before changing timeouts or
adding explicit process exits.

## 2026-04-30: Web deploy failed on missing ClickHouse bind-mount path

### Impact

The `Deploy Web` workflow for commit `7af8b2f972c09cc998efe62eaced0e8817f85dd7`
failed for both production and staging before stack deployment. The app rollout
did not proceed.

### Evidence That Mattered

Terraform ran first and reported no infrastructure changes:

```text
No changes. Your infrastructure matches the configuration.
Apply complete! Resources: 0 added, 0 changed, 0 destroyed.
```

Both deploy-stack jobs then failed in `Validate host bind mount paths`:

```text
Required host bind mount path is missing: /mnt/dofek-data/clickhouse
Process completed with exit code 1.
```

The ClickHouse rollout commit added `/mnt/dofek-data/clickhouse` to the
Terraform `mkdir -p` command, but did not bump the
`terraform_data.*data_volume_mount_alias` replacement triggers in the same
commit.

### Root Cause

The ClickHouse host bind-mount directory was added to the Terraform
remote-exec provisioner without replacing the existing `terraform_data`
resources. Terraform provisioners only rerun on resource creation/replacement,
so Terraform considered the resources current and did not create the new
directory on either host.

### Fix or Mitigation

Bumped the production and staging data-volume mount-alias trigger strings so
the next Terraform apply replaces those `terraform_data` resources and reruns
the existing provisioners that create `/mnt/dofek-data/clickhouse`.

The rerun then exposed a second missing prerequisite: `CLICKHOUSE_PASSWORD` was
absent from both Infisical environments, so `docker stack config` failed while
interpolating ClickHouse environment variables. Added `CLICKHOUSE_PASSWORD` to
both `prod` and `staging` in Infisical.

The next rerun reached the migration step and showed that the workflow encoded
`CLICKHOUSE_PASSWORD` from the runner process environment instead of the
rendered Infisical dotenv file. Updated the migration step to run that encoding
through the existing dotenv command runner.

A later rerun reached the migration container and then appeared stuck. Production
Postgres showed one migration session holding advisory lock `728370291` while
running:

```sql
UPDATE fitness.metric_stream
SET id = gen_random_uuid()
WHERE id IS NULL;
```

The table was a compressed Timescale hypertable with 195 chunks, 189 compressed
chunks, and about 37 GB of chunk data. Later workflow retries were not applying
migrations; they were blocked on the same advisory lock. Because the workflow
wrapped `docker run` with the runner-side `timeout` while using remote Docker
over SSH, each timeout killed the local Docker client but left the remote
migration container running.

Updated the migration step to run one named migration container with explicit
cleanup of that remote container on failure or timeout. The first cleanup fix
still depended on the runner-side `timeout docker run` regaining control over
SSH, which did not happen reliably. The workflow now also runs BusyBox
`timeout` inside the remote container, so the migration process exits from the
server side even if the runner-side Docker client hangs. The longer timeout is
intentionally scoped to migrations because this release contains a one-time
37 GB compressed-hypertable backfill; the named-container cleanup prevents
future runner-side timeouts from leaking remote migration processes.

The next retry showed that even with the server-side timeout, a long attached
`docker run` over SSH can fail with:

```text
client_loop: send disconnect: Broken pipe
error waiting for container
```

Updated the migration step again to start the migration container detached,
then poll `docker inspect` with short SSH calls and collect `docker logs` after
the container exits. This keeps the release job from depending on one long-lived
SSH stream while the database is doing a multi-minute table rewrite.

Staging also failed after Postgres migrations and materialized-view sync because
ClickHouse exceeded the service's 1 GB memory limit while applying the
ClickHouse migrations:

```text
(total) memory limit exceeded ... current RSS: 966.99 MiB, maximum: 921.60 MiB
```

Raised the ClickHouse service memory limit to 2 GB so the ClickHouse migration
has enough memory to create the Postgres bridge and analytics read models.
Because migrations run before the normal `docker stack deploy`, the workflow
also applies that ClickHouse memory limit with `docker service update` before
running migrations, then waits for ClickHouse to become reachable again. The
stack file remains the desired-state source of truth; the pre-migration service
update makes the needed resource limit effective before the migration that
requires it.

Production then showed the heavy Postgres statement disappear from
`pg_stat_activity` while the migration Node process stayed alive with no active
Postgres or ClickHouse query and an external HTTPS connection from the
instrumented entrypoint. Updated the deploy migration command to run
`src/db/run-migrate.ts` directly with Node's TypeScript support, without the
OpenTelemetry instrumentation imports used by the long-running app entrypoint.
The deploy step still captures container logs, but the one-shot migration no
longer depends on telemetry export shutdown behavior to finish the release.

That did not resolve the production migration. A direct non-instrumented Node
run still lost the active backend after the `UPDATE fitness.metric_stream ...`
statement, and a follow-up count showed `187,684,929` rows still had `id IS
NULL`. The workflow-only retry strategy is therefore blocked: production needs
an explicit decision on how to complete `0007_metric_stream_primary_key.sql`
without relying on the current Node migration runner to perform the 37 GB
compressed-hypertable rewrite in one statement.

### Remaining Risk

This fixes the missed ClickHouse provisioning run, the missing ClickHouse
secret, the migration-step dotenv mismatch, the remote migration-container leak,
the long-lived SSH session failure mode, and the ClickHouse memory ceiling seen
on staging. Production deployment remains unresolved because
`0007_metric_stream_primary_key.sql` cannot currently complete the
`metric_stream` UUID backfill through the Node migration runner. Future changes
to the `/mnt/dofek-data` directory list still require a corresponding trigger
bump in the same commit. Future stack-level environment variables must be added
to Infisical before the workflow that references them is merged or deployed, and
workflow steps must read Infisical-only secrets from the rendered dotenv file
rather than from the runner environment. Large compressed hypertable backfills
should be called out in deploy planning so the migration timeout is intentional
rather than discovered during release.

## 2026-04-30: Metric Stream Primary Key Backfill Split Into Chunk Batches

### Symptoms

Production deploy remained blocked in the schema migration step after the
earlier ClickHouse bind-mount and migration-runner fixes. The pending migration
was still `0007_metric_stream_primary_key.sql`.

### User Impact

Production could not advance to the new stack image because migrations run
before `docker stack deploy`. Staging had already moved past this point, but
production remained on the previous release.

### Evidence

Production catalog checks showed `fitness.metric_stream` still had no primary
key, and `187,684,929` rows still had `id IS NULL`. The failed migration path
was the single full-history statement:

```sql
UPDATE fitness.metric_stream
SET id = gen_random_uuid()
WHERE id IS NULL;
```

The table was a compressed Timescale hypertable, so this one statement attempted
to rewrite the historical compressed workload as one unbounded operation.

### Root Cause

`0007_metric_stream_primary_key.sql` used a single full-table UUID backfill for
a large compressed hypertable. The migration runner executed each migration
statement separately, but the backfill itself was still one unbounded statement,
so production could not complete the migration reliably.

### Fix or Mitigation

Replaced the full-table backfill statement in `0007_metric_stream_primary_key.sql`
with a migration-runner marker that performs the `metric_stream.id` backfill in
bounded batches of `100,000` rows per Timescale chunk time range. Each batch is
its own Postgres query, so progress commits incrementally before the migration
adds the composite primary key `(id, recorded_at)` and switches replica identity
to that key.

### Remaining Risk

The production rerun still has to build the primary-key index after the ID
backfill completes, and that operation may take time on the 187M-row hypertable.
If that becomes the next blocker, investigate it separately rather than adding
generic deploy retries.

### Follow-up Evidence

The first production rerun with the bounded backfill image built and pushed both
`sha-d68d1a7` images, passed Terraform and image pulls, then failed immediately
in the migration container with:

```text
error: transparent decompression only supports tableoid system column
```

That error came from using `ctid` to identify a limited set of rows inside
compressed Timescale chunks. Timescale transparent decompression does not expose
`ctid`; only `tableoid` is available as a system column in that path.

### Follow-up Fix

Changed the metric_stream ID backfill again to avoid system columns entirely.
The runner now updates `metric_stream.id` by one-hour `recorded_at` windows
within each Timescale chunk time range:

```sql
UPDATE fitness.metric_stream AS metric_stream
SET id = gen_random_uuid()
WHERE metric_stream.id IS NULL
  AND metric_stream.recorded_at >= $1
  AND metric_stream.recorded_at < $2;
```

This preserves bounded progress without relying on unsupported compressed-chunk
system columns.

### Second Follow-up Evidence

The production rerun with one-hour windows was correct but still too
under-batched for the deploy window. Production had `195` Timescale chunks for
`fitness.metric_stream`, which meant up to `32,760` hourly update statements
before the migration could add the primary key. After roughly twenty minutes the
container had only completed a small subset of chunks, so the run was cancelled
before the workflow timeout killed it.

### Second Follow-up Fix

Changed the marker handler to issue one bounded update per Timescale chunk range
instead of one update per hour inside each chunk. The statement still filters by
`id IS NULL` and `recorded_at >= $1 AND recorded_at < $2`, so already completed
chunks from prior attempts remain committed and the migration is still
resumable.

### Third Follow-up Evidence

The first chunk-range production rerun got past the already-backfilled chunks
quickly, then failed on the next compressed chunk with:

```text
error: tuple decompression limit exceeded by operation
```

That showed a full chunk-range update can exceed TimescaleDB's per-DML
decompression limit on chunks that still contain too many `id IS NULL` rows.

### Third Follow-up Fix

Kept the chunk-range update as the fast path for already-complete and smaller
chunks, but added a targeted fallback: when a chunk-range update hits the
Timescale tuple decompression limit, the migration retries that same chunk in
one-hour `recorded_at` windows. This keeps the deployment from spending hourly
queries on every already-finished chunk while keeping each DML statement below
the decompression cap for large remaining chunks.

### Fourth Follow-up Evidence

The hybrid fallback worked, but production progress was still too slow for a
deploy migration. The first large remaining chunk completed through hourly
fallback with `187,218` rows, while the original production null-ID count was
about `187.7M` rows. That made the backfill operationally too large for
per-hour DML in the deploy timeout window.

### Fourth Follow-up Fix

Kept the backfill chunk-bounded and resumable, but set
`timescaledb.max_tuples_decompressed_per_dml_transaction = 0` for the migration
session before the chunk updates. This removes the Timescale per-DML
decompression cap for this controlled migration session without changing the
database-wide setting.

### Final Follow-up Evidence

The controlled chunk update avoided the decompression limit but was still not a
deploy-time migration. A remaining chunk with `163,506` null-ID rows took about
fourteen minutes, while the historic table still had about `187M` rows requiring
IDs. Production also had exact duplicate metric rows, so there was no safe
natural-key primary key shortcut for `fitness.metric_stream`.

### Final Fix

Stopped trying to backfill historic `metric_stream.id` values and add the
primary key during deploy. Migration `0007_metric_stream_primary_key.sql` now
only adds the nullable `id` column, gives future rows a `gen_random_uuid()`
default, and leaves the table on `REPLICA IDENTITY FULL`. ClickHouse migration
`0003_disable_materialized_metric_stream` drops any previous
`postgres_fitness` MaterializedPostgreSQL database and recreates
`postgres_fitness.metric_stream` as an empty local MergeTree placeholder so
analytics schema creation can complete while raw metric replication remains
disabled.

### Remaining Risk

ClickHouse activity stream and summary read models remain schema-present but do
not receive raw historic metric samples through `postgres_fitness.metric_stream`.
The real fix still requires an offline maintenance job to backfill stable row
IDs, add the Timescale-compatible primary key, and then re-enable raw
ClickHouse replication.

### Stack Deploy Follow-up Evidence

After the migration cleanup deployed, the `Run migrations` step succeeded, but
`docker stack deploy` rolled back `dofek_worker`:

```text
service rollback paused: update paused due to failure or early termination of task
```

Worker logs showed the first fatal app line:

```text
[migrate] Error: ClickHouse URL is malformed. Expected format: http[s]://[username:password@]hostname:port[/database][?param1=value1&param2=value2]
```

The migration container already URL-encoded `CLICKHOUSE_PASSWORD` before
constructing `CLICKHOUSE_URL`; the normal app services interpolated the raw
password into `deploy/stack.yml`, so reserved URL characters in the password
made the app `CLICKHOUSE_URL` invalid.

### Stack Deploy Follow-up Fix

The deploy workflow now exports `CLICKHOUSE_PASSWORD_ENCODED` once after the
Infisical dotenv file is available. `deploy/stack.yml` uses that encoded value
for `web` and `worker` `CLICKHOUSE_URL` interpolation, while the ClickHouse
service still receives the raw `CLICKHOUSE_PASSWORD`.

### Stack Rollout Recovery Evidence

After the encoded password fix, production migrations succeeded and `dofek_web`
updated to `sha-0d4aa69`, but the GitHub Actions `docker stack deploy
--detach=false` process remained stuck. Live Swarm state showed `dofek_worker`
had rolled back to the older `sha-7af8b2f` service spec, where
`CLICKHOUSE_URL` still contained the raw password. That rollback target
crash-looped with the same malformed ClickHouse URL error, leaving the worker at
`0/1` while the deploy step waited indefinitely.

### Stack Rollout Recovery Fix

Recovered `dofek_worker` to the committed `sha-0d4aa69` image with the same
URL-encoded `CLICKHOUSE_URL` already present on the healthy `dofek_web` service.
After recovery, Swarm reported `dofek_web` `2/2`, `dofek_worker` `1/1`, and
`dofek_training-export-worker` `1/1`; `/healthz` returned `{"status":"ok"}`.
The deploy workflow now wraps `docker stack deploy --detach=false` in a
20-minute timeout so a future wedged rollout hard-fails with an explicit error
instead of leaving the job running indefinitely.

## 2026-05-01: Web Deploy Retry Reported Success After Worker Rollback

### Symptoms

A manual retry of the web deploy workflow completed with a successful GitHub
Actions conclusion, but live Swarm state showed `dofek_worker` had rolled back
while `dofek_web` updated to the newly built image digest for the same
`sha-d062350` tag.

### User Impact

The public web health check stayed healthy, and a worker task remained running
after rollback. The deploy result was still misleading because one required app
service did not finish the rollout cleanly.

### Evidence

`dofek_worker` update status was `rollback_completed`. Worker logs showed the
first fatal line during startup:

```text
[migrate] Error: connect ECONNREFUSED 10.0.1.8:8123
```

The same deploy run showed ClickHouse being restarted shortly before app
service rollout because the workflow unconditionally ran:

```text
docker service update --limit-memory 2G dofek_clickhouse
```

### Root Cause

The deploy workflow restarted ClickHouse on every run even when the desired 2G
memory limit was already set, creating an avoidable ClickHouse availability
blip before app service rollout. `docker stack deploy --detach=false` then
returned success even though `dofek_worker` rolled back.

### Fix

Changed the deploy workflow to inspect the current ClickHouse memory limit and
only run `docker service update --limit-memory 2G` when it differs. Added a
post-stack-deploy check that inspects required app services and hard-fails if
any required service reports a rollback or paused update state.

### Remaining Risk

The worker's startup path still depends on ClickHouse being reachable while it
runs migrations. Future deploys should now avoid the self-inflicted ClickHouse
restart and should fail loudly if a required service rolls back anyway.

## 2026-05-01: Metric Stream Primary Key Backfill Remains Unfit for Deploy

### Symptoms

Attempts to complete `fitness.metric_stream` ID backfill, `SET NOT NULL`, and
primary-key migration in the production deploy path repeatedly failed or had to
be stopped before completion.

### Evidence

The deploy migration path hit three distinct blockers:

- `transparent decompression only supports tableoid system column`
- `tuple decompression limit exceeded by operation`
- `Migration exceeded 3300s`

A follow-up manual prod run installed the committed chunked backfill procedure
and started `CALL fitness.backfill_metric_stream_ids(50000);`. After about
eleven minutes it was still inside the first chunk update, producing repeated
WAL checkpoints every roughly 18-23 seconds. The active query was cancelled,
the only old decompressed chunk was recompressed, and production returned to
`190` compressed chunks / `5` uncompressed chunks with no active backfill or
materialized-view refresh sessions.

Later testing against physical chunk
`_timescaledb_internal._hyper_1_118_chunk` showed that the row rewrite itself
was not the only bottleneck. With normal trigger execution, a 50k-row ID-only
update took about 63 seconds and cancellation showed time inside
`analytics.mark_activity_rollup_dirty_from_metric_stream_update()`. With
session-local trigger execution suppressed via `session_replication_role =
replica`, the same 50k-row update took about 2.2 seconds and the remaining
198,250 rows in that test chunk updated in about 6.1 seconds.

### Root Cause

The historic `metric_stream` table is too large for an in-deploy UUID rewrite
when the work fires metric-change triggers for every ID-only update. Updating
existing rows rewrites wide historical tuples and indexes, generates WAL, and
cannot complete inside the GitHub Actions migration watchdog when each row also
marks activity rollups dirty. Compressed chunks also make row-by-row targeting
and transparent decompression more constrained than a regular Postgres table.

### Fix or Mitigation

The backfill was cancelled before another deploy timeout. The old decompressed
chunk from the cancelled attempt was recompressed. The migration was updated to
run the ID-only rewrite with session-local trigger execution disabled, then
restore normal trigger behavior before `SET NOT NULL` and primary-key DDL.

The final production run completed on 2026-05-01. The manual migration applied
`drizzle/0009_metric_stream_id_not_null_primary_key.sql`, backfilled all NULL
IDs, set `fitness.metric_stream.id` to `NOT NULL`, and added the
Timescale-compatible primary key on `(id, recorded_at)`. A normal web-stack
deploy then ran successfully from `Asherlc/metric-stream-id` at `sha-e1b2f55`
and recorded migration `0009_metric_stream_id_not_null_primary_key.sql` in
`drizzle.__drizzle_migrations`.

### Remaining Risk

`metric_stream` now has the required identity for ClickHouse work. The migration
left a small number of recently touched chunks uncompressed and increased disk
usage to roughly 57% on `/mnt/dofek-data`; routine compression, autovacuum, and
future maintenance should be monitored but no active backfill remained running.
Replica identity stayed `FULL`, matching the existing migration and tests.

## 2026-05-01: ClickHouse Metric Stream Snapshot Missed Hypertable Rows

### Symptoms

ClickHouse replication setup for `postgres_fitness.metric_stream` deployed, but
the ClickHouse table stayed empty while production Postgres still had
`fitness.metric_stream` rows. The first backfill deploy attempt then had to be
cancelled during migration execution.

### Evidence

ClickHouse logs showed `MaterializedPostgreSQL` created `metric_stream` and
started replication. Direct ClickHouse reads through the `postgresql(...)` table
function returned source rows from Postgres, and a one-day source count returned
3,259,688 rows, but `postgres_fitness.metric_stream` had `0` rows. The first
backfill migration attempted to derive global `recorded_at` bounds from the
hypertable and remained active in Postgres during the deploy. Timescale metadata
showed the table has `195` physical chunks spanning `1989-12-28` through
`2104-02-14`, making a continuous 6-hour backfill range unfit for deploy.
Follow-up investigation showed `ONLY fitness.metric_stream` had no rows while
`fitness.metric_stream` had rows through the hypertable abstraction, and the
ClickHouse-created publication `health_ch_publication` contained only
`fitness.metric_stream`. None of the `195`
`_timescaledb_internal._hyper_*_chunk` child tables were in the publication.

### Root Cause

The ClickHouse `MaterializedPostgreSQL` initial snapshot and logical
replication target the published Postgres relation, `fitness.metric_stream`.
In TimescaleDB, the hypertable root relation is effectively an empty routing
table; the data live in `_timescaledb_internal` chunk tables. Because
`MaterializedPostgreSQL` created a publication for only the hypertable root, not
the chunks, the initial snapshot copied no historical rows and live chunk writes
were not discoverable by the CDC stream. The first manual backfill design also
treated the hypertable as one continuous time range instead of iterating the
actual Timescale chunks.

### Fix or Mitigation

Cancelled the bad deploy run and cancelled the active Postgres bounds query.
Changed `0005_backfill_materialized_metric_stream` to fetch chunk ranges from
`timescaledb_information.chunks`, backfill each real chunk into
`postgres_fitness.metric_stream`, and record completed ranges in
`analytics.metric_stream_backfill_chunks` so retries can resume.

### Remaining Risk

The chunked backfill still rewrites a large volume into ClickHouse and should be
monitored until `analytics.schema_migrations` includes
`0005_backfill_materialized_metric_stream` and `postgres_fitness.metric_stream`
has nonzero rows. Future read-model migrations should prefer ClickHouse-native
tables/materialized views for large time-series aggregates instead of Postgres
materialized views or unbounded hypertable scans.

## 2026-05-01: ClickHouse Metric Stream Backfill Target Was Read-Only

### Symptoms

The follow-up production deploy run for the chunk-based ClickHouse backfill
failed during the `Run migrations` step before `docker stack deploy`.

### Evidence

GitHub Actions run `25232097814` failed from commit
`4f932fce9fc1df245bf927a95371781ad3374dad`. The first fatal migration log line
was:

```text
error: [migrate] Error: Method write is not supported by storage MaterializedPostgreSQL.
```

After the failure, ClickHouse still showed `0` rows in
`postgres_fitness.metric_stream`, no completed
`analytics.metric_stream_backfill_chunks`, and no
`0005_backfill_materialized_metric_stream` row in
`analytics.schema_migrations`.

### Root Cause

The backfill migration attempted to insert historical rows into
`postgres_fitness.metric_stream`, but that table is owned by the
`MaterializedPostgreSQL` database engine. The engine exposes a replicated
read-only table in ClickHouse, so it cannot be used as the destination for a
manual historical backfill.

### Fix or Mitigation

The code fix replaces the `MaterializedPostgreSQL` target with a
ClickHouse-native `postgres_fitness.metric_stream` `MergeTree` table and adds
ClickHouse migration `0006_backfill_native_metric_stream`. That migration drops
the broken read-only database, recreates the raw scalar table and analytics
views, backfills by real Timescale chunk ranges through the `postgresql(...)`
table function, records completed ranges in
`analytics.metric_stream_backfill_chunks`, and refreshes the ClickHouse
read-model views after the backfill.

### Remaining Risk

`analytics.deduped_sensor` remains empty until the native-table migration
deploys and finishes. This fixes the historical backfill/read-only problem, but
it is still a batch copy path rather than a long-running WAL CDC service; a
future PeerDB/ClickPipes-style CDC pipeline is still the better steady-state
answer for continuous Timescale chunk changes.

## 2026-05-01: PeerDB CDC Setup Added for Metric Stream

### Symptoms

The ClickHouse metric stream read path had a native chunk backfill, but no
long-running CDC service for new Postgres/Timescale `fitness.metric_stream`
changes.

### Evidence

ClickHouse and PeerDB documentation point to PeerDB/ClickPipes for Postgres CDC
into ClickHouse. The Timescale-specific guidance calls out that hypertable
changes are chunk-level changes, so a robust CDC path must understand Timescale
chunks instead of treating the hypertable root as the only published relation.

### Root Cause

The earlier ClickHouse `MaterializedPostgreSQL` approach did not handle the
Timescale hypertable/chunk model correctly, and the native ClickHouse backfill
only covered historical batch copy.

### Fix or Mitigation

Added internal PeerDB services to the swarm and a one-shot setup command that
applies the declarative `src/db/peerdb/metric-stream-cdc.sql` definition for
the PeerDB Postgres peer, ClickHouse peer, and `dofek_metric_stream_cdc`
mirror. The mirror writes into `peerdb.metric_stream`, excludes unused
non-scalar columns, and uses soft deletes. The production analytics read path
intentionally stays on `postgres_fitness.metric_stream` until the PeerDB
initial snapshot is verified.

### Remaining Risk

PeerDB must deploy successfully and complete its initial snapshot before
analytics can switch to `peerdb.metric_stream`. The next operational step is to
compare row counts and recent-row freshness between Postgres,
`postgres_fitness.metric_stream`, and `peerdb.metric_stream`, then cut
`analytics.deduped_sensor` over in a separate migration.

## 2026-05-01: Production Deploy Migration Timed Out During Metric Stream Backfill

### Symptoms

Production deploy run `25237109231` failed in job `74005587158` during the
`Run migrations` step. The migration container exited with code 1 before
`docker stack deploy` ran, so the new web stack image was not released.

### Evidence

The first fatal job line was `Migration failed (exit code 1).` The last
migration log line was:

```text
error: [migrate] Error: Timeout error.
```

Immediately before the error, Postgres migrations had applied 0 new files and
materialized view sync had completed with `synced=0 skipped=7 refreshed=0`.
The next code path is `runClickHouseMigrations()`.

### Root Cause

ClickHouse migration `0006_backfill_native_metric_stream` copied each full
Timescale chunk with one `INSERT INTO ... SELECT FROM postgresql(...)` command.
Production chunks were large enough for a ClickHouse HTTP command to exceed the
client's default 30 second request timeout. Because the migration also dropped
`postgres_fitness` and the backfill progress table on every retry, a retry
would restart the native backfill instead of continuing from completed ranges.

### Fix or Mitigation

The migration now splits Timescale chunk ranges into one-hour ClickHouse
backfill windows and records those bounded windows in
`analytics.metric_stream_backfill_chunks`. It only drops `postgres_fitness` and
the progress table when `postgres_fitness` is still backed by a non-native
database engine; retries against an already-native database preserve completed
backfill windows and continue from the first missing window.

### Remaining Risk

Very dense one-hour windows can still take longer than expected, but future
failures will now identify the exact window being copied and retries will not
discard completed native backfill progress.
