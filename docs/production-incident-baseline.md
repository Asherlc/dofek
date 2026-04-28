# Production Incident Baseline

<!-- cspell:ignore Hetzner Hypertables rollups fanout -->

This document summarizes production failure modes observed so far. It is not a
full incident log or a replacement for runbooks. Use it to build shared memory
about the kinds of issues this system encounters, the signals that identified
them, and the durability work they suggest.

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
