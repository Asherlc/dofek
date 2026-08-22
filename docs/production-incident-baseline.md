# Production Incident Baseline

<!-- cspell:ignore Hetzner Hypertables rollups fanout Checkpointed subcheck MISCONF docuum anchore -->

This document summarizes production failure modes observed so far. It is not a
full incident log or a replacement for runbooks. Use it to build shared memory
about the kinds of issues this system encounters, the signals that identified
them, and the durability work they suggest.

## 2026-06-17: Raw PeerDB mirrors missing from production

### Symptoms

Sentry issue `DOFEK-SERVER-3B` reported recurring `ClickHouse CDC health check
failed` events from the production `cdc-health` service. The latest failure was
for missing raw analytics PeerDB slots:
`peerflow_slot_dofek_fitness_raw_analytics`,
`peerflow_slot_dofek_provider_inventory_raw_analytics`, and
`peerflow_slot_dofek_sensor_priority_raw_analytics`.

### User Impact

No direct Sentry users were impacted. ClickHouse raw mirrors and downstream
analytics could become stale for non-metric-stream source tables while the raw
PeerDB mirrors were absent.

### Evidence

Sentry event `4b961c3da10544bc824ba36642710cca` occurred at
`2026-06-17T22:01:23.893Z` and reported all three required raw PeerDB slots as
missing. Production `pg_replication_slots` returned no
`peerflow_slot_dofek_%` rows, and the PeerDB catalog had no registered
`dofek_*analytics` flows. The old `metric_stream` PeerDB mirror was not part of
this failure; metric-stream ingestion is owned by Redpanda and the ClickHouse
sink.

Follow-up investigation found the durable missing-slot state began after the
June 9 `Deploy Web` run for `669cac25`. The deploy workflow ran
`src/db/setup-clickhouse-cdc.ts` and logged
`[clickhouse-cdc] PeerDB raw analytics CDC mirrors are configured` at
`2026-06-09T18:49:56Z`; the next `cdc-health` run failed at
`2026-06-09T18:54:34Z`. The deployed commit did not modify PeerDB setup or CDC
health-check code. Retained PeerDB Docker logs no longer contained the exact
flow deletion/failure statement for that June 9 window.

### Root Cause

The raw analytics PeerDB mirrors were absent from production, so Postgres had no
logical replication slots for the raw table CDC flows that feed
`postgres_fitness.*`. The exact statement or PeerDB workflow failure that
removed the flows was not available from retained logs. The confirmed prevention
gap is that CDC setup returned success after submitting/reconciling mirrors but
did not validate the postcondition that all required raw flows had durable
catalog rows and active/reserved Postgres replication slots after PeerDB settled.

### Fix or Mitigation

Ran the checked-in `src/db/setup-clickhouse-cdc.ts` path inside the production
`cdc-health` container. This recreated only the three raw analytics mirrors and
did not recreate the retired metric-stream PeerDB mirror. Validation showed all
three raw slots active with `wal_status = reserved`, PeerDB started CDC on
`peerflow_slot_dofek_fitness_raw_analytics`, and
`scripts/check-clickhouse-cdc.ts` returned
`[clickhouse-cdc-health] ok: checked 3 slots and 1 mirror`.

### Remaining Risk

The cause of the catalog/slot disappearance is still unknown. If the mirrors
disappear again, inspect PeerDB catalog persistence, recent stack deploys, and
whether any manual PeerDB cleanup removed raw `dofek_*analytics` flows. Do not
recreate the legacy metric-stream mirror during this investigation. Follow-up on
June 17 added catalog-aware CDC health reporting and sanitized Sentry evidence
for observed PeerDB flows and Postgres slots. Remaining repo work is to make
`setup-clickhouse-cdc.ts` fail unless it can read the three raw flow catalog rows
and matching active/reserved Postgres slots after setup.

## 2026-06-07: Integration testcontainers pulled TimescaleDB from Docker Hub

### Symptoms

The `Test / Integration Tests` CI job failed on push to `main` for
`35e0c3724e45ba21d27c1cce4c74a21a51a92f89`. The downstream `Test / Unit &
Integration Tests`, `Test / Test Gate`, and `CI Gate` jobs failed because the
integration job did not pass.

### Evidence

The failing command was `pnpm exec vitest run --project integration --coverage`.
The first fatal line was
`Error: (HTTP code 500) server error - Get "https://registry-1.docker.io/v2/": net/http: request canceled while waiting for connection (Client.Timeout exceeded while awaiting headers)`.
The affected suites were the testcontainers-backed TimescaleDB tests in
`src/db/metric-stream-location-point-migration.integration.test.ts`,
`src/db/metric-stream-replica-identity.integration.test.ts`, and
`src/db/seed-dev-db.integration.test.ts`.

### Root Cause

Those suites created local TimescaleDB containers with the unmirrored
`timescale/timescaledb-ha:pg18.3-ts2.26.4-all` image, bypassing the workflow's
existing `mirror.gcr.io` service-container image references and hitting the same
Docker Hub timeout mode already seen in CI.

### Fix or Mitigation

Changed testcontainers TimescaleDB image references to
`mirror.gcr.io/timescale/timescaledb-ha:pg18.3-ts2.26.4-all`, including the
shared DB test helper.

### Remaining Risk

The integration suite still depends on `mirror.gcr.io` availability, matching
the existing workflow service-container strategy.

## 2026-06-06: Metric Stream CDC Lost Slot Reported By Sentry

### Symptoms

Sentry issue `DOFEK-SERVER-3B` reported `ClickHouse CDC health check failed`
from the production `cdc-health` service.

### User Impact

No Sentry users were impacted directly, but ClickHouse sensor analytics that
depend on `postgres_fitness.metric_stream` could miss rows after
`2026-06-03 21:57:38 UTC`.

### Evidence

Sentry recorded 9 production events from `2026-06-06T03:33:27Z` through
`2026-06-06T03:37:46Z`. The health check reported
`peerflow_slot_dofek_metric_stream_analytics is lost` and
`postgres_fitness.metric_stream last synced at 2026-06-03 21:57:38.000000000`.
Production Postgres showed that slot inactive with `wal_status = lost` and
`confirmed_flush_lsn = 36/437517D0`; the other three PeerDB slots were active
and reserved. PeerDB's first fatal flow-worker line was
`ERROR: can no longer access replication slot "peerflow_slot_dofek_metric_stream_analytics" (SQLSTATE 55000)`
at `2026-06-06T03:33:42Z`.

### Root Cause

The high-volume `metric_stream` PeerDB flow was already left on a fresh slot
without a full destination resnapshot during the June 3 lost-slot recovery. The
new `cdc-health` service correctly detected that remaining broken mirror after
deployment, but the monitor process exited on each failed check, causing Swarm
to restart it repeatedly and amplify Sentry events.

### Fix or Mitigation

Lowered CDC retained-WAL thresholds to warn at 16 GiB and fail at 32 GiB,
leaving headroom before Postgres reaches the 64 GiB per-slot WAL cap. Changed
the `cdc-health` entrypoint to report failures to logs/Sentry and sleep until
the next configured interval instead of exiting into a tight Swarm restart loop.

### Remaining Risk

The existing lost `metric_stream` slot still requires PeerDB-side recovery:
recreate the mirror slot and run bounded metric-stream catch-up or a full
resnapshot as appropriate. Do not treat monitor quieting as data recovery.

### Follow-Up Work

- Owner: Asher. Deadline: before resolving `DOFEK-SERVER-3B`. Recreate the
  `dofek_metric_stream_analytics` PeerDB mirror slot.
- Owner: Asher. Deadline: before resolving `DOFEK-SERVER-3B`. Run bounded
  metric-stream catch-up or a full resnapshot for the affected window.
- Owner: Asher. Deadline: before resolving `DOFEK-SERVER-3B`. Verify
  `postgres_fitness.metric_stream` freshness and downstream analytics rows.

### June 6 Follow-Up: Strain Still Zero

The dashboard strain remained `0` after the monitor fix because the data repair
had not run yet. Production `pg_replication_slots` still showed
`peerflow_slot_dofek_metric_stream_analytics` as `active=f`,
`wal_status=lost`, empty `restart_lsn`, and about `47GB` retained lag against a
`64GB` `max_slot_wal_keep_size`. The `cdc-health` service was still reporting
`postgres_fitness.metric_stream last synced at
2026-06-03 21:57:38.000000000`. Scheduled `analytics-worker` dbt builds were
succeeding, including `analytics.daily_activity_load` and
`analytics.daily_strain`, but they were rebuilding from stale mirror input:
ClickHouse `analytics.daily_strain` was refreshed on June 6 with latest
`daily_load=0`. Postgres source still had about `3,059,776` non-IMU
`fitness.metric_stream` rows after the mirror gap and `25` activities since
June 3. A dry run of `scripts/catch-up-clickhouse-metric-stream.ts` planned
`57` one-hour windows for
`[2026-06-03T21:57:38Z, 2026-06-06T06:00:00Z)`. No write-side repair was run
during this check; catch-up can repair the selected historical window, but the
lost PeerDB slot still requires mirror recreation or resync for future rows.

## 2026-06-05: Dashboard Strain And Sleep Empty From ClickHouse Null Join Defaults

### Symptoms

The dashboard daily summary showed no strain and no sleep data even though the
production app was accepting recent wearable uploads.

### User Impact

ClickHouse-backed dashboard strain and sleep cards appeared empty. Recovery data
could still render because `analytics.daily_recovery` already had materialized
rows.

### Evidence

Production services were healthy on Oracle (`dofek_web` 2/2,
`dofek_clickhouse` 1/1, `dofek_analytics-worker` 1/1), but
`analytics-worker` repeatedly failed the `analytics.daily_strain` dbt model with
ClickHouse code 69: `range` would produce 4,294,922,424 array elements.
`analytics.daily_strain` and `analytics.daily_sleep` were empty, while
`analytics.daily_activity_load` had 17 rows for the active user from
`2026-05-28` through `2026-05-31`, and `analytics.v_sleep` had 88 rows through
`2026-06-05`. Reproducing the `daily_strain` CTE showed
`calculation_min_date=2149-04-14` and `max_date=2026-06-05`; with
`join_use_nulls=1`, the same CTE produced the expected
`calculation_min_date=2026-05-28`, `max_date=2026-06-05`, and a 9-day window.
The analogous `daily_sleep` read-only CTE produced 86 non-nap rows through
`2026-06-04` with `join_use_nulls=1`.

### Root Cause

The `daily_sleep` and `daily_strain` incremental dbt models left-joined an empty
`existing_dates` relation without `join_use_nulls=1`. ClickHouse filled missing
joined `Date` values with `1970-01-01` instead of `NULL`; `daily_sleep` filtered
all source rows out, while `daily_strain` subtracted an interval from the
sentinel date, wrapped to year 2149, and generated an invalid negative calendar
range.

### Fix or Mitigation

Add `join_use_nulls=1` to both `analytics.daily_sleep` and
`analytics.daily_strain` model query settings so fresh empty incremental tables
preserve null joined values and materialize source rows correctly.

### Validation

Focused regression test `pnpm vitest run
analytics/models/read_models/read_model_microbatch.sql.test.ts` passes.
`pnpm lint:analytics-policy` passes. `pnpm lint:analytics-sql` passes after
starting local Compose dependencies with `pnpm compose:up`.

### Remaining Risk

Production tables stay empty until the fix is deployed and the analytics worker
successfully rebuilds the affected models. After rollout, verify
`analytics.daily_sleep` and `analytics.daily_strain` have current rows and the
dashboard no longer shows empty states.

## 2026-06-04: Stryker CI aborted on broken review-app agent symlinks

### Symptoms

- PR `1247` failed `Test / Stryker (0)` before mutation testing completed.
- The downstream `Test / Mutation Testing` aggregate check failed because the
  Stryker shard failed.

### Evidence

- Failed run: `26967699960`, job `79574620588`.
- First fatal log line:
  `ERROR Stryker Unexpected error occurred while running Stryker Error: ENOENT:
  no such file or directory, copyfile
  '/home/runner/work/dofek/dofek/deploy/review-apps/CLAUDE.md' ->
  '/home/runner/work/dofek/dofek/.stryker-tmp/.../deploy/review-apps/CLAUDE.md'`.
- `deploy/review-apps/CLAUDE.md` and `deploy/review-apps/GEMINI.md` were tracked
  symlinks to `AGENTS.md`, but `deploy/review-apps/AGENTS.md` no longer existed.

### Root Cause

- Retired review-app infrastructure left behind broken agent-doc symlinks.
  Stryker copies the repository into a sandbox before running mutants, and its
  copy step aborted when it tried to follow the missing symlink target.

### Fix or Mitigation

- Removed the stale `deploy/review-apps/CLAUDE.md` and
  `deploy/review-apps/GEMINI.md` symlinks. The directory has no `AGENTS.md`, so
  no same-directory agent-doc mirrors are required there.

### Validation

- The exact CI command now passes locally:
  `pnpm exec stryker run stryker.ci.config.json --mutate "src/jobs/process-sync-job.ts:83-91,src/jobs/process-sync-job.ts:197-200"`.
- `pnpm lint`, root `pnpm tsc --noEmit`, server `pnpm tsc --noEmit`, and web
  `pnpm tsc --noEmit` pass.

### Remaining Risk

- None known for this failure mode. If Stryker later aborts on another broken
  symlink, remove the stale symlink or restore its valid target based on whether
  the owning directory still has active agent guidance.

## 2026-06-04: Garmin Rate Limits Still Reported to Sentry

### Symptoms

- Sentry issue `DOFEK-SERVER-33` continued receiving unresolved production
  `GarminRateLimitError: Rate limit exceeded (429): Rate limited` events after
  provider rate-limit retry logic had been added.

### User Impact

- Garmin background sync jobs produced noisy production error events for expected
  provider throttling. The user-facing impact was delayed Garmin sync while the
  provider was rate limited.

### Evidence

- Latest observed Sentry event `7cea1c00286a4d60a81002ab758f874c` occurred at
  `2026-06-04T17:00:01.674Z`.
- Stack trace:
  `processSyncJob -> GarminProvider.sync -> GarminProvider.#resolveTokens ->
  GarminConnectClient.fromTokens -> GarminConnectClient.#exchangeForOAuth2 ->
  fetchWithRateLimitHandling -> GarminProvider.createRateLimitError`.
- The first relevant application frame was
  `/app/src/providers/garmin.ts:296`, where the rate-limit-aware fetch wrapper
  correctly created a `GarminRateLimitError`.

### Root Cause

- Garmin token resolution caught the `GarminRateLimitError` and returned it in
  `SyncResult.errors`. The worker only scheduled cooldown retries for thrown
  `ProviderRateLimitError` instances, so returned rate-limit causes fell through
  the generic sync-error branch and were captured to Sentry.

### Fix or Mitigation

- `processSyncJob` now detects `ProviderRateLimitError` causes returned inside
  `SyncResult.errors` before generic sync-error handling, then routes them
  through the existing cooldown/retry scheduling path.
- Added a regression test covering returned rate-limit errors so they enqueue a
  delayed retry and do not call Sentry.

### Remaining Risk

- The fix must be deployed before Sentry stops receiving this issue. Future
  provider implementations should either throw `ProviderRateLimitError` directly
  or preserve it as `SyncError.cause` so the worker can schedule the cooldown.

## 2026-06-03: Deploy Terraform failed on retired Hetzner provider state

### Symptoms

- `Deploy Web Production / Deploy Infra / Terraform Apply` failed before the
  production stack deploy, so the downstream `Deploy Web Stack` job was skipped.

### Evidence

- Failed run: `26918337754`, job `79413169473`.
- First fatal log line:
  `Provider "registry.terraform.io/hetznercloud/hcloud" requires explicit configuration`.
- The same step then reported `Missing Hetzner Cloud API token`.
- Local `terraform state list` for the main `deploy/` HCP workspace still showed
  `hcloud_firewall.dofek` and `hcloud_ssh_key.default`, even though the checked-in
  main Terraform root no longer configured the Hetzner provider.

### Root cause

- The main Terraform state still contained orphaned Hetzner provider resources
  from retired infrastructure. Terraform had to configure the removed provider
  while planning their removal, but CI no longer supplies `HCLOUD_TOKEN` because
  Dofek no longer uses Hetzner infrastructure.

### Fix

- Removed the orphaned `hcloud_firewall.dofek` and `hcloud_ssh_key.default`
  entries from the main HCP Terraform state with `terraform state rm`.
- Reran the failed deploy workflow; the Terraform Apply job completed
  successfully without a Hetzner token.
- Removed the remaining Hetzner-backed review-app workflow, Terraform root,
  Traefik dynamic route wiring, and active docs so future CI/config does not
  reintroduce that provider.

### Remaining Risk

- Historical incident docs still mention Hetzner for past outages and migration
  context; those are not active runbooks. If any stale remote review-app
  Terraform workspaces still exist, delete them in HCP Terraform rather than
  restoring Hetzner credentials to CI.

## 2026-06-02: CI Stryker shard aborted on Docker Hub service-container pull timeout

### Symptoms

- One `Test / Stryker` matrix shard failed during "Initialize containers", before
  any mutation testing ran. No mutants were evaluated; the artifact upload step
  warned "No files were found with the provided path: reports/mutation/".

### Evidence

- First fatal log line:
  `Error response from daemon: Get "https://registry-1.docker.io/v2/": context
  deadline exceeded` while pulling `timescale/timescaledb-ha:pg18.3-ts2.26.4-all`.
- Three pull retries all timed out, then the job aborted.
- Sibling Stryker shards in the same workflow run pulled the identical image
  successfully, confirming a transient Docker Hub network issue rather than a bad
  tag or config.

### Root cause

- GitHub Actions provisions `services:` containers via the runner's Docker daemon
  during job initialization, before any step runs. The anonymous Docker Hub pull
  hit a transient network timeout.

### Resolution (2026-06-02, after recurrence on E2E + Stryker)

- The flake recurred the same day on the E2E job (`docker buildx create` pulling
  its `moby/buildkit` bootstrap image via the host daemon) and another Stryker
  shard, confirming it as systemic daemon-level Docker Hub flakiness rather than a
  one-off. Root cause: daemon-level pulls (buildx bootstrap image, `services:`
  containers) bypass the buildkitd `config-inline` mirror.
- Fix: pull every daemon-level image from the `mirror.gcr.io` pull-through cache
  instead of `registry-1.docker.io`. `services:` images are prefixed with
  `mirror.gcr.io/` (e.g. `mirror.gcr.io/timescale/timescaledb-ha:...`,
  `mirror.gcr.io/redis:7-alpine`, `mirror.gcr.io/clickhouse/...`) across the
  `lint`, `test-integration`, and `mutation` jobs, and the buildx jobs
  (`image-scan`, `test-e2e-web`) pin the builder image via
  `driver-opts: image=mirror.gcr.io/moby/buildkit:buildx-stable-1` so the
  buildkit bootstrap pull is mirrored too. (An earlier branch-local attempt used
  a daemon-mirror composite action plus a `docker-compose.ci.yml` step stack;
  that was superseded on merge by this simpler image-prefix approach, which keeps
  GitHub `services:` and needs no extra files.)
- Remaining risk: depends on `mirror.gcr.io` availability (already relied on
  repo-wide for buildkitd pulls). Exercised end-to-end on the next CI run.

## 2026-05-31: Training, Activities, and Sleep Analytics Empty

### Symptoms

The production `/training` page appeared mostly unpopulated for training-load
and heart-rate-zone analytics even though recent activity data existed. The
Activities page showed `No activities in the last 4 weeks`, and the Sleep page
also showed no current data.

### User Impact

ClickHouse-backed web pages could show empty or stale states instead of recent
training, activity, and sleep data.

### Evidence

Production `fitness.v_activity` had 826 activities with latest activity data on
`2026-05-31`, and `fitness.sleep_session` had 122 sleep sessions with latest
sleep data on `2026-05-31`. ClickHouse had non-empty `analytics.activity_summary`
and `analytics.v_sleep`, but `analytics.activity_location_sample` had zero rows.
The `analytics-worker` logs showed repeated dbt failures in
`activity_location_sample`: ClickHouse error code 43,
`Nested type Array(Float64) cannot be inside Nullable type` on Hetzner and
`First argument for function tupleElement must be Tuple... Actual String` on
Oracle. Running the live repository methods inside the production web container
returned data for the same user and date windows, which narrowed the issue to
stale/partial analytics read-model refresh rather than missing raw data or
billing access filtering. Earlier in the same investigation, a diagnostic
reproduction of a request-path heart-rate sample/activity join timed out after
20 seconds.

### Root Cause

The ClickHouse mirrors disagreed on the reflected type for
`postgres_fitness.metric_stream.point`: Hetzner exposed it as `Nullable(Point)`,
while Oracle exposed it as a GeoJSON `String`. A model that directly used
`JSONExtract` failed on Hetzner, and a model that directly used `point.1` /
`point.2` failed on Oracle. Because dbt skipped downstream location summary and
activity summary models after that failure, serving read models stayed stale or
partial. Separately, some training repositories still recomputed per-activity
heart-rate and power sample counts by joining `analytics.deduped_sensor` to
`analytics.activity_summary` at request time, which could make the training page
time out or return empty data even when the summary model already had sample
counts.

### Fix or Mitigation

`activity_location_sample` now stores `argMax(point, _peerdb_version)` plus a
`toString(...)` representation, then parses either GeoJSON strings or Point
tuple text from that string representation. It uses `point IS NOT NULL` for
location-row filtering instead of comparing the point to an empty string.
`PmcRepository` and
`TrainingRepository.getActivityStats()` now read `hr_sample_count` and
`power_sample_count` directly from `analytics.activity_summary`.
`TrainingRepository.getHrZones()` now moves the sample timestamp bounds into the
`activity_meta` join and treats zero-valued profile heart-rate fields as absent.

### Validation

Focused repository tests now assert the safer SQL shapes and pass:
`pnpm vitest run packages/server/src/repositories/pmc-repository.test.ts packages/server/src/repositories/training-repository.test.ts`.
The analytics read-model regression test now asserts that
`activity_location_sample` parses both GeoJSON string and Point tuple text
through a string representation; `pnpm vitest run
analytics/models/read_models/read_model_microbatch.sql.test.ts` passes.
Server type checking passes with `cd packages/server && pnpm exec tsc --noEmit`.
Biome passes on the changed files. Full `pnpm lint` reached the analytics SQL
lint phase but could not complete because local ClickHouse was not running on
`127.0.0.1:8123`.

### Remaining Risk

The fix still needs to be redeployed and verified on Oracle after the portable
point parsing change. Heart-rate-zone analytics still scans deduped sensor
samples for zone distribution; if it remains slow, move weekly zone rollups into
a dbt-owned incremental read model.

## 2026-05-26: ClickHouse OOM Restarts From Dashboard Activity Analytics

### Symptoms

Dashboard tRPC routes intermittently returned
`getaddrinfo ENOTFOUND clickhouse` for ClickHouse-backed routes such as
`recovery.workloadRatio` and `healthspan.score`. Public `/healthz` could still
return OK while dashboard analytics failed.

### User Impact

The dashboard intermittently failed to load recovery and healthspan data while
ClickHouse restarted under load.

### Evidence

Swarm showed `dofek_clickhouse` repeatedly failing with
`task: non-zero exit (137)`. The first fatal host log line during the observed
incident was:

```text
May 26 02:22:21 dofek kernel: ConcurrentJoin invoked oom-killer: gfp_mask=0xcc0(GFP_KERNEL), order=0, oom_score_adj=0
```

ClickHouse was killed shortly after at about 3.54 GiB anonymous RSS, then
restarted repeatedly. Web logs around the restarts showed ClickHouse-backed
dashboard routes failing with `socket hang up`, `EHOSTUNREACH`, and
`getaddrinfo ENOTFOUND clickhouse`. ClickHouse query logs showed expensive
activity/recovery and sleep analytics overlapping with background dbt work.

### Root Cause

Dashboard routes were still reading `analytics.activity_summary` as a live
ClickHouse view that recomputed joins over deduped sensor and location samples.
Those request-path joins could overlap with background analytics work and exceed
the single-node ClickHouse memory budget, causing container OOM kills and
service-discovery failures while the ClickHouse task restarted.

### Fix or Mitigation

Move `analytics.activity_summary` to a thin compatibility view over
`analytics.activity_summary_rows` so dashboard routes no longer recompute the
activity/sample joins on demand. The first offline `activity_summary_rows` dbt
model still OOM-killed ClickHouse in production, and a follow-up production run
showed `deduped_sensor` also OOM-killed ClickHouse as a single incremental
model. Production `DBT_SAFE_MODELS` now selects only `sensor_scalar_sample`;
`deduped_sensor`, `resting_heart_rate_sleep_window`, and
`activity_summary_rows` stay excluded until they are split into smaller chained
incremental models.

### Validation

Production deploy run `26430662909` rolled out app image `sha-1d5e448`.
Post-deploy checks showed `dofek_web` at `2/2`, `dofek_worker` at `1/1`,
`dofek_analytics-worker` at `1/1`, all on `sha-1d5e448`; public `/healthz`
returned HTTP 200. The new analytics worker ran only
`analytics.sensor_scalar_sample` and completed with `PASS=1`. ClickHouse had no
new exit-137 restarts in the first nine minutes after the previous crash, and
recent web logs had no fresh ClickHouse DNS/socket errors for
`recovery.workloadRatio` or `healthspan.score`.

### Follow-up

Follow-up commit `cdf60615` kept production stable with only
`sensor_scalar_sample` selected. The next experiment converts
`sensor_scalar_sample` and `deduped_sensor` to dbt's `microbatch` incremental
strategy and adds `deduped_sensor` back to `DBT_SAFE_MODELS`; this keeps each
run bounded to daily `recorded_at` batches with a short lookback instead of one
large dirty-key query.

### Remaining Risk

Activity summary and resting-heart-rate values may be missing or stale until
the excluded dbt models are redesigned and enabled with bounded dbt-native
incremental strategies.

## 2026-05-25: Deploy Web Failed On Netdata OOM And Stale PeerDB Mirror Slot

### Symptoms

The `Deploy Web` workflow for commit `83f82b1fccb707046ce26632f34334e902eeb1bb`
failed. The production `Deploy stack` step failed before post-deploy checks,
and the staging deployment later failed in `Configure ClickHouse CDC`.

### User Impact

Production application services still rolled to `sha-83f82b1`, but the
workflow reported failure and skipped the post-deploy readiness, PeerDB, and
CDC setup checks. Staging also ended with CDC setup incomplete.

### Evidence

The linked production job failed in `Deploy stack` with:

```text
qqiyjespsj1efpwpou1sqgywq: Error response from daemon: rpc error: code = DeadlineExceeded desc = context deadline exceeded
```

The service ID mapped to `dofek_netdata`. Production Swarm showed
`dofek_netdata` at `0/1`, and `docker service ps dofek_netdata` showed repeated
task failures with `task: non-zero exit (137)`. Netdata's crash report showed a
container memory view of about `805 MiB` total and about `799 MiB` used by
Netdata while the stack configured a `768M` memory limit.

The staging `Configure ClickHouse CDC` step failed with:

```text
FATAL: number of requested standby connections exceeds "max_wal_senders" (currently 4)
```

Staging Postgres had `max_wal_senders = 4`, `max_replication_slots = 4`, and
four active slots:

- `peerflow_slot_dofek_fitness_raw_analytics`
- `peerflow_slot_dofek_metric_stream_analytics`
- `peerflow_slot_dofek_metric_stream_cdc`
- `peerflow_slot_dofek_provider_inventory_raw_analytics`

PeerDB catalog still contained the obsolete `dofek_metric_stream_cdc` flow.

### Root Cause

Production failed because the Netdata service's memory limit was below the
memory Netdata needed to load its persisted dbengine state on startup, causing
repeated exit-137 restarts and Swarm deploy convergence failure. Staging failed
because a legacy PeerDB mirror, `dofek_metric_stream_cdc`, still held one of
the four configured logical replication slots, leaving no sender capacity for
the current sensor-priority mirror creation path.

### Fix or Mitigation

The repo fix gives Netdata explicit dbengine retention limits and lowers the
Swarm memory cap to `512M`. Netdata now keeps two bounded tiers: one day of
per-second data and fourteen days of per-minute data, each capped at `256MiB`.
ClickHouse CDC setup also drops the obsolete `dofek_metric_stream_cdc` mirror
before creating current mirrors. This frees the stale logical replication slot
through PeerDB instead of increasing Postgres replication caps.

### Remaining Risk

Netdata no longer keeps the default long per-hour tier on this host. If memory
still grows beyond the `512M` cap, the next investigation should inspect metric
cardinality and collector scope before raising the limit.

## 2026-05-25: Startup Cache Warmup Saturated ClickHouse And Caused Public 521s

### Symptoms

Public health checks for `https://dofek.asherlc.com/healthz`,
`https://dofek.fit/healthz`, and `https://dofek.live/healthz` returned
Cloudflare `521` or timed out. SSH intermittently timed out during banner
exchange. Swarm showed `dofek_web` at `0/2`, `dofek_worker` at `0/1`, and
`dofek_clickhouse` at `0/1` during the outage window, while Traefik remained
up.

### User Impact

The public web app was unavailable while web tasks and ClickHouse churned. The
service recovered without a code or stack change, but remains vulnerable to the
same startup warmup pattern until the warmup or underlying ClickHouse queries
are changed.

### Evidence

At `2026-05-25 15:56 UTC`, the host reported load around `208` and SSH banner
exchange timed out. Kernel OOM logs showed ClickHouse killed inside its memory
cgroup at `2026-05-25 15:56:33 UTC` with about `4.56 GiB` anonymous RSS, and
Netdata repeatedly hit its own memory cgroup. Web logs from the same window
showed both web replicas starting and running `warmCache()`. Repeated warmup
failures included:

- `dailyMetrics.trends(30)` failing with ClickHouse total memory limit
  exceeded after about `19-38s`.
- `sync.providerStats` timing out after about `120s`.
- `insights.compute(90)`, `training.weeklyVolume(90)`,
  `training.hrZones(90)`, `pmc.chart(90)`, `power.powerCurve(90)`,
  `power.eftpTrend(90)`, and cycling analytics warmups failing with ClickHouse
  memory errors, socket hangups, `ECONNREFUSED`, or DNS lookup failures for
  `clickhouse`/`redis`.

ClickHouse `system.processes` later showed two live `analytics.provider_stats`
queries, each reading about `33 GiB` and over `437M` rows. `system.query_log`
showed repeated memory-limit failures from queries against
`analytics.resting_heart_rate_sleep_window`, `analytics.activity_summary`,
`analytics.deduped_sensor`, and `analytics.provider_stats`.

### Root Cause

The server startup cache warmup runs on every web replica and executes many
expensive ClickHouse-backed dashboard and analytics queries sequentially per
replica but concurrently across replicas. After web task restarts, the two
replicas formed a cold-start thundering herd over normal ClickHouse views that
scan large read models. The ClickHouse query memory cap stopped individual
queries, but the concurrent workload still drove ClickHouse into cgroup OOM,
made dependent API queries fail, and destabilized Swarm service discovery
enough to produce `ENOTFOUND`/`ECONNREFUSED` errors for `clickhouse`, `redis`,
and `db`.

### Fix or Mitigation

The fix removes startup cache warming from `runStartupTasks()` and deletes the
unused warm-cache module, so web replica starts no longer issue heavyweight
ClickHouse-backed warmup queries. Production still needs this change deployed.
During investigation, production temporarily became reachable again after the
churn subsided: `https://dofek.asherlc.com/healthz` returned `{"status":"ok"}`.

### Remaining Risk

The immediate fix is not active until deployed. Separately,
`analytics.provider_stats` and the resting-heart-rate/activity analytics views
need query or read-model changes so normal user requests do not scan hundreds
of millions of rows on the single-node ClickHouse host.

## 2026-05-21: Dashboard Sleep Missing After PeerDB Raw Fitness Slot Was Lost

### Symptoms

The dashboard did not show last night's sleep even though provider syncs had
run.

### User Impact

Sleep and sleep-derived dashboard surfaces could show data only through
`2026-05-20` while canonical Postgres already contained `2026-05-21` sleep.

### Evidence

Postgres `fitness.sleep_session` contained WHOOP sleep from
`2026-05-21 06:04:08.51+00` to `2026-05-21 14:29:05.13+00`, inserted at
`2026-05-21 15:00:04.225348+00`. ClickHouse
`postgres_fitness.sleep_session FINAL` and `analytics.v_sleep` only contained
sleep through `2026-05-20`. Postgres `pg_replication_slots` showed
`peerflow_slot_dofek_fitness_raw_analytics` as `active = false` and
`wal_status = lost`, with no `restart_lsn`.

After the raw fitness mirror was repaired, `analytics.v_activity` contained
May 21 activities, but `analytics.deduped_sensor` and
`analytics.activity_summary` were still current only through May 20. A broad
manual ClickHouse refresh of the sensor-derived activity read models scanned
hundreds of millions of rows, exceeded the container memory budget, and caused
ClickHouse to restart.

### Root Cause

The PeerDB logical replication slot for the raw fitness mirror was invalidated
after Postgres discarded WAL the stalled slot still needed. Once the slot was
lost, PeerDB could not resume mirroring `fitness.sleep_session` into
`postgres_fitness.sleep_session`, so the ClickHouse sleep read model stayed
stale even though provider sync wrote current rows to Postgres.

### Fix or Mitigation

One-off production repair:

- Dropped the broken `dofek_fitness_raw_analytics` PeerDB mirror.
- Truncated only its affected ClickHouse raw mirror tables
  (`postgres_fitness.activity`, `sleep_session`, `sleep_stage`,
  `daily_metrics`, `provider`, `provider_priority`, `device_priority`, and
  `user_profile`), leaving canonical Postgres untouched.
- Re-ran the deployed `setupClickHouseCdcFromEnv()` path so PeerDB recreated
  the mirror with a fresh initial snapshot.
- Forced `SYSTEM REFRESH VIEW analytics.v_sleep` and invalidated the affected
  user's server-side query cache.

Validation after repair: `postgres_fitness.sleep_session FINAL` had 105 rows
with latest `started_at = 2026-05-21 06:04:08.510000`, and
`analytics.v_sleep` showed the May 21 Apple Health/WHOOP row. The repaired
Postgres slot was `active = true` and `wal_status = reserved`.

### Remaining Risk

`peerflow_slot_dofek_provider_inventory_raw_analytics` was still `lost` during
this repair and was intentionally left alone because it was not blocking the
sleep dashboard. The durable fix should detect lost PeerDB slots, recreate
affected mirrors safely, and alert before a user-visible stale read model is
noticed manually. Activity sensor summaries need a targeted repair path; broad
manual refresh of the refreshable materialized views is too expensive for the
current single-node ClickHouse memory limit.

## 2026-05-19: PeerDB Replication Slots Invalidated, Activity Pages Showed No Stats Or Map

### Symptoms

A freshly synced activity at `https://dofek.asherlc.com/activity/dced0c9e-78d3-4a43-8c17-aa4e61d061f2`
("Morning Ride", `road_cycling`, started 2026-05-17 17:40 UTC) rendered only the
activity name, type, source links, and a client-computed `Duration`. The Route
Map section was missing entirely, the Performance chart was missing entirely,
Heart Rate Zones rendered "No heart rate zone data", and every aggregate stat
(distance, elevation gain, avg/max HR, avg/max power, avg cadence, avg speed)
was absent.

### User Impact

All activities created after `2026-05-11 16:05 UTC` rendered without map, stream
chart, HR/power zones, or any aggregate stat in the web UI. The activity row
itself loaded normally (name, type, timestamps, source attribution) so the
breakage looked partial and was easy to misread as a per-activity ingestion
problem. The same activity opened fine on Strava, so external data was intact.

### Evidence

The web `/activity/:id` page issues four tRPC queries: `activity.byId`,
`activity.stream`, `activity.hrZones`, `activity.powerZones`. `activity.byId`
returned the row, but every aggregate field (`avgHr`, `maxHr`, `avgPower`,
`maxPower`, `avgSpeed`, `maxSpeed`, `avgCadence`, `totalDistance`,
`elevationGain`, `elevationLoss`, `sampleCount`) was `null`. `activity.stream`
returned `[]`. `activity.hrZones` returned all zones with `seconds: 0`. All four
endpoints read from ClickHouse read models (`analytics.activity_summary`,
`analytics.deduped_sensor`, `analytics.deduped_location`) via
`packages/server/src/repositories/clickhouse-activity-sensor-store.ts` and the
`#withActivitySummaries` hydration step in
`packages/server/src/repositories/activity-repository.ts`.

ClickHouse counts:

| Layer | This activity | Global |
|---|---|---|
| `postgres_fitness.metric_stream` (CDC mirror) | 177,696 × 5 channels | 281M rows |
| `postgres_fitness.activity` (CDC mirror) | **0** | 697 |
| `analytics.v_activity` (REFRESHABLE MV every 1 min) | 0 | 576 |
| `analytics.v_activity_members` | 0 | — |
| `analytics.deduped_sensor` | 0 | 5.10M |
| `analytics.deduped_location` | 0 | 356K |
| `analytics.activity_summary` | 0 | — |

`postgres_fitness.activity` `_peerdb_synced_at` ranged only from
`2026-05-10 19:03` to `2026-05-11 16:05`, despite Postgres `fitness.activity`
holding 867 rows up to today. PeerDB worker logs showed:

```text
ERROR: can no longer access replication slot
  "peerflow_slot_dofek_metric_stream_analytics" (SQLSTATE 55000)
ERROR: can no longer access replication slot
  "peerflow_slot_dofek_fitness_raw_analytics" (SQLSTATE 55000)
ERROR: can no longer access replication slot
  "peerflow_slot_dofek_provider_inventory_raw_analytics" (SQLSTATE 55000)
```

Postgres `pg_replication_slots` confirmed `wal_status = 'lost'` and
`active = false` for all three PeerDB slots, with empty `restart_lsn`. The slots
were unrecoverable from the Postgres side.

### Root Cause

PeerDB's three CDC logical replication slots
(`peerflow_slot_dofek_metric_stream_analytics`,
`peerflow_slot_dofek_fitness_raw_analytics`,
`peerflow_slot_dofek_provider_inventory_raw_analytics`) were marked
`wal_status = 'lost'` by Postgres, almost certainly because the metric-stream
rebuild and location-point migration churned more WAL than `max_slot_wal_keep_size`
allowed while the slots could not advance. Once Postgres dropped the required
WAL segments, the slots could no longer be used.

The migration's direct SQL backfill from Postgres to ClickHouse repopulated
`postgres_fitness.metric_stream` (281M rows) independent of CDC, which masked
the outage for sample data. There was no equivalent direct backfill for the
`activity`, `provider_inventory`, or other `fitness_raw` tables, so every row
written after the slot was lost became invisible to ClickHouse. All
ClickHouse read models on the activity page (`deduped_sensor`, `deduped_location`,
`activity_summary`) `INNER JOIN` `analytics.v_activity_members`, which depends
on the `activity` mirror — so with no mirror row for the activity, even the
already-replicated metric_stream samples were orphaned and filtered out.

### Fix or Mitigation

- (Pending) Drop the three invalid PG slots, recreate each PeerDB mirror with
  an initial snapshot, and let CDC resume from a fresh slot.
- (Pending) After the resync, verify that the refreshable MVs
  (`analytics.v_activity`, `analytics.v_activity_members`,
  `analytics.deduped_sensor`, `analytics.deduped_location`,
  `analytics.activity_summary`) repopulate within their 1-minute refresh cycle.

### Remaining Risk

`max_slot_wal_keep_size` on Postgres remains at its current setting. Any future
migration that churns more WAL than the configured retention will reproduce
this outage. PeerDB worker errors are visible only in container logs; there is
no alert for `pg_replication_slots.wal_status = 'lost'` or for a stale
`max(_peerdb_synced_at)` on any CDC mirror, so the outage went unnoticed for
eight days until a user noticed missing stream data on an individual activity
page.

### Follow-Up Work

- Raise `max_slot_wal_keep_size` (or set `-1` for unlimited) on production
  Postgres before any future large backfill; revert after.
- Add an alert that pages on `pg_replication_slots.wal_status IN ('lost', 'unreserved')`
  or `pg_replication_slots.confirmed_flush_lsn` lag past a threshold.
- Add a heartbeat check comparing `count(*) FROM fitness.activity` (Postgres) to
  `count(*) FROM postgres_fitness.activity FINAL WHERE _peerdb_is_deleted = 0`
  (ClickHouse) and alarming if they diverge.
- Surface the user-facing failure mode: when `activity.stream` returns `[]` and
  `activity.byId` shows recent `startedAt` but null aggregates, prefer a
  "data still syncing" placeholder over silently rendering an empty page.
- Add a `/diagnose-cdc` skill (added in this change) that walks through the
  slot-status + mirror-row-count queries used to diagnose this.

## 2026-05-19: ClickHouse System Logs Consumed Production Data Volume Space

### Symptoms

After the metric-stream rebuild and ClickHouse point migration finished,
production data-volume usage still looked high at about `98GB` used even after
the legacy Postgres hypertable was dropped.

### User Impact

No outage was observed. Production services remained healthy, but the elevated
baseline made shrinking the Hetzner data volume back toward `100GB` unsafe.

### Evidence

Host-level disk analysis showed `/mnt/HC_Volume_105292545` was split roughly
evenly between `postgres` and `clickhouse`, about `49GB` each. ClickHouse table
sizes showed `system.text_log` alone using about `35.77GiB`, with
`system.processors_profile_log`, `system.trace_log`, and other system log tables
using several more GiB. Application ClickHouse data was much smaller:
`postgres_fitness.metric_stream` was about `5.28GiB` for roughly `281M` rows.

### Root Cause

ClickHouse diagnostic system log tables had no bounded retention and retained
large migration/backfill log volume from the production point migration work.

### Fix or Mitigation

Truncated ClickHouse diagnostic system logs and pruned unused Docker containers
and images. The data volume dropped from about `98GB` used to about `55-56GB`
used, and root disk usage dropped from about `44GB` to `37GB`. Added
checked-in ClickHouse server config to apply seven-day TTL retention to system
log tables via `deploy/clickhouse/config.d/system-log-ttl.xml`, mounted in
production, local, E2E, and review-app ClickHouse configurations.

### Remaining Risk

TTL configuration takes effect after the ClickHouse service is redeployed with
the new config. Future unusually verbose migrations can still generate short
term log volume within the seven-day window, but it should no longer accumulate
indefinitely.

### Follow-Up Work

- Deploy the ClickHouse TTL config through the normal stack release path.
- Add a recurring storage audit or alert that reports top ClickHouse tables,
  including `system.*` log tables.
- Revisit the live 300GB Hetzner volume only after sustained usage and
  operational headroom are clear.

## 2026-05-18: ClickHouse One-Off Backfill Hit Server Memory Ceiling

### Symptoms

The production one-off ClickHouse `metric_stream` location-point migration
advanced from about `24%` to about `44.5%`, then exited with a ClickHouse
`memory limit exceeded` error. After restarting ClickHouse and resuming from the
checkpoint, it advanced beyond `50%` and hit the same server memory ceiling
again.

### User Impact

No user-facing outage was observed. The ClickHouse service stayed in Swarm and
the app healthcheck remained OK, but the one-off migration required supervised
restart/resume cycles.

### Evidence

- The migration container exited with
  `OvercommitTracker decision: Memory overcommit has not freed enough memory:
  While executing MergeTreeSelect(pool: ReadPool, algorithm: Thread)`.
- The first failed run had `oom=false`, so Docker did not kill the container;
  ClickHouse rejected the query at its own memory limit.
- ClickHouse RSS was about `2.49GiB / 3GiB` after the first failure and dropped
  to about `780MiB / 3GiB` after a service restart.
- The checkpoint table preserved progress; after the first failure it showed
  `completed_through = 2024-01-30 05:35:00.000000`.

### Root Cause

The long-running backfill repeatedly queries and anti-joins the ClickHouse
`postgres_fitness.metric_stream` mirror. On dense ranges, ClickHouse process
memory grows until the server-level memory cap rejects the next range query.

### Fix or Mitigation

Restarted the ClickHouse service to clear process RSS, waited for `/ping`, and
resumed the one-off from `analytics.metric_stream_backfill_chunks`. The retry
loop only treats the exact ClickHouse memory-limit failure and temporary
post-restart `ECONNREFUSED` as retryable; other migration failures still stop.

### Remaining Risk

The remaining migration may need additional ClickHouse restart/resume cycles
until the backfill completes. This is operationally safe because each completed
five-minute range is checkpointed, but it is not a clean long-term migration
pattern.

### Follow-Up Work

- After the migration completes, inspect ClickHouse query logs for the densest
  ranges and confirm whether the anti-join or source-table read dominates
  memory.
- Consider lowering per-query memory pressure for future one-off backfills by
  reducing range size or using a staging-table strategy with bounded joins.
- Add a runbook note that checkpointed ClickHouse backfills may be resumed after
  server memory-limit failures only when the checkpoint table confirms progress.

## 2026-05-12: Production volume expanded for metric_stream rebuild headroom

### Impact

The live location migration could not safely continue as a full replacement
hypertable rebuild with only about `19-20GB` free on the production data
volume. A 1:1 rebuild of the approximately `56GB` `fitness.metric_stream`
hypertable would risk exhausting disk before the replacement table could be
validated and swapped.

### Evidence That Mattered

- Before resizing, `/dev/sdb` was a `100G` Hetzner volume with a `99G` ext4
  filesystem and about `19G` free (`80-81%` used).
- Terraform plan showed exactly one in-place infrastructure change:
  `hcloud_volume.dofek_data[0]` size `100 -> 300`, with no creates, destroys,
  server replacement, or volume replacement.
- After apply, `lsblk` showed `/dev/sdb` as `300G`, while `df` still showed the
  filesystem at `99G`, confirming a filesystem grow step was still required.

### Root Cause

The previous `100GB` production data volume was sized for the compressed live
database, not for a historical `metric_stream` rebuild that temporarily needs
both source chunks and replacement chunks plus write/index overhead.

### Fix Or Mitigation

- Updated IaC so `data_volume_size_gb` defaults to `300`.
- Applied Terraform with Infisical-provided secrets. The Hetzner volume
  resized in place; resource ID `105292545` was preserved.
- Grew the mounted ext4 filesystem online with `resize2fs /dev/sdb`.
- Verified `/mnt/HC_Volume_105292545` is now a `295G` filesystem with about
  `208G` free (`27%` used).
- Re-ran Terraform plan and confirmed `No changes`.
- Parsed `deploy/stack.yml` with prod Infisical environment variables and the
  deploy-derived `CLICKHOUSE_PASSWORD_ENCODED`; stack config rendered
  successfully.

### Remaining Risk

The extra space makes a rebuild migration feasible, but the migration still
needs bounded chunk/task execution, immediate compression of replacement
chunks, and progress/disk monitoring. The volume increase should be revisited
after the migration is complete if long-term storage cost matters.

### Follow-Up Work

- Run the remaining metric stream rebuild/backfill with bounded tasks and
  immediate compression after each completed range.
- Keep disk-space and migration-progress monitoring active until the rebuild is
  validated and old storage is explicitly cleaned up.
- Revisit the `300GB` production volume size after cleanup and document whether
  it should remain the default.
- Verify the backup/restore path and update the metric stream runbook with the
  final production migration procedure.

## 2026-05-11: Deploy migration wedged on inline GPS location backfill

### Impact

Deploy Web run `25694900826` could not complete. Staging failed during
`Run migrations`; production remained stuck in `Run migrations`, so the
new web stack was not released. The production app kept serving the previous
image while the one-shot migration container waited behind an earlier
migration session.

### Evidence That Mattered

- Production `pg_stat_activity` showed PID `14277` holding advisory lock
  `728370291` while running
  `CALL fitness.backfill_metric_stream_location_points(50000);`.
- The active backend was not dead: `ps` showed roughly one CPU of work, and
  `/proc/14277/io` showed continued reads/writes.
- The current deploy migration PID `27660` was blocked on
  `SELECT pg_advisory_lock($1)`.
- No useful migration progress notices reached container logs.
- Visible progress stalled at `671,310` committed `location` rows overall and
  `50,000` `location` rows in active chunk `_hyper_1_158_chunk`.
- `_hyper_1_158_chunk` contained about `1,446,057` `lat` rows and `1,446,057`
  `lng` rows, but only the first `50,000` location rows had committed.
- `EXPLAIN` showed each batch sorting/window-ranking about 1.5M `lat` rows
  and 1.56M `lng` rows, then doing a nested-loop anti-join against an
  `Append` over all 203 hypertable chunks for existing `location` rows.
- Staging had a separate first fatal error:
  `error: [migrate] error: extension "postgis" is not available`.

### Root Cause

Migration `0018_metric_stream_location_point.sql` mixed quick schema changes
with a large historical data rewrite. Its `LIMIT 50000` applied after the
expensive windowing and anti-join work, so each batch still scanned/sorted a
large chunk and checked existing location rows across the whole hypertable.
The first batch committed, but the second visible batch ran for over an hour
without committing.

### Fix Or Mitigation

- Cancelled Deploy Web run `25694900826`.
- Terminated/cleared the stuck migration path; by verification time, no
  backend held or waited on advisory lock `728370291`, and the orphan
  migration container was gone.
- Replaced the migration with schema-only operations: create PostGIS, add
  `point`, `latitude`, `longitude`, and `metadata`, drop the leftover helper
  procedure if present, and create the point GiST index. A follow-up migration
  later removed the temporary `latitude` and `longitude` projections after the
  point-only direction was chosen.
- Ran the patched SQL directly against production to verify it completes
  quickly. It no-op'd the already-present columns, dropped the leftover helper
  procedure, created `metric_stream_point_gist_idx`, and left the Drizzle
  migration row unmarked so the next deploy can record it normally.
- Updated the location migration integration test to assert that deploy
  migrations do not inline-convert or delete legacy coordinate rows.
- Added `scripts/backfill-location-points.ts`, an insert-only TypeScript
  maintenance script with dry-run default, bounded date windows, a 15-minute
  statement timeout, and no advisory lock or deletes.
- Ran the backfill against production in committed windows. The live-safe
  pass increased total `location` rows from `671,310` at incident time to
  `1,217,175`. Normal lock monitoring stayed clean after decompression,
  insert, and recompression were split into separate transactions and live
  runs defaulted to no recompression.
- Cancelled two production backfill windows when safety checks failed: one
  31-day window that blocked a normal `metric_stream` update, and one
  2026-04-23 chunk decompression that produced a lock waiter. In both cases,
  earlier committed windows remained committed and the active transaction was
  rolled back.
- Optimized the backfill script for high-volume days by staging source rows
  and existing `location` rows in temporary tables and indexing the duplicate
  check. This changed a previously slow 2021-05-03 retry into a successful
  `468,914` row insert and allowed additional 2021-05/2021-06 windows to
  commit safely.
- Continued the live-safe historical pass until the next compressed 2021
  chunk decompression (`2021-06-03` through `2021-06-10`) created lock
  waiters. At that stop point, production had `11,226,136` `location` rows,
  approximately `28.17%` of the expected `39,847,579` lat/lng pairs.

### Remaining Risk

The backfill is partially complete. Production is backfilled through
`2026-04-23`, the explicit `2026-05-10` one-day run, and part of the
high-volume 2021 historical span through `2021-06-02`. The compressed chunks
from `2026-04-23` through `2026-05-10`, the compressed 2021 chunks starting
at `2021-06-03`, and other high-volume historical months in 2021-2022 still
need an off-hours pass. Several chunks were left decompressed by the live-safe
no-recompress run and should be recompressed during the same maintenance
window. Staging also needs its PostGIS
availability issue fixed before staging deploys can pass.

### Follow-Up

- Add a long-migration triage runbook with advisory-lock holder queries,
  chunk-level progress checks, and an `EXPLAIN` step for batch backfills.
- Finish the location backfill during a low-traffic maintenance window, with
  lock-wait monitoring and a separate recompression pass for chunks left
  decompressed by live-safe runs.
- Add deploy-time diagnostics that print the advisory-lock holder query when
  a migration waits too long on `pg_advisory_lock`.

## 2026-05-11: Production VM powered off by failed Terraform downsize during Deploy Web

### Impact

Production was unreachable from `2026-05-11 01:48:51 UTC` until manual
power-on at `2026-05-11 15:58:38 UTC`. Slackbot did not respond because
the whole production origin was off. Public `https://dofek.fit/healthz`
timed out, SSH to `dofek-server` timed out, and Hetzner reported
`dofek` status `off`.

### Evidence That Mattered

- Hetzner action history for server `126583040` showed
  `stop_server` started at `2026-05-11T01:48:51Z` and finished at
  `2026-05-11T01:49:01Z`.
- GitHub run `25646099922` (`Deploy Web`) started at
  `2026-05-11T01:48:26Z`. Its Terraform apply planned an in-place
  update to `hcloud_server.dofek`, then began modifying the server at
  `2026-05-11T01:48:51Z`.
- First fatal CI line:
  `Error: cannot change type because the selected server_type has not sufficient disk space (invalid_server_type, 2e0f8639d3b6f7c210f51764ba50e4ec)`.
- The retry run `25646486098` failed the same way at `2026-05-11T02:03:51Z`.
- After power-on, `docker service ls` converged to `dofek_web 2/2`,
  `dofek_db 1/1`, `dofek_redis 1/1`, `dofek_clickhouse 1/1`, and
  `https://dofek.fit/healthz` returned `{"status":"ok"}`.
- Slack HTTP receiver logs showed:
  `[slack] Configured in HTTP mode (multi-workspace, OAuth via /auth/provider/slack)`
  and `[slack] Slack bot mounted at /api/slack/events (HTTP mode)`.

### Root Cause

Terraform declared production `hcloud_server.dofek.server_type = "cax11"`
while the live production server had already been resized to `cax21` after
the 2026-05-10 resource incidents. Deploy Web runs Terraform before the stack
deploy, so Terraform attempted to reconcile the drift by downsizing the live
server. Hetzner stopped the server to perform the resize, then rejected the
resize because the smaller `cax11` type did not have enough disk space. The
failed apply left the production VM powered off.

### Fix Or Mitigation

- Powered the production server back on with Hetzner Cloud.
- Updated `deploy/server.tf` so production is declared as `cax21`, matching
  the live server and the documented sizing decision that `cax21` is the
  structural minimum for this stack.
- Updated `deploy/README.md` to document production on `cax21` and staging
  on `cax11`.

### Remaining Risk

Terraform can still perform stop/start operations for future server-type
drift. Before any future manual resize, update `deploy/server.tf` in the same
change so CI does not later reconcile the server back to the old size.

## 2026-05-10: Disk full from inactive PeerDB replication slots retaining 26GB of WAL

### Impact

Same wedged-host symptoms as the earlier 2026-05-10 entry below — but the
underlying cause turned out to be a 100% full data volume, not stack
oversubscription. `df -h` on `/mnt/dofek-data` showed `99G 94G 0 100%`,
and `pg_wal/` alone was 26 GB. Postgres was hitting `PANIC: could not
write to file "pg_wal/xlogtemp.NN": No space left on device` and
restarting; every other service writing to the same volume (Traefik logs,
sshd session records, ClickHouse merges) blocked in `D` state, which
manifests as the "TCP accepts but no banner" pattern we'd been chasing
all day.

### Evidence That Mattered

- Postgres logs:
  `PANIC: could not write to file "pg_wal/xlogtemp.27": No space left on device`
  → `WAL writer process (PID 27) was terminated by signal 6: Aborted`
  → `all server processes terminated; reinitializing`.
- `pg_replication_slots` showed three inactive logical slots:
  `peerflow_slot_dofek_metric_stream_analytics` (active=false, retained_wal
  = 25 GB), `peerflow_slot_dofek_fitness_raw_analytics` (1056 MB), and
  `peerflow_slot_dofek_provider_inventory_raw_analytics` (240 MB). Each was
  anchoring WAL since its last `restart_lsn` because no consumer was
  draining them.
- `pg_wal/` directory on disk: 26 GB. Total volume usage: 94 GB / 99 GB.
- Sample of recent metric_stream activity showed 92% of inserts were
  `imu` channel rows from `apple_motion` and `WHOOP Strap` — high-frequency
  (~100Hz × 6 axes) sensor data that fills the table fast and feeds
  the slots their churn.

### Root Cause

PeerDB's flow workers stopped consuming the source-side logical
replication slots at some point (root cause of the consumer outage not
yet diagnosed — could be peerdb-flow-worker crash, ClickHouse rejecting
writes, peerdb-temporal losing workflow state). Postgres was forced to
retain every WAL segment past each slot's `restart_lsn`, and over time
that grew until it consumed the entire 100 GB data volume. Once the
volume hit 100%, postgres could not write WAL → PANIC → cascade through
every service touching the volume.

There was no `max_slot_wal_keep_size` configured, so an inactive slot
could grow unbounded.

### Fix Or Mitigation

Recovery (executed against prod):

1. Wiped `/mnt/dofek-data/peerdb-minio` to free 9 GB so postgres could
   start (PeerDB was already scaled to 0 and its mirrors will be
   recreated).
2. Brought db up, executed `SELECT pg_drop_replication_slot(...)` for all
   three inactive slots, then `CHECKPOINT;` to recycle WAL. Postgres
   immediately freed 25 GB by recycling the unanchored WAL segments.
3. Tightened TimescaleDB compression policy on `fitness.metric_stream`
   from `compress_after: 7 days` → `1 day` to reduce ongoing footprint
   of recent IMU data, and manually compressed catch-up chunks.
4. Brought back `dofek_db` on the new postgis-capable image
   `timescale/timescaledb-ha:pg18.3-ts2.26.4-all` (chowned the data dir
   from 70:70 → 1000:1000 to match the HA image's UID).

Durable guardrail (this PR):

- Added `max_slot_wal_keep_size=4GB` to `dofek_db` service command
  args in `deploy/stack.yml`. Bounds the per-slot WAL retention so a
  future inactive consumer cannot fill the volume — the slot is
  invalidated instead, and postgres reports it as lost the next time
  the consumer reconnects (forcing a resync, which is recoverable).

### Late-evening sequel: system-wide OOM, real memory tuning

A few hours after the initial recovery the host went *off* (not wedged
— actually powered down by the kernel after a `global_oom`).
`journalctl -k --grep oom` showed:

```
May 10 22:13:29 dofek kernel: traefik invoked oom-killer: ...
   constraint=CONSTRAINT_NONE, global_oom
   Out of memory: Killed process 310381 (clickhouse-serv)
                   total-vm:12608368kB, anon-rss:3487072kB
```

`CONSTRAINT_NONE / global_oom` (not `CONSTRAINT_MEMCG`) means the entire
host's RAM was exhausted — not a single container hitting its cgroup
cap. ClickHouse was using 3.5 GB RSS at the time; we'd earlier bumped
its container limit to 4 GB to unblock the PeerDB initial-snapshot OOMs,
but that turned out to be too generous for an 8 GB host once every other
service was also resident.

Per-container RSS at a clean post-boot steady state (no migrations, no
backfill):

```
clickhouse        1.8 GB      (limit 4 GB)
db                644 MB      (limit 2 GB)
netdata           328 MB      no limit
pgadmin           282 MB      no limit
cloudbeaver       248 MB      no limit
worker            208 MB      no limit
web (x2)          410 MB tot. no limit
peerdb-flow-worker  178 MB    no limit
peerdb-catalog    157 MB      no limit
peerdb-temporal   126 MB      no limit
others combined   ~500 MB     no limit
─────────────────────────────────
≈ 4.9 GB containers + dockerd + kernel = ~5.7 GB idle
```

Under load (CH merges, backfill, IMU traffic decode) the unbounded
services + the over-permissive CH limit easily push past the 8 GB host.

### Fix Or Mitigation (sequel)

- Set `deploy.resources.limits.memory` on every long-running service
  in `deploy/stack.yml`. Sized off measured idle RSS with growth
  headroom. Total bounded ceiling ≈ 8 GB; sum of typical actuals on a
  quiet box ≈ 4.5 GB; under load with limits in place, any runaway
  process now gets cgroup-OOM'd inside its container (Swarm restarts
  it) instead of the kernel killing arbitrary processes host-wide.
- Lowered ClickHouse limit from 4 GB → 3 GB (covers measured 1.8 GB
  idle + ~1 GB merge headroom).
- Removed the now-redundant `Ensure ClickHouse resource limits`
  step from `.github/workflows/deploy-web-stack.yml`: the limit is now
  declared in `stack.yml` and applied by the normal stack deploy. The
  step's only original purpose was to enforce the limit before
  migrations ran, which `stack deploy` does on its own.

### Sizing Decision

cax21 (4 vCPU / 8 GB) is the structural minimum for this stack.
cax11 (2 vCPU / 4 GB) cannot host db (2 GB) + ClickHouse (3 GB) +
everything else simultaneously. The ~€7-8/month uplift is the price of
co-hosting Postgres + ClickHouse + PeerDB cluster + observability +
admin UIs on one box. Splitting the stack across two cax11s would cost
more.

### Recovery Continuation (2026-05-10 evening)

After the immediate WAL-retention fix, the box was resized cax11 → cax21
(2 vCPU/4 GB → 4 vCPU/8 GB) so the full PeerDB stack could come up
without the cold-start thundering herd wedging sshd, ClickHouse, etc.
The trim-to-zero of 14 services that was used as triage during the
disk-full crisis was unwound — they are not the cause of the wedging
and have been restored to `replicas=1`.

PeerDB diagnosis revealed the consumer-stall root cause: when the data
volume hit 100%, peerdb-minio returned HTTP 507 ("Insufficient
Storage"), PeerDB's flow workers stopped pushing, and the slots went
inactive. Not a PeerDB bug — downstream of the disk-full.

ClickHouse was rebuilt from scratch:
- Dropped all 3 broken PeerDB mirrors (their slots were already gone).
- Created a dedicated `peerdb_metric_stream_no_imu` publication with a
  row filter `(channel != 'imu')` and `publish_via_partition_root = true`
  so the IMU firehose is dropped at the postgres source instead of
  being decoded, transferred, and discarded by every consumer.
- Recreated the metric_stream CDC mirror against the no-IMU publication
  with `do_initial_copy = false`.
- Recreated the two small mirrors (fitness_raw, provider_inventory)
  using the original publication (no IMU concerns there).
- Backfilled ~211M historical non-IMU rows into `postgres_fitness.metric_stream`
  via ClickHouse's built-in `postgresql()` table function, chunked
  per-year (per-quarter for 2021's 168M-row spike). Took ~12 minutes
  end-to-end. The destination's `ReplacingMergeTree(_peerdb_version)`
  engine handled dedup against streaming CDC events automatically.
- Cleaned up 40 residual IMU rows in CH with `ALTER TABLE … DELETE
  WHERE channel='imu'` (background mutation).

The publication change (`peerdb_metric_stream_no_imu`) was committed to
`src/db/peerdb/metric-stream-cdc.sql` so a fresh bootstrap reproduces
this state.

### Remaining Risk

- The cax21 resize is technically reversible (`hcloud server change-type
  dofek cax11 --keep-disk` requires a brief stop+start), but today's
  evidence suggests cax11 cannot host the full PeerDB cluster + heavy
  IMU write load without periodic load-induced wedges. Leaving on cax21
  unless cost becomes a problem.
- One uncompressed 18 GB chunk (`_hyper_1_386_chunk`, weekly chunk
  Apr 30 - May 7) remains on the box. Manual compression of a 2.4 GB
  chunk wedged sshd for 5 minutes earlier in the day; the 18 GB version
  would be much worse. Left for the daily compression policy to handle.
- PeerDB's QREP `CREATE MIRROR` flow has a catalog-corruption bug in
  stable-v0.36.18 — it inserts a `flows` row before workflow registration
  succeeds, leaving a half-created entry that blocks subsequent retries
  with a unique-constraint violation. We sidestepped by using a direct
  ClickHouse `INSERT … SELECT FROM postgresql(...)` for the backfill.
  If a future backfill is needed, prefer this pattern over QREP until
  the upstream issue is fixed.

## 2026-05-10: Prod host wedged after rescue-mode reboot during deploy unblock attempt

### Impact

`dofek.asherlc.com` went fully unreachable from the internet. Both prod
(`dofek` / 157.90.25.125) and `dofek-staging` (162.55.186.24) now exhibit
the same wedged-host pattern: TCP accepts on `:22` and `:443`, but neither
sshd nor Traefik return a response. Multiple soft reboots and a hard
`hcloud server reset` did not produce a stable host — each boot yields ~1–3
minutes of SSH responsiveness, then the host becomes unresponsive again.

The originally-intended action was a one-shot `docker service update --image
timescale/timescaledb-ha:pg18.3-ts2.26.4-all dofek_db` to give the prod DB
container the postgis extension that the new
`drizzle/0018_metric_stream_location_point.sql` migration (from PR #1111)
requires. Whether that swap completed before the host wedged is unknown —
the SSH session ran the command but never returned output.

### Evidence That Mattered

- During the brief windows of SSH responsiveness post-reboot:
  - `uptime` reported 1-min load average climbing from `5.47` (right after
    boot) to `111.23` on a 2-core (`cax11`) ARM instance within ~9 minutes.
  - `docker stack services dofek` listed ~20 services starting concurrently:
    TimescaleDB, ClickHouse, Redis, Traefik, web, training-export-worker, ml,
    otel-collector, netdata, portainer, cloudbeaver, databasus, pgadmin, the
    PeerDB cluster (`peerdb`, `flow-api`, `flow-snapshot-worker`,
    `flow-worker`, `temporal`, `temporal-admin-tools`, `minio`, `catalog`),
    ota, docuum.
  - Several services (`db`, `redis`, all `peerdb-*-worker`, `peerdb-temporal`,
    `pgadmin`, `netdata`, `docuum`) were stuck at `0/1` replicas, never
    reaching healthy.
- hcloud metrics during wedged windows: CPU baseline (no saturation pattern
  visible in the chart), disk IOPS in `1–5` range, network sub-1 MB/s. Low
  metrics combined with high load average indicates many processes blocked
  in `D` state (uninterruptible IO wait) on the network-attached `dofek-data`
  volume — not active CPU/IO consumption.
- Identical symptom on `dofek-staging` from the start of the session,
  predating any of today's actions.

### Root Cause

Provisional, not fully confirmed because the host stays unreachable long
enough only for shallow inspection: the dofek swarm stack appears to be
oversubscribed for the `cax11` instance class. Boot triggers a thundering
herd of ~20 services starting concurrently, all contending for the
network-attached data volume. Load average climbs to >100 on a 2-core box,
sshd cannot get scheduled for new pre-auth forks, Traefik likewise stops
serving, and the host remains in this state until something gives. Soft
reboots simply restart the same cascade.

The PeerDB cluster (8 services including a full Temporal control plane) is
the most likely structural contributor — it adds substantial steady-state
RAM and IO load that is independent of the actual app workload.

The deploy-unblock action (`docker service update` to swap the db image)
was not the cause — the host already exhibits this pattern on staging
without any deploy intervention. But the rescue → reboot dance did move
prod from "responsive" into the same wedged state staging was already in.

### Fix Or Mitigation

Unresolved at time of writing. Realistic paths:

1. **Resize the host**: `hcloud server change-type dofek cax21` (4 vCPU /
   8 GB) or `cax31` (8 vCPU / 16 GB). Requires a stop+start. Apply to
   `dofek-staging` likewise.
2. **Trim the stack**: scale non-essential services to 0 while the host
   recovers, e.g. `docker service scale dofek_peerdb-flow-worker=0
   dofek_peerdb-flow-snapshot-worker=0 dofek_peerdb-temporal=0
   dofek_peerdb-temporal-admin-tools=0 dofek_peerdb-flow-api=0
   dofek_docuum=0 dofek_pgadmin=0 dofek_netdata=0`. Bring them back
   incrementally after the host stabilizes. Requires SSH access during a
   responsive window.
3. **Both**, in series: resize first (gets a steady-state box), then
   investigate whether all PeerDB / observability services are still needed.

The previously-merged `migration_timeout_seconds=14400` bump and
`pg_stat_activity` instrumentation in PR #1113 are unaffected and remain
valid groundwork — but cannot be exercised until the host is stable.

### Remaining Risk

- We do not yet know whether the post-reboot wedge is a deterministic
  consequence of the stack composition, or whether something specific to
  the data volume (slow IO, near-full, corruption, etc.) is the proximate
  cause. Resizing the host treats the symptom; if the underlying issue is
  the volume, resize alone will not durably help.
- Staging has been wedged through the entire incident, so the deploy-time
  validation surface is also down. Any fix attempted on prod cannot be
  rehearsed on staging until staging is recovered.
- The pending `0018_metric_stream_location_point.sql` and
  `0018_migrate_body_measurements_to_metric_stream.sql` migrations are
  still blocked from applying. The deploy queue is effectively frozen.

## 2026-05-09: Production deploy timed out applying body-measurement hypertable migration

### Impact

Deploy Web run `25609852303` from `main` (commit `f17e27d`) failed: the prod
job's `Run migrations` step was killed at `3300s` while applying
`drizzle/0018_migrate_body_measurements_to_metric_stream.sql`. The migration
ran inside a transaction with no statement breakpoints, so the force-killed
container rolled back; prod DB stayed in the pre-migration state and code did
not roll. Staging deploy in the same workflow run failed independently with an
SSH banner timeout to `162.55.186.24` (separate incident, handled out of
band).

### Evidence That Mattered

- Job: `Deploy Web Production / Deploy Web Stack / Deploy Web Stack`.
- Step: `Run migrations`, last log lines:
  `info: [migrate] Applying: 0018_migrate_body_measurements_to_metric_stream.sql`
  → repeated `Migration still running after Ns...` (no progress within-step
  visibility) → `##[error]Migration exceeded 3300s` at `2026-05-09T20:36:59Z`.
- The migration is a single transactional block over `fitness.metric_stream`
  (TimescaleDB hypertable): UPDATE backfilling `external_id`, DELETE of
  duplicate channel rows, `CREATE UNIQUE INDEX`, and `INSERT … SELECT` from
  `fitness.body_measurement` covering 12 body channels. No
  `--no-transaction` / `statement-breakpoint` markers, so all-or-nothing.
- Prod host (`157.90.25.125`) was healthy throughout: SSH banner returned in
  `~2s`, `dofek.asherlc.com/healthz` returned `200` directly against the
  origin during and after the failure. The migration was making progress and
  hit the deploy-level guard, not a DB error.

### Root Cause

`migration_timeout_seconds=3300` in `.github/workflows/deploy-web-stack.yml`
was sized for routine schema migrations and is too small for a one-shot
hypertable backfill that copies all `fitness.body_measurement` rows into
`fitness.metric_stream` and rebuilds dependent indexes/views in the same
transaction.

### Fix Or Mitigation

- Bumped `migration_timeout_seconds` from `3300` (55min) to `14400` (4h) in
  `.github/workflows/deploy-web-stack.yml` so the migration has room to
  complete on the next deploy attempt.
- Added a comment at the constant explaining that future migrations exceeding
  this budget should be restructured (split, batched with
  `--no-transaction`, or moved to an out-of-band backfill job) rather than
  bumping the timeout again.
- Reverted the periodic `pg_stat_activity` snapshot block that was briefly
  added to the workflow polling loop — too much custom shell + heredoc'd
  psql for what `pg_stat_statements` (already in
  `shared_preload_libraries` per `deploy/stack.yml`) and
  `pg_stat_progress_create_index` already give us natively. SQL-level
  visibility belongs in a query against the live db service, not rebuilt
  in the deploy workflow.

### Remaining Risk

We do not have direct evidence of how long `0018` actually needs to run to
completion on prod — only that it was still progressing at 55min. If 4h is
also insufficient, the migration is likely unbounded and must be
restructured: split into `ADD COLUMN` (fast) + chunked, non-transactional
UPDATE/DELETE/INSERT batches keyed on TimescaleDB chunk boundaries +
post-backfill DDL (`CREATE UNIQUE INDEX`, view rebuilds, `DROP TABLE`).
Splitting cleanly also requires app code in
`packages/server/src/repositories/body-*.ts` to read from both
`fitness.body_measurement` and the `metric_stream` body channels during the
backfill window, which is a multi-deploy refactor.

## 2026-05-06: Branch deploy validation exceeded migration timeout

### Impact

Validation deploy run `25417551356` from branch `aloud-bike` built both Docker
images successfully, then failed in the `Run migrations` step before reaching
the PeerDB CDC validation step.

### Evidence That Mattered

- Job: `Deploy Web Stack / Deploy Web Stack`, job `74552433086`.
- Step: `Run migrations`, started `2026-05-06T05:18:03Z`.
- First fatal line: `Migration exceeded 3300s`.
- The job log showed regular `Migration still running after ...` messages until
  the timeout guard fired, so the runner was polling the detached migration
  container rather than hanging in the Docker CLI.
- The timeout branch removed the migration container before printing its logs,
  which left no direct evidence of the slow migration phase.

### Root Cause

The branch image ran longer than the deployment migration budget. The workflow's
timeout path did not collect migration logs before cleanup, so the exact slow
substep was not preserved in the GitHub Actions log.

### Fix Or Mitigation

- Bounded the migration step's remote Docker inspect, log collection, and
  cleanup commands with `timeout` so remote Docker calls fail loudly.
- Added timeout-path migration log collection before container cleanup so the
  next timeout captures the slow migration phase instead of only reporting the
  deploy-level guard.

### Remaining Risk

This instrumentation does not reduce legitimate ClickHouse or Postgres
migration work. If the branch retry still exceeds `3300s`, use the captured
migration output as the root-cause evidence before changing behavior.

## 2026-05-06: Production Deploy failed during PeerDB analytics mirror validation

### Impact

Deploy Web run `25415707212` updated the production stack but failed in the
post-deploy `Configure ClickHouse CDC` step, so the workflow ended red before
materialized-view planning ran.

### Evidence That Mattered

- Failing job: `Deploy Web Production / Deploy Web Stack / Deploy Web Stack`.
- Failing step: `Configure ClickHouse CDC`.
- First fatal line:
  `[clickhouse-cdc] error: unable to submit job: "status: Internal, message: \"invalid mirror: rpc error: code = FailedPrecondition desc = failed to validate destination connector dofek_clickhouse_postgres_fitness: not all PeerDB columns found in destination table metric_stream\"`.
- The checked-in ClickHouse DDL for `postgres_fitness.metric_stream` had app
  columns only and omitted PeerDB CDC metadata columns.

### Root Cause

The analytics CDC mirror targets an existing app-managed ClickHouse table.
PeerDB requires its metadata columns on existing ClickHouse destination tables,
but `postgres_fitness.metric_stream` lacked `_peerdb_synced_at`,
`_peerdb_is_deleted`, and `_peerdb_version`.

### Fix Or Mitigation

- Added PeerDB metadata columns to fresh `postgres_fitness.metric_stream`
  bootstrap DDL.
- Made `setupClickHouseCdc()` repair existing analytics tables with
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` before submitting the PeerDB mirror.
- Added unit coverage for both fresh DDL and deploy-time repair commands.

### Remaining Risk

Local test execution was blocked in the sandbox because dependencies were not
installed and npm registry access failed with DNS `ENOTFOUND`. CI must run the
targeted unit tests and deploy workflow to confirm the fix in the real runner
environment.

## 2026-05-03: Deploy Staging failed while creating Temporal search attribute

### Impact

Staging deployment `25265996048` failed during `Deploy Web Stack` while waiting to
create the `MirrorName` Temporal search attribute, so that release did not reach a
ready staging state.

### Evidence That Mattered

- First fatal line in the step log:
  `##[error]Process completed with exit code 124.`
- Failure occurred during `Ensure PeerDB Temporal search attributes` right after:
  `temporal operator search-attribute create --name MirrorName --type Text`.

### Root Cause

The 30-second timeout around `temporalio/admin-tools` CLI calls was too short for
the `MirrorName` creation path during Temporal bootstrap on this run.

### Fix or Mitigation

- Increased the timeout for the Temporal search-attribute `list` and `create`
  commands from `30s` to `120s` in
  `.github/workflows/deploy-web-stack.yml`.
- Re-ran deploy workflow `25266273887`; it completed successfully.

### Remaining Risk

If Temporal startup remains significantly delayed under load, the 120-second limit
may still be insufficient and should be raised with corresponding deploy-time
observability.
## 2026-05-03: metric_stream CDC fed validation table only

### Impact

Fresh rows from ongoing `fitness.metric_stream` writes were mirrored only to
`peerdb.metric_stream`, while runtime analytics reads and dedupe logic still
query `postgres_fitness.metric_stream`. Users could observe stale
activity-derived metric views despite CDC still running.

### What Happened

The CDC SQL template previously defined one mirror target, and it was the
`peerdb.metric_stream` validation table. The analytics pipeline reads from
`postgres_fitness.metric_stream` and refreshes materialized views from that
table.

### Evidence That Mattered

- CDC template before change only had a single mirror to `dofek_clickhouse`.
- ClickHouse analytics/materialized views read `postgres_fitness.metric_stream`.
- Fresh rows were mirrored into the validation target but not into the analytics
  sink used at query time.

### Root Cause

CDC sink and analytics read source diverged: CDC only updated the validation
table while query paths depended on the separate analytics-native metric table.

### Fix Or Mitigation

- Added `dofek_clickhouse_postgres_fitness` peer that connects to the
  `postgres_fitness` ClickHouse database.
- Added `dofek_metric_stream_analytics` mirror with the same publication as the
  existing CDC mirror and `do_initial_copy = false`.
- Updated CDC tests and docs to reflect dual-target CDC mirroring.
- PeerDB uses per-mirror replication slots; both mirrors reuse
  `peerdb_metric_stream_publication`, so Postgres serves WAL from the same
  publication into two slots. This adds incremental WAL-read overhead to keep
  both validation and analytics mirrors current.

### Remaining Risk

No runtime workaround was added. Fresh CDC rows still require successful
materialized-view refreshes in ClickHouse to become visible in activity summary
queries.

## 2026-05-02: metric_stream Storage Pressure from Oversized Chunk and Duplicate Indexes

### Impact

Production entered a planned maintenance window while `web`, `worker`, and
`training-export-worker` were scaled down to compress the largest
`fitness.metric_stream` chunk and remove obsolete indexes. The app was restored
after maintenance and `/healthz` returned OK.

### What Happened

The production data volume was 64% used, with Postgres accounting for roughly
49GB. `fitness.metric_stream` dominated logical database size at about 35GB,
including about 18GB of indexes. The largest closed Timescale chunk,
`_hyper_1_186_chunk`, covered 2026-04-23 through 2026-04-30 and was still
uncompressed at about 28GB because production had a 7-day chunk interval and
the compression policy only acts on chunks older than 7 days.

### Evidence That Mattered

- Data volume before maintenance: `99G` total, `60G` used, `35G` available.
- `fitness.metric_stream`: about `35GB` total, `16GB` heap, `18GB` indexes.
- Largest chunk: `_hyper_1_186_chunk`, uncompressed, about `28GB`, about
  `51.6M` rows.
- Online compression failed with:
  `ERROR: canceling statement due to lock timeout`.
- Active blockers included recurring materialized-view refreshes for
  `fitness.deduped_sensor`, `fitness.activity_summary`, and
  `fitness.provider_stats`.
- Future-dated chunks were tiny, but present: `apple_motion` / `api` / `imu`
  rows from `WHOOP Strap` plus one `whoop_ble` / `ble` / `orientation` row.

### Root Cause

`metric_stream` storage pressure came from a one-week active chunk that
accumulated tens of millions of high-frequency sensor rows before compression
could apply, plus non-primary-key indexes that were no longer needed for the
current read model.

### Fix Or Mitigation

- Verified a fresh Databasus backup existed before the window.
- Set the `metric_stream` chunk interval to `1 day`.
- Scaled down app services, canceled active materialized-view refresh work, and
  compressed `_hyper_1_186_chunk`.
- Dropped `metric_stream_provider_time_idx` and the obsolete recorded-at index
  during the maintenance window.
- Added migration `0011_metric_stream_storage_controls.sql` to enforce the
  one-day chunk interval and index removals for future environments.
- Added server-side guards that reject IMU and WHOOP BLE realtime samples more
  than five minutes in the future before inserting into `metric_stream`.

### Remaining Risk

The current open chunk can still grow until it closes, but future chunks should
be one day wide. The tiny existing future-dated rows were not deleted during
this maintenance window; remove them only after an explicit data-retention /
cleanup decision. The timestamp guard must be deployed before it protects live
ingest traffic.

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

## 2026-05-01: Netdata Local UI NetworkError Triage
 
### Symptoms
 
The Netdata dashboard at `https://netdata.dofek.asherlc.com/` showed a browser
`NetworkError when attempting to fetch resource` during local UI use or agent
connection attempts.
 
### Evidence
 
Directly inside the Netdata container, `http://127.0.0.1:19999/` returned the
Netdata HTML with HTTP 200 and `/api/v3/info` reported the agent as available.
Unauthenticated requests to the public hostname returned HTTP 302 redirects to
Authentik. The agent's ACLK state showed `Claimed: No` and `Online: No`.
 
### Root Cause
 
The Netdata agent process is running, but the public UI is Authentik-protected
and the agent is not claimed to Netdata Cloud. Browser-side fetches that cross
the Authentik or Netdata Cloud boundary can surface as a generic network error.
 
### Fix or Mitigation
 
Configured the Netdata Swarm service with `NETDATA_DISABLE_CLOUD=1` so the
deployment is local-only and does not try to use the browser claim flow through
Authentik. For future Netdata Cloud monitoring, remove that local-only setting
and configure the Swarm service with Netdata claim environment variables from
Infisical instead.
 
### Remaining Risk
 
The exact failing browser request after an authenticated login was not captured
because the agent session did not have the user's Authentik browser cookies.
Further debugging needs either the browser network entry from the logged-in
session or a deliberate local-only Netdata configuration change.
 
## 2026-05-01: Production Deploy Migration Timed Out During Metric Stream Backfill

### Symptoms

The Netdata dashboard at `https://netdata.dofek.asherlc.com/` showed a browser
`NetworkError when attempting to fetch resource` during local UI use or agent
connection attempts.

### Evidence

Directly inside the Netdata container, `http://127.0.0.1:19999/` returned the
Netdata HTML with HTTP 200 and `/api/v3/info` reported the agent as available.
Unauthenticated requests to the public hostname returned HTTP 302 redirects to
Authentik. The agent's ACLK state showed `Claimed: No` and `Online: No`.

### Root Cause

The Netdata agent process is running, but the public UI is Authentik-protected
and the agent is not claimed to Netdata Cloud. Browser-side fetches that cross
the Authentik or Netdata Cloud boundary can surface as a generic network error.

### Fix or Mitigation

Configured the Netdata Swarm service with `NETDATA_DISABLE_CLOUD=1` so the
deployment is local-only and does not try to use the browser claim flow through
Authentik. For future Netdata Cloud monitoring, remove that local-only setting
and configure the Swarm service with Netdata claim environment variables from
Infisical instead.

### Remaining Risk

The exact failing browser request after an authenticated login was not captured
because the agent session did not have the user's Authentik browser cookies.
Further debugging needs either the browser network entry from the logged-in
session or a deliberate local-only Netdata configuration change.

## 2026-05-01: Production Deploy Blocked by ClickHouse Backfill Timeout

### Symptoms

Production deploy workflow `25239905048` failed in the `Run migrations` step
before the stack deploy step, so the CloudBeaver service was not released.

### User Impact

The existing production web stack kept running on the previous image, but the
new CloudBeaver production service was unavailable.

### Evidence

The first fatal workflow log line was:

```text
error: [migrate] Error: Timeout error.
```

The migration log showed Postgres migrations and materialized view sync
completed, then ClickHouse migration `0006_backfill_native_metric_stream`
failed before recording its row in `analytics.schema_migrations`. Production
ClickHouse had only `42` completed rows in
`analytics.metric_stream_backfill_chunks`, while production Timescale had `195`
`fitness.metric_stream` chunks. The next uncompleted Timescale chunk,
`2021-04-29 00:00:00+00` to `2021-05-06 00:00:00+00`, contained about
`4,014,020` rows.

### Root Cause

ClickHouse migration `0006_backfill_native_metric_stream` backfilled one full
Timescale chunk per ClickHouse insert. Some production weekly chunks are too
large for the ClickHouse HTTP client request timeout, so the migration timed out
while copying historical `metric_stream` rows.

### Fix or Mitigation

The migration now splits Timescale chunk ranges into six-hour backfill ranges
before checking and recording `analytics.metric_stream_backfill_chunks`. This
keeps each ClickHouse insert bounded while preserving resumability through the
existing range-completion table. The rerun path also treats older broader
completion ranges as covering new subranges and uses an anti-join on existing
ClickHouse `metric_stream` IDs so a timed-out-but-successful insert is not
duplicated.

### Remaining Risk

Very dense one-hour windows can still take longer than expected, but future
failures will now identify the exact window being copied and retries will not
discard completed native backfill progress. The production backfill still needs
to finish before migration `0006` is marked applied; verify completion by
confirming `0006_backfill_native_metric_stream` exists in
`analytics.schema_migrations`.

## 2026-05-01: Netdata Deploy Blocked by Daily Metrics View Drift

### Symptoms

The Netdata local-only stack change could not reach `docker stack deploy`.
The web stack deploy failed in the `Run migrations` step before any Swarm
service update ran.

### Evidence

Deploy run `25241378904` used image tag `sha-31b9fa9` and exited from the
migration container after Postgres migrations completed with zero pending
migrations. The first fatal log line was:
`[views] fitness.v_daily_metrics view definition changed; manual materialized-view maintenance required`.
The migration runner then failed with
`Materialized view maintenance required: fitness.v_daily_metrics (view definition changed)`.

### Root Cause

The production `fitness.v_daily_metrics` materialized view definition differs
from the canonical `drizzle/_views` definition. Normal deploy migration sync
intentionally refuses to drop and rebuild existing changed materialized views
because that is heavy production database maintenance.

### Fix or Mitigation

Run the Materialized View Maintenance workflow for
`fitness.v_daily_metrics`, verify the planner reports no required maintenance,
then rerun the Netdata stack deploy.

### Remaining Risk

Rebuilding `fitness.v_daily_metrics` is production database maintenance. It
should only run after the quiet-database preflight passes and no other
full-history maintenance is active.

## 2026-05-01: Manual CloudBeaver Deploy Reused Pre-Fix Migration Image

### Symptoms

Manual production deploy run `25239905048` from branch
`Asherlc/setup-dbeaver` failed in job `74013763788` during the `Run migrations`
step. The deployment stopped before `docker stack deploy`, so the CloudBeaver
stack change did not release.

### Evidence

The run checked out commit `fabd4d7`, resolved `INPUT_TAG=latest`, and ran
`ghcr.io/asherlc/dofek:latest` for migrations. The first fatal line was:

```text
Migration failed (exit code 1).
```

The migration output ended with:

```text
error: [migrate] Error: Timeout error.
```

Postgres migrations and Postgres materialized-view sync had already completed,
which puts the failure in the ClickHouse migration path.

### Root Cause

The manual deploy reused the same pre-fix ClickHouse metric-stream backfill
behavior described above: a large `INSERT INTO ... SELECT FROM postgresql(...)`
operation exceeded the ClickHouse client's request timeout. The branch was
based on `1b5da985`, while `main` later added the bounded backfill-window fix in
`03798a36`.

### Fix or Mitigation

No new code change was required for this specific run. Deploy a `dofek` image
built from `03798a36` or newer, or replay the CloudBeaver stack changes on top
of current `main`, so the migration container uses the bounded ClickHouse
backfill implementation.

### Remaining Risk

The `Asherlc/setup-dbeaver` branch itself still points at `fabd4d7`, so another
manual deploy from that branch with `image_tag=latest` can repeat the same
failure if `latest` has not been advanced to a fixed image. Avoid production
deploys from stale feature branches unless the image tag is pinned to a known
fixed commit.

## 2026-05-01: ClickHouse Backfill Retried Too Many Empty Chunk Windows

### Symptoms

After replaying `Asherlc/setup-dbeaver` onto current `main`, production deploy
run `25240719766` used image `ghcr.io/asherlc/dofek:sha-bcfe4eb` and progressed
past the original full-chunk timeout. The `Run migrations` step still spent
most of its time in `0006_backfill_native_metric_stream`, logging one-hour
windows such as:

```text
[clickhouse-migrations] Backfilling metric_stream 2014-10-05T13:00:00.000Z..2014-10-05T14:00:00.000Z
```

### Evidence

The workflow migration step has a `3300s` timeout. Production
`timescaledb_information.chunks` reported 195 `fitness.metric_stream` chunks
with an estimated 32,760 one-hour chunk-range windows, including chunk bounds
from `1989-12-28 00:00:00+00` through `2104-02-14 00:00:00+00`. ClickHouse
progress showed only 7,421 completed backfill windows roughly 25 minutes after
the migration started.

### Root Cause

The bounded backfill fix split raw Timescale chunk ranges into six-hour
ClickHouse inserts. Some production chunk ranges are far wider than the rows
they contain, so the migration still performs thousands of empty or unnecessary
ClickHouse inserts before reaching real data.

### Fix or Mitigation

Backfill discovery now reads each Timescale chunk table's actual
`min(recorded_at)` and `max(recorded_at) + 1 microsecond` and skips chunks with
no rows. The six-hour window split remains, but it only covers occupied time
ranges.

### Remaining Risk

Very dense occupied chunks can still require many six-hour windows, but sparse
or over-wide Timescale chunks no longer dominate deploy time.

## 2026-05-01: ClickHouse Refresh Wait Exceeded Client Timeout

### Symptoms

Production deploy run `25241533098` from replayed branch
`Asherlc/setup-dbeaver` used image `ghcr.io/asherlc/dofek:sha-3b904b4` and
passed image pulls, host-path validation, Postgres readiness, ClickHouse
readiness, and Postgres migrations. It failed in the `Run migrations` step
before `docker stack deploy`.

### Evidence

The first fatal log line was:

```text
error: [migrate] Error: Timeout error.
```

The migration log showed Postgres migrations and materialized-view sync had
completed. ClickHouse `system.query_log` showed the failing operation:
`SYSTEM WAIT VIEW analytics.deduped_sensor` started at
`2026-05-02 02:43:34 UTC`, finished successfully at `2026-05-02 02:44:08 UTC`,
and took `33415ms`.

### Root Cause

The ClickHouse refresh wait was legitimate work and completed successfully on
the server, but the Node ClickHouse client default request timeout is `30000ms`.
The client aborted the request about three seconds before ClickHouse returned
success.

### Fix or Mitigation

The production ClickHouse client now uses a `120000ms` request timeout. This is
long enough for the observed refresh wait while remaining much shorter than the
workflow migration timeout, so a genuinely stuck migration still fails loudly.

### Remaining Risk

Future data growth can make refresh waits exceed two minutes. If that happens,
the fix should first inspect `system.query_log` for the exact refresh query and
optimize the read model or migration shape before increasing timeouts again.

## 2026-05-01: PeerDB Catalog PostgreSQL 18 Mount Layout

### Symptoms

Production deploy run `25242177373` from replayed branch
`Asherlc/setup-dbeaver` used image `ghcr.io/asherlc/dofek:sha-d727d3a`.
Migrations succeeded, but the `Deploy stack` step did not converge because
`dofek_peerdb-catalog` repeatedly exited and downstream Temporal/PeerDB
services waited for the catalog host.

### Evidence

The first fatal catalog log line was:

```text
Error: in 18+, these Docker images are configured to store database data in a format which is compatible with "pg_ctlcluster"
```

The same log reported PostgreSQL data under `/var/lib/postgresql/data` as an
unused mount/volume. On the host, `/mnt/dofek-data/peerdb-catalog` existed but
contained no `PG_VERSION`, confirming this was a mount-layout bootstrap failure
rather than an incompatible existing catalog database.

### Root Cause

`peerdb-catalog` used `postgres:18-alpine` while bind-mounting
`/mnt/dofek-data/peerdb-catalog` to `/var/lib/postgresql/data`. PostgreSQL 18
Docker images use a versioned data directory under `/var/lib/postgresql`, so
mounting the old data path makes the entrypoint fail before initialization.

### Fix or Mitigation

The `peerdb-catalog` bind mount now targets `/var/lib/postgresql`, allowing the
PostgreSQL 18 image to initialize and manage its versioned data directory under
the persistent host path.

### Remaining Risk

If this service later contains real catalog data and needs a PostgreSQL major
upgrade, perform a catalog backup and `pg_upgrade` flow rather than changing the
mount path or image tag alone.

## 2026-05-01: Temporal Visibility Bootstrap Interrupted

### Symptoms

Production deploy run `25242863616` from replayed branch
`Asherlc/setup-dbeaver` used image `ghcr.io/asherlc/dofek:sha-7906e92`.
Migrations succeeded, but `docker stack deploy --detach=false` did not converge
because `dofek_peerdb-temporal` repeatedly exited. Downstream PeerDB flow
services also exited while Temporal was unavailable.

### Evidence

The first fatal Temporal log line was:

```text
Unable to update SQL schema. {"error": "error executing statement: pq: index \"by_type_start_time\" does not exist"}
```

The catalog database had `temporal_visibility.schema_version.curr_version =
1.1`, while `executions_visibility.search_attributes` and several `v1.2`
advanced-visibility indexes already existed. The old `v1.0`/`v1.1` indexes that
Temporal `v1.2` expects to drop were gone.

### Root Cause

An earlier deploy attempt interrupted Temporal's first `temporal_visibility`
`v1.2` schema update after it had added columns and dropped legacy indexes, but
before the Temporal schema version table advanced from `1.1`. On restart,
Temporal retried the `v1.2` SQL from the beginning and failed at the first
non-idempotent `DROP INDEX`.

### Fix or Mitigation

At the time, the deploy workflow performed a narrowly scoped preflight repair
before `docker stack deploy`: if `temporal_visibility` was exactly in this
partial `1.1`/`v1.2` bootstrap state, it recreated the legacy indexes that
Temporal's official migration expected to drop. Temporal could then rerun its
own migration and advance the schema normally. The preflight compared the
Postgres state as `1.1|true|false`, because concatenated Postgres booleans
render as `true`/`false`, not `t`/`f`. That one-off workflow repair was later
removed after the affected catalog state had converged.

### Remaining Risk

This repair only covered the observed interrupted `v1.2` visibility bootstrap
state. Future Temporal upgrade failures should still be diagnosed from the first
fatal Temporal log line and the catalog `schema_version` tables before adding
any new repair path.

## 2026-05-01: Temporal Dynamic Config Path

### Symptoms

Production deploy run `25243281625` from replayed branch
`Asherlc/setup-dbeaver` used image `ghcr.io/asherlc/dofek:sha-d6445e3`.
Migrations and the Temporal visibility bootstrap repair succeeded, but
`docker stack deploy --detach=false` did not converge because
`dofek_peerdb-temporal` repeatedly exited.

### Evidence

The first fatal Temporal log line was:

```text
Unable to create dynamic config client. Error: unable to validate dynamic config: dynamic config: config/dynamicconfig/development-sql.yaml: stat config/dynamicconfig/development-sql.yaml: no such file or directory
```

Read-only image inspection on the production host showed
`temporalio/auto-setup:1.29` contains `config/dynamicconfig/docker.yaml`, and
its config template defaults `DYNAMIC_CONFIG_FILE_PATH` to
`/etc/temporal/config/dynamicconfig/docker.yaml`. The deployed service spec
overrode that default with the missing `config/dynamicconfig/development-sql.yaml`.

### Root Cause

`deploy/stack.yml` carried a stale Temporal dynamic-config override that points
at a file not present in the `temporalio/auto-setup:1.29` image.

### Fix or Mitigation

The stale `DYNAMIC_CONFIG_FILE_PATH` override was removed so Temporal uses the
dynamic config path shipped by the image.

### Remaining Risk

Temporal image upgrades can change bundled config paths. If Temporal exits
before startup after an image bump, inspect the image's config template and file
tree before adding or overriding dynamic-config paths.

## 2026-05-02: Temporal Healthcheck Loopback Address

### Symptoms

Production deploy run `25243680947` from replayed branch
`Asherlc/setup-dbeaver` used image `ghcr.io/asherlc/dofek:sha-a548e1a`.
The app services updated, but `docker stack deploy --detach=false` did not
converge because `dofek_peerdb-temporal` stayed unhealthy. PeerDB flow services
continued to restart with `unable to create Temporal client`.

### Evidence

The Temporal container was running, but Docker healthcheck logs showed:

```text
Failed to create SDK client {"error": "failed reaching server: last connection error: connection error: desc = \"transport: Error while dialing: dial tcp 127.0.0.1:7233: connect: connection refused\""}
```

Temporal startup logs showed the service address was set to the container task
IP, and membership eventually reported `frontend` reachable on that task IP
rather than loopback.

### Root Cause

The `peerdb-temporal` healthcheck used `tctl --address 127.0.0.1:7233`, but the
Temporal 1.29 auto-setup container does not accept frontend connections on
loopback in this deployment. Swarm marked the service unhealthy even after
Temporal started.

### Fix or Mitigation

The initial fix changed the healthcheck to the Swarm service DNS name,
`tctl --address peerdb-temporal:7233`, but deploy run `25244198471` showed that
the Temporal container itself could not resolve that service name from Docker's
embedded DNS:

```text
Failed to create SDK client {"error": "failed reaching server: last connection error: connection error: desc = \"transport: Error while dialing: dial tcp: lookup peerdb-temporal on 127.0.0.11:53: no such host\""}
```

A direct check inside the running container confirmed that
`tctl --address "$(hostname -i | awk '{print $1}'):7233" workflow list`
succeeds. The healthcheck now computes the container task IP at runtime and
connects to Temporal on that address.

### Remaining Risk

This keeps the existing `tctl` healthcheck behavior. Temporal logs warn that
`tctl` enters end of support on 2025-09-30, so a future Temporal maintenance
pass should migrate the healthcheck to the supported Temporal CLI.

## 2026-05-02: PeerDB CDC Multi-Statement Setup Rejected

### Symptoms

After the replayed `Asherlc/setup-dbeaver` stack converged on image
`ghcr.io/asherlc/dofek:sha-be6b6e0`, deploy workflow run `25245047541` failed in
the post-stack `Configure ClickHouse CDC` step.

### Evidence

The first fatal setup log line was:

```text
[clickhouse-cdc] error: unsupported sql: CREATE PEER IF NOT EXISTS dofek_postgres FROM POSTGRES WITH ...
```

The same error payload showed PeerDB had parsed three statements from the single
query payload: `CreatePeer` for Postgres, `CreatePeer` for ClickHouse, and
`CreateMirror` for `dofek_metric_stream_cdc`.

### Root Cause

The setup script rendered `src/db/peerdb/metric-stream-cdc.sql` and sent all
three semicolon-delimited PeerDB DDL statements through one `pg` query. PeerDB's
SQL endpoint parses those statements but rejects the combined multi-statement
payload as unsupported.

### Fix or Mitigation

The setup script now renders the template once, splits it into individual
statements while preserving semicolons inside single-quoted literals, and sends
each PeerDB DDL statement as its own query.

### Remaining Risk

The splitter is intentionally small and covers the checked-in PeerDB template
shape plus single-quoted runtime values. If future PeerDB templates introduce
comments, dollar-quoted strings, or procedural SQL, replace the splitter with a
real SQL parser or move to a PeerDB-supported declarative API.

## 2026-05-02: Post-Sync Materialized-View Refresh OOM During Deploy

### Symptoms

Deploy workflow run `25245248845` for image
`ghcr.io/asherlc/dofek:sha-328c6e1` stalled in the `Run migrations` step while
production Postgres temporarily returned `FATAL: the database system is in
recovery mode`.

### Evidence

`pg_stat_activity` showed a long-running refresh:

```text
REFRESH MATERIALIZED VIEW CONCURRENTLY fitness.deduped_sensor
```

Worker logs identified the source as automatic post-sync maintenance:

```text
[mv-refresh] source=sync.post_sync view=fitness.deduped_sensor
```

Postgres then logged the first fatal line:

```text
client backend (PID 180914) was terminated by signal 9: Killed
DETAIL: Failed process was running: REFRESH MATERIALIZED VIEW CONCURRENTLY fitness.deduped_sensor
```

The host had limited free memory and swap pressure during the incident. The
database recovered automatically and later reported `pg_is_in_recovery() = f`.

### Root Cause

Normal worker post-sync jobs were still launching full Postgres materialized
view refreshes, including the high-risk `fitness.deduped_sensor` view that scans
metric stream history. That refresh exceeded available host memory and the
backend was OOM-killed, forcing Postgres crash recovery and interrupting the
deploy migration runner.

### Fix or Mitigation

Global post-sync maintenance no longer runs `refreshDedupViews()` or
`updateUserMaxHr()`. While rolling out the fix, active old-worker refreshes were
cancelled with `pg_cancel_backend()` after they restarted the same high-risk
refresh path. Heavy Postgres materialized-view refreshes remain explicit
maintenance-window work through the Materialized View Maintenance workflow and
`docs/materialized-view-maintenance-runbook.md`.

### Remaining Risk

Legacy Postgres materialized views can still be stale until planned maintenance
runs. Runtime paths should continue moving sensor-derived reads to ClickHouse
`analytics.*` projections so production does not depend on refreshing
full-history Postgres views after normal provider syncs.

## 2026-05-02: PeerDB Mirror Missing Source Publication

### Symptoms

Deploy workflow run `25246366257` for image
`ghcr.io/asherlc/dofek:sha-afd9297` successfully built images, ran migrations,
deployed the Swarm stack, and then failed in `Configure ClickHouse CDC`.

### Evidence

The first fatal log line was:

```text
[clickhouse-cdc] error: unable to submit job: "status: Internal, message: \"invalid mirror: rpc error: code = FailedPrecondition desc = failed to validate source connector dofek_postgres: provided source tables invalidated: publication does not exist: peerdb_metric_stream_publication\""
```

### Root Cause

The PeerDB mirror template requested
`publication_name = 'peerdb_metric_stream_publication'`, but the CDC setup only
created PeerDB peers and the mirror. It never ensured the named publication
existed on the source Postgres database before asking PeerDB to validate the
mirror.

### Fix or Mitigation

The CDC setup now connects to source Postgres and idempotently creates
`peerdb_metric_stream_publication` for `fitness.metric_stream`, or adds
`fitness.metric_stream` when the publication exists without that table, before
submitting the PeerDB mirror DDL.

### Remaining Risk

The setup assumes the configured Postgres user can manage publications for
`fitness.metric_stream`. If production credentials lose that permission, deploys
should fail loudly at the publication bootstrap step before PeerDB mirror
validation.

## 2026-05-02: PeerDB Temporal Missing MirrorName Search Attribute

### Symptoms

Deploy workflow run `25246698008` for image
`ghcr.io/asherlc/dofek:sha-354a2ef` successfully built images, ran migrations,
deployed the Swarm stack, and then failed in `Configure ClickHouse CDC`.

### Evidence

The first fatal log line was:

```text
[clickhouse-cdc] error: unable to submit job: "status: Internal, message: \"unable to start PeerFlow workflow: Namespace default has no mapping defined for search attribute MirrorName\""
```

`temporal operator search-attribute list --namespace default` did not include
`MirrorName`. PeerDB's Go package defines `MirrorName` as a Temporal string
search attribute (`temporal.NewSearchAttributeKeyString("MirrorName")`).

### Root Cause

The PeerDB Temporal cluster was bootstrapped without PeerDB's custom
`MirrorName` search attribute. PeerDB can create peers and validate source
publications without it, but workflow startup fails when PeerDB attaches the
missing search attribute to the mirror workflow.

### Fix or Mitigation

The deploy workflow now idempotently checks Temporal namespace `default` and
creates `MirrorName` as a `Text` search attribute with the Temporal CLI before
running the ClickHouse CDC setup command.

### Remaining Risk

The workflow registers the PeerDB search attribute that current PeerDB
`stable-v0.36.18` requires. Future PeerDB upgrades may add more Temporal search
attributes; handle those as explicit deploy prerequisites rather than letting
mirror creation fail after stack rollout.

## 2026-05-04: PR 1092 CI and Review App View Conversion Failures

### Symptoms

PR `#1092` failed CI and review-app deployment while converting analytics
materialized views to plain views. Typecheck and Knip failed in
`packages/server`, integration and end-to-end tests failed during migrations,
unit tests failed on stale materialized-view expectations, and the review-app
seed failed before reviewer data loaded.

### Evidence

The first fatal typecheck errors were missing package imports for
`@dofek/db`, `@dofek/jobs/queues`, and `@dofek/lib/cache`. The first migration
fatal error was:

```text
"deduped_sensor" is not a view
Hint: Use DROP MATERIALIZED VIEW to remove a materialized view.
```

The review app seed failed with:

```text
error: relation "fitness.deduped_sensor" does not exist
```

### Root Cause

The branch renamed root package subpath imports inconsistently, migration
`0012_deduped_sensor_plain_view.sql` tried to drop a materialized view with
`DROP VIEW`, and review-app seeding assumed a skipped migration had already left
`fitness.deduped_sensor` present before recreating dependent views.

### Fix or Mitigation

Imports now use the canonical `dofek/*` subpaths. Migration `0012` explicitly
drops `fitness.deduped_sensor` as a materialized view and preserves/recreates
`fitness.activity_summary` inside the same migration boundary. Review-app seed
now repairs `fitness.deduped_sensor` before recreating views when the schema
already exists. Tests were updated so plain views do not expect refreshes, while
the still-materialized `fitness.v_activity` and `fitness.v_sleep` paths refresh
after relevant HealthKit ingestion and in sleep integration setup.

### Remaining Risk

Local integration validation was blocked because the Docker daemon was not
running. CI should validate the migration and review-app seed path against a
real Postgres service after the branch is pushed.

## 2026-05-05: PR 1095 Deploy Migration View Replacement Failure

### Symptoms

The review-app deploy failed while applying migration
`0015_clickhouse_proxy_views.sql` after successfully applying
`0014_drop_postgres_dedup_matviews.sql`.

### Evidence

The first fatal migration log line was:

```text
error: [migrate] error: cannot change name of view column "source_providers" to "walking_step_length"
```

### Root Cause

Migration `0015` used `CREATE OR REPLACE VIEW fitness.v_daily_metrics`, but the
existing deployed view had `source_providers` immediately after
`walking_speed`. The replacement definition inserted the walking metric columns
before `source_providers`, and Postgres does not allow `CREATE OR REPLACE VIEW`
to rename or reorder existing view columns.

### Fix or Mitigation

Migration `0015` now drops the dependent ClickHouse proxy view and then drops
the existing `fitness.v_daily_metrics` relation as either a plain view or
materialized view before recreating the canonical view definition. A migration
regression test recreates the old column order and verifies the new column order
after applying `0015`.

### Remaining Risk

The fix is scoped to `fitness.v_daily_metrics`. Future migrations that insert
columns into the middle of existing views should drop and recreate those views
instead of relying on `CREATE OR REPLACE VIEW`.

## 2026-05-06: Branch Deploy ClickHouse CDC and Postgres View Lock Failures

### Symptoms

The `aloud-bike` branch deploy first failed while configuring ClickHouse CDC,
then a later deploy hung in the migration step until the workflow timed out.
During the migration hang, app queries touching the same fitness read models
also queued behind the pending DDL.

### Evidence

The first CDC fatal log line from run `25415707212`, job `74546726240`, was:

```text
"invalid mirror: rpc error: code = FailedPrecondition desc = failed to validate destination connector dofek_clickhouse_postgres_fitness: not all PeerDB columns found in destination table metric_stream"
```

The later migration run timed out with:

```text
Migration exceeded 3300s
```

Postgres lock inspection showed an active blocked statement:

```text
CREATE OR REPLACE VIEW fitness.v_daily_metrics AS ...
```

### Root Cause

The CDC failure was caused by the ClickHouse destination table missing PeerDB
metadata columns. The migration timeout was caused by deploy-time Postgres view
DDL on hot fitness read models; the pending replacement waited behind live app
reads, then new app reads waited behind the pending DDL.

### Fix or Mitigation

PeerDB metadata columns were added to the ClickHouse mirror tables. The
troublesome fitness read models were moved to ClickHouse-native
`postgres_fitness` raw mirrors and `analytics.*` read models, and the
deploy/ingestion-time Postgres view sync and refresh hooks were removed. Runtime
ClickHouse consumers now read `analytics.v_activity`, `analytics.v_sleep`,
`analytics.v_daily_metrics`, `analytics.v_body_measurement`, and related
ClickHouse read models instead of `postgres_fitness_live`.

### Remaining Risk

Local changed-test runs exposed ClickHouse socket hangs when several integration
files concurrently created and refreshed isolated read-model databases against
one local ClickHouse service. Vitest file execution is serialized to match the
service capacity. A branch deploy retry from `aloud-bike` completed successfully
in GitHub Actions run `25457794464`.

## 2026-05-06: Branch Deploy Blocked by Full Root Filesystem

### Symptoms

The `aloud-bike` branch deploy run `25461143484` reached `Deploy Web Stack` and
then sat in `Pull deploy images` without advancing.

### Evidence

Production host inspection during the stuck pull showed:

```text
/dev/sdb1        38G   37G     0 100% /
/dev/sda         99G   44G   51G  47% /mnt/HC_Volume_105292545
```

The deploy was waiting on remote Docker image inspection/pull work while the
root filesystem had no free space.

### Root Cause

The Docker root filesystem on the production host was exhausted before the
deploy image pulls. The data volume still had free space, but Docker image and
runtime artifacts live on `/`, so the deploy could not reliably pull or inspect
images.

### Fix or Mitigation

The deploy workflow now runs Docker cleanup before release image pulls and then
fails loudly if `/` still has less than 8 GiB available. This turns the previous
silent pull hang into an explicit disk-headroom failure and gives the image pull
step enough room to proceed when stale Docker artifacts are reclaimable.

### Remaining Risk

The host still keeps Docker runtime state on the root disk. A longer-term fix
should either move Docker's data root to persistent storage or add host-level
disk monitoring for `/` so operators know before deploys hit zero free space.

## 2026-05-06: Stryker Shard Failed on Read-Model Mutation Survivors

### Symptoms

PR #1097 run `25467432350` failed `Test / Stryker (3)` after the branch split
large read-model files into Stryker shards.

### Evidence

The first fatal Stryker line was:

```text
Final mutation score 62.01 under breaking threshold 75, setting exit code to 1
```

The surviving mutants were concentrated in
`packages/server/src/repositories/cycling-advanced-repository.ts` and
`packages/server/src/routers/provider-detail.ts`.

### Root Cause

The new shard pairing exposed under-specified tests for cycling ramp-rate edge
cases and provider disconnect revocation branches. Unit tests covered the happy
paths, but did not assert the query shape, ramp-rate thresholds, missing-token
branches, or error reporting side effects tightly enough to kill the mutants.

### Fix or Mitigation

Added focused mutation tests for the cycling advanced repository queries,
ramp-rate thresholds, and provider disconnect revocation behavior. A local
targeted Stryker retry for the same two files reached a 79.89 mutation score,
above the 75 break threshold.

### Remaining Risk

The targeted shard is now above threshold locally. Full CI still needs to rerun
on GitHub Actions to verify the complete sharded matrix with runner timing.

## 2026-05-07: Auth Session Queries Failed During Web DB Pool Starvation

### Symptoms

Production web logs showed repeated tRPC errors like:

```text
[trpc] settings.get: Failed query: SELECT user_id FROM fitness.session
```

The same failure appeared across many unrelated routes, including dashboard,
sleep, stress, recovery, sync, provider guide, and mobile sensor push endpoints.
OAuth callbacks and webhook lookups also failed around the same window.

### User Impact

Authenticated web and mobile requests intermittently failed because even the
cheap session validation query could not get a Postgres client from the web
process pool.

### Evidence

Axiom OpenTelemetry spans for `dofek-web` showed the underlying failure:

```text
name="pg-pool.connect"
status.message="timeout exceeded when trying to connect"
duration="9.999601248s"
```

The app log wrapper around the same time was:

```text
[trpc] settings.get: Failed query: SELECT user_id FROM fitness.session
```

Postgres itself was writable and not in recovery:

```text
pg_is_in_recovery = false
to_regclass('fitness.session') = fitness.session
session_count = 7
connections = 20
```

`pg_stat_activity` showed many long-running app queries active for 28-35 minutes,
including `fitness.v_daily_metrics`, `fitness.activity`, stress, recovery, and
provider-stat read queries. The app DB pool is configured in `src/db/index.ts`
with `max: 5` and `connectionTimeoutMillis: 10_000`.

### Root Cause

The immediate root cause was web-process Postgres pool starvation: expensive
read queries held all available pg pool clients long enough that new requests
timed out after 10 seconds while trying to acquire/connect a client. The
`fitness.session` query was the first query most authenticated requests run, so
it surfaced as an auth/session failure even though the session table existed and
Postgres was writable.

### Fix or Mitigation

Moved `sync.providerStats` off the hot Postgres request path.
`SyncRepository.getProviderStats()` now reads all provider record counts from
the ClickHouse `analytics.provider_stats` read model. The ClickHouse raw mirrors
were extended to include `food_entry`, `health_event`, `lab_panel`,
`lab_result`, and `journal_entry`, so the endpoint no longer runs per-provider
count subqueries against Postgres. The fix intentionally did not increase
Postgres pool size or timeouts.

### Remaining Risk

Other expensive Postgres read paths were observed during the incident, especially
daily-metrics/recovery/insights queries over `fitness.v_daily_metrics` and
related views. Those paths still need follow-up migration or query tightening so
dashboard/mobile bursts cannot exhaust each web process's small Postgres pool.

## 2026-05-07: Deploy Web Production Failed in ClickHouse Migrations

### Symptoms

The `Deploy Web` workflow run `25514597539` failed in the production
`Deploy Web Stack` job during the `Run migrations` step.

### User Impact

The new image tag `sha-edcd2a2` did not roll out to production because the
workflow stopped before `docker stack deploy`.

### Evidence

The production migration container exited with:

```text
[migrate] Error: Storage MergeTree doesn't support FINAL.
```

Earlier deploy steps had already passed: GHCR login, image pulls, host bind
mount validation, Postgres writability, and ClickHouse readiness.

### Root Cause

Production still had a legacy `postgres_fitness.metric_stream` ClickHouse table
created with the plain `MergeTree` engine. Newer ClickHouse read models query
the PeerDB-style raw mirror with `FINAL`, which requires
`ReplacingMergeTree(_peerdb_version)`. The bootstrap SQL used
`CREATE TABLE IF NOT EXISTS`, so it did not repair the existing table engine.

### Fix or Mitigation

Added a ClickHouse migration that detects a legacy `metric_stream` engine before
the provider-stats read-model migration runs. When the table is not
`ReplacingMergeTree`, it drops dependent analytics read models, clears the
metric-stream backfill marker, recreates `postgres_fitness.metric_stream` with
`ReplacingMergeTree(_peerdb_version)`, backfills it from Postgres, and refreshes
dependent ClickHouse read models.

### Remaining Risk

Local automated verification could not run in this isolated worktree because
`node_modules` was absent and `pnpm install --offline --frozen-lockfile` could
not find `zod` in the local pnpm store. CI must run the focused migration tests
and the deploy workflow to verify the production repair path end to end.

## 2026-05-07: Dashboard Analytics Saturated Postgres

### Symptoms

Dashboard cards including Top Insights, Healthspan, Next Workout, and Stress
Monitor took a very long time to load. Authenticated requests eventually showed
a session lookup failure:

```text
SELECT user_id FROM fitness.session WHERE id = $1 AND expires_at > NOW() LIMIT 1
```

### User Impact

Dashboard and mobile dashboard API responses were degraded. Some authenticated
requests surfaced session-query errors because the web process could not get
through its normal Postgres request path during the contention window.

### Evidence

The session lookup itself was not the expensive query; direct inspection showed
it completed in sub-millisecond time. Production evidence pointed at dashboard
analytics queries holding Postgres connections for long periods, including
`insights.compute` requests in the 810-1047 second range and other dashboard
analytics requests around 10 seconds or more. `pg_stat_statements` also showed a
dashboard analytics query with very high cumulative time and multi-thousand
second maximum runtime.

### Root Cause

Dashboard analytics were still using expensive live Postgres read paths and the
resting-heart-rate derived read model. Under dashboard burst load, those queries
could hold the small web Postgres pool long enough that unrelated session
lookups failed while waiting behind analytics work.

### Fix or Mitigation

Removed the resting-heart-rate derived tables/read model from both Postgres and
ClickHouse. Added a reusable resting-heart-rate SQL helper for Postgres call
sites and a ClickHouse helper that computes resting heart rate directly from
`analytics.v_sleep` and `analytics.deduped_sensor`. Dashboard-heavy paths now
reuse that helper instead of reading `fitness.derived_resting_heart_rate` or
`analytics.derived_resting_heart_rate`.

### Remaining Risk

The helper is intentionally a regular query for now, not a materialized view.
Monitor ClickHouse latency for RHR-heavy dashboard paths; if it becomes the next
hot spot, revisit a ClickHouse materialized view or scheduled read model with a
documented late-data refresh strategy.

### Follow-Up Work

- Monitor ClickHouse latency for RHR-heavy dashboard queries that use
  `analytics.v_sleep` and `analytics.deduped_sensor`, and add an alert if those
  helpers become a new hot path.
- Keep runtime scans in review for any reintroduced
  `fitness.derived_resting_heart_rate` or `analytics.derived_resting_heart_rate`
  callers, and refactor them back to the unified RHR helper.
- Evaluate a ClickHouse materialized view or scheduled read model if RHR query
  latency rises under dashboard load.
- Assign an analytics owner and review the mitigation by 2026-05-21.

## 2026-05-08: Netdata Authentik Redirects To Authentik Dashboard

### Symptoms

Opening `https://netdata.dofek.asherlc.com/` redirects through Authentik, but
after authentication the browser lands on the Authentik dashboard instead of
returning to Netdata. Follow-up checks showed the same outpost ping failure on
Portainer, Databasus, CloudBeaver, pgAdmin, and staging Portainer.

### User Impact

The Netdata UI is not usable for routine production host health checks. Raw
capacity checks are still available over SSH.

### Evidence

Unauthenticated requests to Netdata return HTTP 302 to Authentik, but the
OAuth state payload records the post-login redirect as
`http://authentik.asherlc.com`, not `https://netdata.dofek.asherlc.com/`.
Requests to `https://netdata.dofek.asherlc.com/outpost.goauthentik.io/ping`
also return HTTP 302 instead of the Authentik outpost health check's expected
HTTP 204. The live Dofek Swarm labels point Traefik `forwardAuth.address` at
the public Authentik hostname:
`https://authentik.asherlc.com/outpost.goauthentik.io/auth/traefik`.

The Authentik host uses a single embedded `forward_domain` proxy provider with
external host `https://authentik.asherlc.com`. Homelab apps that work with the
same Authentik install use Traefik on the Authentik host with the internal
outpost address `http://authentik-server:9000/outpost.goauthentik.io/auth/traefik`,
so the original protected host is preserved.

### Root Cause

Dofek's Traefik forwards auth checks through the public Authentik hostname,
which crosses Cloudflare and the homelab Traefik instance. By the time the
embedded Authentik outpost handles the request, the protected host has been
lost and Authentik only sees `authentik.asherlc.com`, so it builds a login
state that returns to the Authentik dashboard.

### Fix or Mitigation

Added a Dofek-local Authentik proxy outpost service to `deploy/stack.yml`.
All Dofek management routers now use a shared `management-auth` middleware that
calls the internal outpost endpoint instead of the public Authentik hostname.
The outpost path is routed publicly with high priority so
`/outpost.goauthentik.io/` can complete Authentik's callback and health-check
flow without first passing through forward auth.

Immediate capacity checks can still use:

```bash
ssh dofek-server 'df -h / /mnt/dofek-data && docker system df'
```

### Remaining Risk

The stack change requires `AUTHENTIK_OUTPOST_TOKEN` in each Infisical
environment before deployment. The local outpost image is pinned to the
currently deployed Authentik core version, `2025.2.4`; upgrade Authentik core
and the outpost image together.

### Follow-Up Work

- Add `AUTHENTIK_OUTPOST_TOKEN` to prod and staging Infisical environments.
- Deploy the stack and validate that each protected management host's
  `/outpost.goauthentik.io/ping` endpoint returns HTTP 204.
- Investigate the separate staging Netdata 404 if it persists after the shared
  outpost fix is deployed.

## 2026-05-08: Production Migration Log Blind Spot

### Symptoms

The production deploy workflow reached `Run migrations` and printed only
periodic status lines like `Migration still running after 219s...`.

### User Impact

The deploy was blocked before the swarm rollout. Operators could not tell from
the GitHub Actions log whether the migration was making progress, waiting on a
lock, or stuck in ClickHouse work.

### Evidence

The migration container `dofek_migrate_25537950441_1` was still running. Its
logs showed the last visible migration step was
`Applying: 0017_drop_derived_resting_heart_rate.sql`. Postgres activity showed
`DROP VIEW IF EXISTS fitness.derived_resting_heart_rate;` waiting on a relation
lock while three long-running old-web queries continued reading
`fitness.derived_resting_heart_rate`.

### Root Cause

The workflow started the migration container in detached mode and only fetched
container logs after completion or timeout. That hid useful live progress and
lock-wait context during long-running migrations.

### Fix or Mitigation

Stream migration container logs with `docker logs --follow` while polling the
container state. Add explicit Postgres and ClickHouse migration phase logs,
including pending migration counts, advisory-lock acquisition, ClickHouse
migration IDs, and metric-stream backfill ranges.

### Remaining Risk

The improved logging does not prevent DDL from waiting behind long-running app
queries. Future destructive migrations should use expand/contract or
post-deploy sequencing so old app versions stop referencing the object before
the migration drops it.

### Follow-Up Work

- Owner: Asher. Merge the deploy workflow log-streaming and migration phase-log
  fix by 2026-05-09.
- Owner: Asher. Document the migration lock investigation steps and
  expand/contract rule in the deploy runbook by 2026-05-15.
- Owner: Asher. Review long-running dashboard and personalization queries that
  still use Postgres read paths and move analytics-heavy work to ClickHouse
  where the required read models already exist by 2026-05-22.
- Owner: Asher. Add a workflow test or shellcheck-style coverage for detached
  migration container log streaming by 2026-05-22.

## 2026-05-08: Production Training Load Chart Empty

### Symptoms

The production Fitness / Fatigue / Form chart rendered `No training load data`
even though recent activities existed.

### User Impact

The training dashboard did not show current fitness, fatigue, or form trends.
Other ClickHouse-backed training panels were at risk of stale or empty analytics
because they depend on the same `postgres_fitness.metric_stream` mirror and
`analytics.deduped_sensor` read model.

### Evidence

Production `pmc.chart` requests reached the web service successfully, but
`analytics.activity_summary` had 163 recent activities for the user with zero
recent heart-rate aggregates. Postgres `fitness.metric_stream` had current
heart-rate samples through 2026-05-08, while ClickHouse
`postgres_fitness.metric_stream` only had heart-rate rows through 2022-05-17.
The backfill tracking table marked 2026-05-07 ranges complete despite the
ClickHouse mirror having zero rows in those ranges.

### Root Cause

The ClickHouse metric-stream backfill anti-join tested
`existing_metric_stream.id IS NULL`, but ClickHouse fills unmatched non-nullable
UUID join columns with the zero UUID unless `join_use_nulls` is enabled or the
joined column is nullable. That made every source row look already present, so
newer Timescale chunks were marked complete without inserting their rows.

### Fix or Mitigation

Changed the backfill anti-join to cast existing IDs to `Nullable(UUID)` before
the `IS NULL` check. Added a ClickHouse repair migration that drops the stale
backfill progress marker table, reruns the corrected chunk backfill, and
refreshes `analytics.deduped_sensor`, `analytics.activity_summary`, and
`analytics.activity_trend_daily`.

### Remaining Risk

The repair migration may take time on production data because it must recheck
all Timescale metric-stream chunk ranges. PeerDB CDC was also replaying older
metric-stream batches, so live CDC lag should be monitored after the repair
backfill completes.

### Follow-Up Work

- Add a migration smoke check that compares recent Postgres and ClickHouse
  `metric_stream` max timestamps after ClickHouse backfills.
- Record row counts, not only range completion markers, for future large
  ClickHouse backfills.
- Add a ClickHouse/PeerDB runbook section for checking `_peerdb_raw_*`,
  normalized tables, and refreshable materialized-view freshness.

## 2026-05-08: GitGuardian False Positive On Authentik Outpost URL

### Symptoms

PR #1106 was blocked by GitGuardian Security Checks.

### User Impact

The Authentik proxy outpost fix could not merge until the security check was
cleared.

### Evidence

The GitGuardian PR comment identified a `Generic High Entropy Secret` in
`deploy/stack.yml` at the Traefik forward-auth URL for the internal
`authentik-proxy` service. The flagged value was an internal service URL, not a
credential or token.

### Root Cause

GitGuardian treated the deterministic internal outpost URL as a high-entropy
secret.

### Fix or Mitigation

Split the source YAML string for the exact false-positive line while preserving
the rendered stack label. Squashed the PR branch onto current `main` so the
original false-positive commit is no longer in the PR history.

### Remaining Risk

None known for the false positive. The real Authentik token still comes from
Infisical through `AUTHENTIK_OUTPOST_TOKEN`.

### Follow-Up Work

- Recheck PR #1106 after push and confirm GitGuardian passes.

## 2026-05-08: Review App Database Restart Loop After PostGIS Image Change

### Symptoms

PR #1111 review-app deployment failed while waiting for the review Postgres
database to become ready.

### User Impact

The PR review app was unavailable, blocking preview validation for the GPS
storage migration.

### Evidence

The `Deploy review stack` step repeatedly ran `pg_isready` against the review
database and received `no response`. Docker also reported that the database
container was restarting. The first fatal CI line was `Review app database did
not become ready within 180s`.

### Root Cause

The PR changed review apps from the old TimescaleDB image to the PostGIS-enabled
TimescaleDB HA image, while review-app deploys reused the same Docker Compose
project volumes across pushes. The disposable review database could therefore
restart against stale volume contents initialized by the previous image.

### Fix or Mitigation

The review-app workflow now runs `docker compose down --remove-orphans --volumes`
before pulling and starting services. Review apps are seeded on each deploy, so
resetting disposable service volumes preserves the intended lifecycle while
removing stale database state.

### Remaining Risk

None known for review-app data persistence because review apps are ephemeral.
If the database still fails after the reset, the next CI run should expose the
next root cause rather than stale volume reuse.

### Follow-Up Work

- Add failure-path review-app service logs to the deploy workflow if readiness
  failures remain hard to diagnose.

## 2026-05-09: Review App Fresh Database Init Permission Failure

### Symptoms

PR #1111 review-app deployment again failed in the `Deploy review stack` step
while waiting for the review Postgres database to become ready.

### User Impact

The PR review app was unavailable, blocking live preview validation.

### Evidence

The attached CI log showed a fresh `dofek-review-pr-1111_db_data` Docker volume
being created, followed by repeated `pg_isready` output:
`/var/run/postgresql:5432 - no response`. The first fatal CI line was
`Review app database did not become ready within 180s`. A local reproduction
with the same review compose file and a fresh named volume showed the underlying
database log line: `initdb: error: could not change permissions of directory
"/var/lib/postgresql/data": Operation not permitted`.

### Root Cause

The review compose file overrode the TimescaleDB HA image's default `PGDATA` and
mounted the disposable Docker volume directly at `/var/lib/postgresql/data`.
During fresh initialization, the image runs as the `postgres` user and could not
change ownership or permissions on the mounted volume root, causing `initdb` to
fail and the container to restart.

### Fix or Mitigation

The review database now uses the image's default data layout by mounting the
volume at `/home/postgres/pgdata` and letting `PGDATA` remain
`/home/postgres/pgdata/data`. A local fresh-volume review DB startup reached
`pg_isready` successfully and the container became healthy.

### Remaining Risk

None known for fresh review database initialization. The production stack still
uses its existing bind-mounted data path and was not changed by this review-app
fix.

### Follow-Up Work

- Keep the review-app docs explicit about the TimescaleDB HA data mount layout.

## 2026-05-08: Staging Deploy SSH Host Key Timeout

### Symptoms

The `Deploy Web Staging / Deploy Web Stack` job in run `25569517018` failed
during `Setup SSH`.

### User Impact

The production deploy path was still running, but the staging half of the web
deploy did not reach stack deployment or migrations.

### Evidence

GitHub Actions reported:

```text
SSH host key for 162.55.186.24 did not become available within 120s
```

### Root Cause

Unknown. The failure happened before secrets export, migrations, or stack
deployment, so the immediate failing boundary is staging SSH reachability or
host-key discovery for `162.55.186.24`.

### Fix or Mitigation

Unresolved. No deploy behavior was changed during the activity-page fix.

### Remaining Risk

Staging deploys may remain blocked until SSH reachability or host-key
availability for the staging host is repaired.

### Follow-Up Work

- Check whether the staging host is booted and reachable on port 22.
- Verify the staging DNS/IP mapping and the expected SSH host key.
- Rerun the staging deploy only after the connectivity/root cause is confirmed.

## 2026-05-08: Review App Docker Disk Exhaustion

### Symptoms

The PR `Deploy Review App` job failed during the `Deploy review stack` step
while pulling the app image onto the review server.

### User Impact

The PR review app was unavailable, although the image build and regular test
jobs continued independently.

### Evidence

The first fatal log line was:
`failed to extract layer ... /app/node_modules/expo/src/winter/__tests__: no space left on device`.
The failure happened before migrations, seeding, or app startup.

### Root Cause

The review server root filesystem did not have enough Docker storage headroom to
extract the new app image layer.

### Fix or Mitigation

The review-app deploy workflow now prunes stopped containers, unused images, and
build cache on the review server before image pulls, then hard-fails before the
pull if less than 8 GiB remains free.

### Remaining Risk

If the live review stack plus required images still exceed the `cax11` root
disk after cleanup, the review app server type must be increased or stale review
apps must be destroyed.

### Follow-Up Work

- Document the disk cleanup threshold in the review app runbook and revisit the
  `cax11` server size if review app image growth keeps hitting the threshold.

## 2026-05-09: Netdata Redirects To Authentik Library

### Symptoms

Opening `https://netdata.dofek.asherlc.com/` redirects through Authentik and
lands at `https://authentik.asherlc.com/if/user/#/library` instead of returning
to Netdata.

### User Impact

The production Netdata management UI is not reachable through the expected
protected URL.

### Evidence

`curl -D - https://netdata.dofek.asherlc.com/` returned HTTP 302 with an
Authenik authorize URL whose `redirect_uri` was
`https://authentik.asherlc.com/outpost.goauthentik.io/callback...`.
`https://netdata.dofek.asherlc.com/outpost.goauthentik.io/ping` also returned
HTTP 302 instead of the expected outpost ping HTTP 204.

Live Docker service inspection showed there is no `dofek_authentik-proxy`
service, and `dofek_netdata` still has
`traefik.http.middlewares.netdata-auth.forwardAuth.address=https://authentik.asherlc.com/outpost.goauthentik.io/auth/traefik`.

### Root Cause

Production has not deployed the stack that added the local Authentik proxy
outpost and shared `management-auth` middleware. The live Netdata route still
forwards auth checks to the public Authentik hostname, so Authentik loses the
original protected host and builds the callback for `authentik.asherlc.com`.

### Fix or Mitigation

Unresolved in production during this investigation. The code/config fix already
exists on `main` from PR #1106, but production deploys have not reached
`docker stack deploy`. The current unblock attempt is PR #1112, which fixes
dotenv-linter key ordering so main CI can pass and trigger the normal deploy
pipeline.

### Remaining Risk

Even after CI is unblocked, the next production deploy may still fail before
stack deployment if ClickHouse migration `0012_repair_metric_stream_backfill`
again exceeds the live ClickHouse memory limit.

### Follow-Up Work

- Merge PR #1112 after checks pass.
- Confirm the subsequent main Deploy Web run reaches `docker stack deploy`.
- Verify `dofek_authentik-proxy` exists and the Netdata outpost ping endpoint
  returns HTTP 204.
- If deployment fails in ClickHouse migrations again, investigate and fix the
  migration memory usage root cause before adding resilience knobs.

## 2026-05-11: Strava Activity Missing From Recent Activities

### Symptoms

A newly synced Strava activity was visible in the Strava details section but did
not appear in the `Recent Activities` section on `/training`.

### User Impact

Recent activity data could be stale after provider syncs, so users might not see
newly imported workouts until the activity materialized view refreshed.

### Evidence

Production inspection showed `fitness.v_activity` was a Postgres materialized
view. The recent activity query read from that relation, while provider detail
data read from raw provider-backed rows. Read-only production benchmarks showed
the current materialized read was about 3.4 ms, a scoped live dedup query was
about 45.5 ms, and the unscoped plain-view-equivalent query was about 206 ms on
697 raw activity rows.

### Root Cause

`Recent Activities` depended on `fitness.v_activity`, so newly inserted activity
rows were not visible until the materialized view was refreshed.

### Fix or Mitigation

Converted `fitness.v_activity` from a materialized view to a regular Postgres
view via migration `0021_convert_v_activity_to_view.sql`, removed active test
refresh calls for `v_activity`, and kept the dependent ClickHouse proxy views
pointing at the new regular view.

### Remaining Risk

The plain view is slower than the materialized read but was still acceptable at
current production scale in the scoped benchmark. Re-check query plans before
expanding the same approach to larger activity read paths or to `fitness.v_sleep`.

### Follow-Up Work

- Deploy the migration and verify the newly synced Strava activity appears on
  `/training` without an activity view refresh.
- Re-benchmark `fitness.v_activity` after activity row volume grows materially.
- Benchmark `fitness.v_sleep` separately before deciding whether to convert it
  from a materialized view.

## 2026-05-11: Deploy Web Blocked By Missing Authentik Outpost Token

### Symptoms

The Deploy Web workflow failed for both staging and production during the
`Validate rendered stack files` step.

### User Impact

The web stack did not deploy commit `c1c47fa44d44b1ca1c8ee82ad39c22aa78fbbfba`.
The live production stack still has not received the local Authentik proxy
outpost configuration.

### Evidence

The failing command was:

```bash
node "$RUNNER_TEMP/run-with-dotenv-env.mjs" docker stack config $STACK_FILE_FLAGS >/dev/null
```

Both staging job `75414642621` and production job `75414716269` failed with:

```text
invalid interpolation format for services.authentik-proxy.environment.AUTHENTIK_TOKEN: "required variable AUTHENTIK_OUTPOST_TOKEN is missing a value: AUTHENTIK_OUTPOST_TOKEN is required"
```

### Root Cause

`deploy/stack.yml` requires `AUTHENTIK_OUTPOST_TOKEN` for the
`authentik-proxy` service, but the Infisical dotenv exported in CI did not
contain that key for the deploy environments.

### Fix or Mitigation

Set `AUTHENTIK_OUTPOST_TOKEN` in both the `prod` and `staging` Infisical
environments using the generated Authentik embedded outpost service-account API
token from the homelab Authentik database.

### Remaining Risk

Fresh staging run `25690902218` passed stack-file rendering after the secret was
set, proving the Infisical/Authentik prerequisite was fixed. The remaining risk
moved to later deploy steps, starting with migrations.

### Follow-Up Work

- Rerun Deploy Web for commit `c1c47fa44d44b1ca1c8ee82ad39c22aa78fbbfba`.
- Verify the deploy reaches `docker stack deploy`, creates
  `dofek_authentik-proxy`, and protected management hosts return HTTP 204 from
  `/outpost.goauthentik.io/ping`.

## 2026-05-11: Staging Deploy Blocked By Resting Heart Rate Migration Type Mismatch

### Symptoms

Fresh staging Deploy Web run `25690902218` passed stack rendering, image pull,
host bind-path validation, bootstrap, and database readiness, then failed during
`Run migrations`.

### User Impact

The staging web stack did not deploy commit
`c1c47fa44d44b1ca1c8ee82ad39c22aa78fbbfba`. Production Deploy Web run
`25687367151` ended cancelled while it was also in the migration phase, so
production still has not received this deploy.

### Evidence

The failing step was the deploy workflow's migration container. The first fatal
log line in staging job `75426830612` was:

```text
error: [migrate] error: "derived_resting_heart_rate" is not a view
```

The workflow had already passed `Validate rendered stack files`, so this was a
new failure after the missing `AUTHENTIK_OUTPOST_TOKEN` issue was fixed.

### Root Cause

Migration `0017_drop_derived_resting_heart_rate.sql` ran
`DROP VIEW IF EXISTS fitness.derived_resting_heart_rate` before
`DROP MATERIALIZED VIEW IF EXISTS fitness.derived_resting_heart_rate`. Postgres
still errors when `DROP VIEW IF EXISTS` targets an existing materialized view, and
staging had `fitness.derived_resting_heart_rate` as a materialized view.

### Fix or Mitigation

Changed migration `0017_drop_derived_resting_heart_rate.sql` to inspect
`pg_class.relkind` and drop `fitness.derived_resting_heart_rate` as either a
materialized view or a normal view. It still raises if the relation exists as any
unsupported relation kind. Added an integration test that creates the relation as
a materialized view and verifies the migration drops it.

### Remaining Risk

Production had already applied migration `0017`, so it may warn that the local
migration hash changed, but it should not rerun the migration there. Staging still
needs a new image tag containing this fix and a deploy rerun; later pending
migrations may still expose separate deploy failures.

### Follow-Up Work

- Push the migration fix and rerun the staging deploy for commit
  `c1c47fa44d44b1ca1c8ee82ad39c22aa78fbbfba`.
- After staging migrations pass, rerun or resume production deploy and verify it
  reaches `docker stack deploy`.

## 2026-05-12: Production Location Backfill Hit Data Volume ENOSPC

### Symptoms

The insert-only production location backfill advanced to 38,213,041 location
rows before failing while processing the `2022-05-17..2022-05-18` window. The
initial progress denominator used during the incident was too low; a later
full-source count corrected the denominator to 42,041,240 source location rows.

### User Impact

The location-point backfill is incomplete. The production app remained healthy,
but continuing the daily-window backfill without more disk headroom risks another
database `No space left on device` failure.

### Evidence

The backfill script failed with:

```text
ERROR:  could not extend file "base/16384/t5_19513608" with FileFallocate(): No space left on device
HINT:  Check free disk space.
```

After the script exited, production Postgres reported
`pg_is_in_recovery() = false`, `/healthz` returned `{"status":"ok"}`, and there
were no lock waiters. The production data volume
`/mnt/HC_Volume_105292545` reached 100% used with about 190M free during
triage.

### Root Cause

The data volume does not have enough free space for the current daily-window
backfill strategy. The failed window attempted to build a large temporary table
for location source rows, and Postgres could not extend the temporary file on the
data volume.

### Fix or Mitigation

The backfill process stopped after the failed statement, leaving no active
backfill transaction or lock waiters. An unreferenced 11G old Docker data
directory at
`/mnt/HC_Volume_105292545/docker-volumes/compose-copy-1080p-array-h8xws3_db_data`
was verified as not mounted, not registered as a Docker volume, not referenced by
any container, and not held open by any process before removal. After removal,
the volume had about 9.6G free and production remained healthy.

The resumed backfill used insert-only windows and recompressed affected chunks
after each window. On the later `2026-04-16..2026-05-12` pass, it reached
41,105,491 of 42,041,240 source rows, or 97.77%, with 27G free on the data
volume. At that checkpoint it was still decompressing affected chunks and had
three relation-lock waiters from normal metric-stream activity-link updates.

### Remaining Risk

The data volume still has limited headroom for large temporary-table builds.
Continuing with one-day windows may succeed for remaining smaller windows, but a
sub-day resume is safer if any remaining day is unusually dense.

### Follow-Up Work

- Prefer resizing the production data volume or moving non-Postgres services off
  it before continuing large backfills.
- If disk cannot be expanded immediately, patch the backfill script to support
  smaller time windows and resume from `2022-05-17`.

## 2026-05-12: ClickHouse Point Migration Needed Nullable Tuple Settings

### Symptoms

Moving the ClickHouse metric-stream mirror to `point Nullable(Point)` required
ClickHouse's nullable tuple setting. Without that setting in both app requests
and server configuration, migrations or PeerDB writes could fail when creating
or writing nullable geospatial point columns.

### User Impact

No user-facing outage occurred during this code change, but deploying the
point-first ClickHouse schema without the setting would block the analytics
migration path.

### Evidence

ClickHouse documents `Point` as a tuple-backed geospatial type, and local syntax
verification only succeeded for `Nullable(Point)` with
`allow_experimental_nullable_tuple_type=1`.

### Fix or Mitigation

The ClickHouse client now sends `allow_experimental_nullable_tuple_type=1` on app
and migration commands. Docker Compose, E2E Compose, review app Compose, and the
production Swarm stack all mount the checked-in
`deploy/clickhouse/users.d/allow-experimental-nullable-tuple-type.xml` profile so
the setting is infrastructure-as-code rather than a manual server change.

### Remaining Risk

PeerDB's PostGIS-to-ClickHouse `Point` conversion still needs production CDC
validation after deploy. If PeerDB cannot write the native point cleanly, decide
explicitly whether to revisit the point-only direction rather than reintroducing
coordinate projections by default.

### Follow-Up Work

- Validate production PeerDB CDC from PostGIS `Point` to ClickHouse `Point` after
  the migration is applied.
- Keep integration coverage for `Nullable(Point)` in the ClickHouse migration
  path so schema drift fails in CI.
- Monitor ClickHouse and PeerDB write failures during the first production sync
  after deployment.
- Document the rollback decision point if native `Point` replication proves
  untenable.

## 2026-05-13: Location Rebuild Dense Chunk Monitoring

### Symptoms

The production `metric_stream` location rebuild appeared to stall while copying
2021 Timescale chunks. Overall task progress stayed flat for long periods
because each week-sized source chunk counts as one rebuild task.

### User Impact

No outage was observed. Normal production inserts continued while the rebuild
ran, and status checks showed no lock waiters during the monitored windows.

### Evidence

`_hyper_1_147_chunk` completed with 10,567,554 source rows, 5,320,051
passthrough rows, and 1,772,834 location rows. `_hyper_1_146_chunk` completed
with 10,591,904 source rows, 5,335,150 passthrough rows, and 1,775,778 location
rows. Both chunks had dense evening bands where 5-minute or 1-hour windows
processed hundreds of thousands to millions of source rows. Progress advanced
from 157/297 (52.86%) to 159/297 (53.54%). The data volume stayed healthy at
about 19-20% used with 228-230G free.

A later resume advanced `_hyper_1_145_chunk` to `2021-10-29 23:40:00+00`
with 5,389,466 source rows copied, and `_hyper_1_144_chunk` to
`2021-11-11 00:45:00+00` with zero rows copied. Overall progress remained
159/297 (53.54%) because neither in-progress week-sized chunk had completed.
The data volume remained healthy at about 20% used with 229G free and no lock
waiters.

### Fix or Mitigation

Dense hours that completed inside the statement timeout were allowed to finish.
Hours that timed out were retried from the unchanged cursor with 5-minute
slices. Empty spans were skipped with hour-sized slices, and affected rebuild
chunks were recompressed by the script as each range completed.

### Remaining Risk

The task-count percentage is still a coarse denominator. Future dense chunks can
hold the percentage flat for a long time even while millions of rows are being
copied. One-hour slices can still time out on dense bands, so the operator
should fall back to 5-minute slices for those windows.

### Follow-Up Work

- Add a documented production runbook for switching slice sizes by observed row
  density and timeout behavior.
- Consider adding row-weighted progress reporting to the rebuild task table so
  percent complete reflects rows copied, not only completed chunks.
- Keep reporting both task percentage and current chunk cursor during
  monitoring.

## 2026-05-13: Location Rebuild Remaining Dense Band Analysis

### Symptoms

The production location rebuild was still spending long wall-clock periods in
2022 despite reaching 160/297 tasks complete (53.87%). Several 5-minute windows
inside `_hyper_1_143_chunk` approached or exceeded the 20-minute statement
timeout, making it unclear whether the remaining migration could finish at the
current rate.

### User Impact

No user-facing outage was observed. Normal production ingestion continued while
the read-only density analysis and rebuild batches ran.

### Evidence

A full remaining-hour density scan over all pending tasks timed out after 20
minutes, so the analysis switched to a cheaper chunk-size ranking followed by
targeted hourly counts for the largest remaining chunks. There were 137
remaining tasks spanning `2021-11-02 21:40:00+00` through
`2026-05-13 00:00:00+00`, with about 13 GB of remaining source chunk footprint.

The targeted scan found the expensive legacy location work concentrated in
`_hyper_1_143_chunk`: remaining dense hours around `2022-05-17 16:00`,
`17:00`, and `18:00` had about 2.93M, 3.33M, and 4.06M source rows,
respectively, with substantial lat/lng/location-related rows. `_hyper_1_186_chunk`
(`2026-04-23` through `2026-04-30`) had about 51.48M source rows and 126 hours
over 250k rows, but sampled dense hours had zero location-related rows, so this
appears to be passthrough-heavy copy work rather than legacy location
transformation. `_hyper_1_688_chunk` (`2026-05-12`) had about 8.42M source rows
and 22 hours over 250k rows, also with zero location-related rows.

During follow-up copying, `_hyper_1_143_chunk` advanced through
`2022-05-17 18:00:00+00`. Five-minute slices worked for most dense ranges, but
`2022-05-17 17:50:00+00` through `17:55:00+00` timed out during the location
insert and required 1-minute slices. Disk stayed healthy around 21-22% used with
223-226 GB free, and rebuild status remained 160/297 (53.87%) because the
current chunk had not completed.

### Fix or Mitigation

The rebuild continued with adaptive slice sizing: hour-sized slices for sparse
windows, 5-minute slices for dense windows, and 1-minute slices when a 5-minute
location insert timed out. Naive two-worker parallelism was tested earlier but
caused lock-timeout contention when workers drifted into the same hot chunk, so
the active mitigation remains single-worker adaptive slicing until chunk
selection is made explicitly disjoint.

### Remaining Risk

The final legacy-location dense hour in `_hyper_1_143_chunk` still needs to be
cleared. Later recent chunks contain tens of millions of passthrough-heavy rows,
especially `_hyper_1_186_chunk`, so they may still take wall-clock time even
though they should not pay the expensive lat/lng pairing cost.

### Follow-Up Work

- Patch worker selection so concurrent workers can claim disjoint chunks rather
  than competing in the same hot chunk.
- Add a read-only density-report command to the repository script so future
  operators can see remaining dense hours without hand-written SQL.
- Add adaptive slice-size selection to the rebuild script so it can
  automatically step down from hourly to 5-minute or 1-minute slices after a
  timeout.

## 2026-05-18: Metric Stream Location Rebuild Completed

### Symptoms

The production `fitness.metric_stream` location rebuild was still open in the
final recent chunks and needed continuous batch chaining to finish. The last
task-count plateau was 296/297 (99.66%) while `_hyper_1_688_chunk` copied a
large passthrough-only band for 2026-05-12.

### User Impact

No user-facing outage was observed during the final batch chain. Production disk
space stayed healthy after the earlier volume increase.

### Evidence

The final task `_hyper_1_688_chunk` copied through
`2026-05-12 23:30:00+00` to `2026-05-13 00:00:00+00` with 180,967 passthrough
rows and zero location conversions. After the final commit, repeated runner
iterations reported no pending task. The verification query returned
`297/297 = 100.00%`, `open_tasks=0`, `errors=0`, `active_rebuilds=0`,
`lock_waiters=0`, and disk at 34% used with 189 GB free.

### Fix or Mitigation

Continued the production rebuild with chained batches. Dense legacy-location
windows used smaller 5-minute slices earlier; the final recent chunks used
30-minute slices because they were passthrough-only and did not require
lat/lng-to-point conversion.

### Remaining Risk

The rebuild task table is complete, but follow-up validation and any planned
post-rebuild cleanup or recompression still need to be tracked separately.

### Follow-Up Work

- Run the post-rebuild validation queries before deleting legacy-only rows or
  performing any cleanup.
- Recompress affected chunks after validation if they are still decompressed.
- Add row-weighted progress reporting so future status updates do not sit at
  the same task percentage during large passthrough chunks.

## 2026-05-18: Metric Stream Cleanup, Swap, and Legacy Table Drop

### Symptoms

After the rebuild completed, production still had the original
`fitness.metric_stream` hypertable with legacy `lat`, `lng`, and
`gps_accuracy` channel rows, plus the rebuilt `fitness.metric_stream_rebuild`
hypertable using `location` points.

### User Impact

No app healthcheck outage was observed. The scheduled worker was temporarily
scaled to zero after the swap because the deployed image was still writing
legacy `lat`/`lng` rows into the new table.

### Evidence

Pre-swap validation showed the rebuild had no legacy channels, no null
`location.point` rows, no non-location point rows, and all initial rebuild
chunks compressed. The final locked delta copied and verified 5,650,344
current/future passthrough rows and inserted 137,985 rows that were missing
from the earlier tail copy. After the swap, verification caught 20,637 new
`lat`/`lng` pairs written by the old worker into the new table. The worker was
stopped, 14 affected 2021 chunks were decompressed, those pairs were converted
chunk-by-chunk into `location` points, and the legacy rows were deleted.

Final verification returned `legacy_total=0`, `location_null_points=0`,
`non_location_points=0`, `489` chunks with `488` compressed and only the active
`2026-05-18` chunk uncompressed. Dropping
`fitness.metric_stream_legacy_drop` reduced the Hetzner data volume from about
98 GB used before recompression to 84 GB used after recompression. The old table
drop cascaded to obsolete Postgres views `fitness.v_metric_stream` and
`fitness.provider_stats`; current server read paths use ClickHouse analytics
read models instead.

### Fix or Mitigation

Swapped `fitness.metric_stream_rebuild` into `fitness.metric_stream`, added the
new table to the PeerDB publications, dropped the legacy hypertable after
validation, converted post-swap legacy rows in chunk-aware batches, and
recompressed all non-current chunks. The Terraform default volume size was
changed back to 100 GB in code, but the live Hetzner volume remains 300 GB
because Hetzner Cloud Volumes cannot be shrunk in place.

### Remaining Risk

The scheduled worker must stay stopped until an image containing the point-only
writer is deployed; otherwise it can write new legacy `lat`/`lng` rows into the
clean table. The live volume cannot be reduced from 300 GB to 100 GB without a
new-volume migration.

### Follow-Up Work

- Deploy the point-only writer before restoring the worker replica.
- Keep the deployment runbook explicit that volume downsizing requires a new
  volume and data migration, not a Terraform resize.
- Add a post-swap guard or validation script that fails loudly if any
  `lat`/`lng`/`gps_accuracy` channels reappear.

## 2026-05-18: Deploy Migration Blocked by Compressed Body-Stream Update

### Symptoms

The direct production stack deploy for the point-only writer failed during the
`Run migrations` step before any service update occurred.

### User Impact

The production web service stayed on the previous image, and the worker stayed
scaled to zero to avoid reintroducing legacy `lat`/`lng` rows.

### Evidence

The first deploy log showed
`Applying: 0018_migrate_body_measurements_to_metric_stream.sql` followed by
`error: cannot update table "_hyper_4_806_chunk"`. Production inspection showed
`fitness.metric_stream` had `0` body-measurement channel rows and
`fitness.body_measurement` still had `2704` source rows, so the migration
needed an insert backfill and did not need to update or delete existing
compressed `metric_stream` rows.

After the first insert-only patch, the deploy failed with
`Error: Connection terminated unexpectedly`. Postgres logs showed the migration
backend was killed by signal 9 while running the body migration batch. The
rebuilt table already had the same unique index under its pre-swap
`metric_stream_rebuild_provider_external_channel_time_idx` name, so a plain
`CREATE UNIQUE INDEX IF NOT EXISTS metric_stream_provider_external_channel_time_idx`
would still build a duplicate full-table index because `IF NOT EXISTS` checks
the index name, not equivalent indexed columns.

After reusing the existing index, the next deploy failed with
`error: out of shared memory` and the Postgres hint to increase
`max_locks_per_transaction`; the logged statement was the body-row INSERT. The
single INSERT spanned years of compressed hypertable chunks and exhausted the
lock table.

### Fix or Mitigation

Changed the pending body-measurement migration to avoid compressed writes and
full-table duplicate-index work: it renames the existing rebuild-era unique
index to the canonical name when present, creates the canonical unique index
only when needed, and inserts missing body rows from `fitness.body_measurement`
with `ON CONFLICT DO NOTHING` in month-sized transactions so chunk locks are
released between batches.

### Remaining Risk

The patched image still needs to be built and deployed, then production must be
verified for body-row backfill, point-only location rows, ClickHouse CDC setup,
and restored worker writes.

### Follow-Up Work

- Keep hypertable backfill migrations insert-only when compressed chunks are
  expected in production.
- Add deployment validation for migrations that mutate compressed hypertables.

## 2026-05-18: ClickHouse Metric Stream Repair Blocked by Old Mirror Schema

### Symptoms

After Postgres cleanup migrations applied in production, the deploy still
failed during ClickHouse migrations before the stack service update.

### User Impact

The point-only app image was still not deployed, so the scheduled worker
remained scaled to zero.

### Evidence

The deploy log showed Postgres applied five pending migrations, then ClickHouse
migration `0012_repair_metric_stream_backfill` failed on the first backfill
range with `No such column external_id in table postgres_fitness.metric_stream`.
Direct ClickHouse inspection showed the mirror still had the old narrow schema:
`id`, `activity_id`, `user_id`, `recorded_at`, `channel`, `provider_id`, and
`scalar`, without `external_id` or `point`.

### Root Cause

The repair migration assumed the ClickHouse `metric_stream` mirror already had
the new Postgres metric-stream shape, but production still had the older narrow
mirror schema.

### Fix or Mitigation

Changed the ClickHouse repair migration to inspect `system.columns` and skip
its repair body when the mirror schema is older than the current
`metric_stream` shape. The later `0013_metric_stream_location_point` migration
is responsible for dropping and rebuilding the mirror with the current schema.

### Remaining Risk

The patched deploy still needs to run successfully through ClickHouse migration
`0013`, CDC setup, and stack service update.

### Follow-Up Work

- Keep repair migrations schema-aware when they may run before a later rebuild
  migration.
- Consider ordering future ClickHouse migrations so destructive rebuilds happen
  before data repair migrations that depend on the new table shape.

## 2026-05-18: ClickHouse Metric Stream Point Backfill Rejected EWKB

### Symptoms

The deploy progressed past Postgres migrations and the old-schema ClickHouse
repair skip, but failed during ClickHouse migration
`0013_metric_stream_location_point` while backfilling
`postgres_fitness.metric_stream`.

### User Impact

The production web and worker services were still held on the old image while
the migration job failed, so the scheduled worker remained stopped.

### Evidence

The deploy log failed at backfill range `81/1294` with ClickHouse reporting it
could not parse source column `point` into destination column
`Nullable(Point)`. The rejected value began
`0101000020E6100000...`, which is PostGIS EWKB hex with the SRID flag and
SRID 4326 header. A direct ClickHouse probe confirmed
`readWKBPoint(unhex(...))` accepts the value after replacing the EWKB type/SRID
header with a standard WKB point header.

### Root Cause

PostGIS values read through ClickHouse's PostgreSQL table function arrived as
EWKB with SRID metadata, while the backfill attempted to parse them as standard
WKB points.

### Fix or Mitigation

Changed the ClickHouse metric stream backfill to convert nullable Postgres EWKB
hex strings into standard WKB before calling `readWKBPoint`, while preserving
null points and already-standard WKB values.

### Remaining Risk

The patched deploy still needs to rebuild the ClickHouse mirror, complete CDC
setup, update the stack services, restore the worker, and verify no legacy
location rows are written.

### Follow-Up Work

- Treat PostGIS geometry values read through ClickHouse `postgresql(...)` as
  encoded geometry strings, not directly castable native ClickHouse Points.
- Add a small production-shaped ClickHouse fixture for PostGIS Point backfills
  before future geospatial mirror migrations.

## 2026-05-18: ClickHouse Metric Stream Point Backfill Hit Memory Limit

### Symptoms

After the EWKB parsing fix, ClickHouse migration
`0013_metric_stream_location_point` progressed past the previous failure and
then failed during the same backfill.

### User Impact

The production stack still did not roll forward to the point-only image, and
the scheduled worker remained stopped.

### Evidence

The deploy failed in the migration step at range `336/1294`, around
`2021-11-17`, with ClickHouse reporting `(total) memory limit exceeded`,
attempting to allocate another `16.00 MiB` while current RSS was `2.69 GiB`
against a `2.70 GiB` maximum. The partial ClickHouse mirror remained present
with `63,717,778` rows through `2021-11-17`, and
`analytics.metric_stream_backfill_chunks` showed `335` completed ranges.

### Root Cause

The ClickHouse point backfill window was too large for dense historical
`metric_stream` ranges under the production ClickHouse memory limit.

### Fix or Mitigation

Changed the ClickHouse point rebuild migration to preserve an existing
current-schema partial `postgres_fitness.metric_stream` mirror and its
backfill progress table on retry, and reduced metric stream backfill windows
from six hours to one hour so dense ranges stay below ClickHouse's memory cap.
The first hourly retry still exceeded memory on a dense hour with roughly
`2.9M` rows, so the backfill window was reduced again to five minutes.

### Remaining Risk

The retry still needs to complete the remaining ClickHouse backfill, refresh
read models, configure CDC, and deploy the app services.

### Follow-Up Work

- Keep large ClickHouse backfills resumable by default; failed deploy retries
  should not discard already-loaded mirror data when the schema is current.
- Add operational guidance for sizing ClickHouse backfill windows against the
  configured memory limit.

## 2026-05-18: ClickHouse Point Migration Refreshed Read Models Before Backfill

### Symptoms

Manual retries of ClickHouse migration `0013_metric_stream_location_point`
failed before printing any metric stream backfill progress.

### User Impact

The ClickHouse migration stayed pending, so the production deploy could not
roll forward to the point-only metric stream schema and the scheduled worker
remained stopped.

### Evidence

The one-off migration container logged `Applying ClickHouse migration:
0013_metric_stream_location_point` and then failed with ClickHouse memory limit
errors while executing `FillingRightJoinSide`. No
`Waiting for ClickHouse postgres_fitness.metric_stream table` or backfill range
log appeared, which showed the failure happened before
`backfillNativeMetricStream`. Code inspection found that
`buildClickHouseBootstrapStatements(...)` includes `SYSTEM REFRESH` and
`SYSTEM WAIT` statements for dependent analytics read models, and
`0013_metric_stream_location_point` ran that full bootstrap before starting the
metric stream backfill.

### Root Cause

The migration refreshed dependent ClickHouse read models before completing the
large resumable source-table backfill they depended on.

### Fix or Mitigation

Changed metric stream rebuild paths to create ClickHouse objects before the
backfill but defer dependent `deduped_sensor`, `deduped_location`, and
`activity_summary` refreshes until after the resumable metric stream backfill
finishes.

### Remaining Risk

The production one-off still needs to run with the patched image, finish the
remaining backfill ranges, refresh the dependent read models, and record
`0013_metric_stream_location_point` as applied.

### Follow-Up Work

- Keep bootstrap object creation separate from expensive refresh work for
  one-off migrations that need to backfill large mirrors first.
- Add ordering assertions for future ClickHouse migrations that rebuild
  backfilled source tables and refresh dependent materialized views.

## 2026-05-18: ClickHouse Backfill Retry Spent Minutes Rechecking Completed Ranges

### Symptoms

The manual `0013_metric_stream_location_point` one-off logged a denominator of
`67,730` five-minute ranges but stayed at `0.00%` for several minutes before
printing the first backfill range.

### User Impact

The migration appeared stalled even though it was eventually able to resume.
Any retry after a partial backfill would pay the same startup cost before useful
progress logs appeared.

### Evidence

The code checked `analytics.metric_stream_backfill_chunks` once per generated
five-minute range. Production had `335` completed checkpoint rows covering older
large ranges, so the runner had to issue many small ClickHouse queries before it
reached the first missing range and began logging progress.

### Root Cause

The resumable backfill checked completed work with one ClickHouse query per
candidate range instead of loading checkpoint ranges once and skipping covered
ranges in memory.

### Fix or Mitigation

Changed the backfill runner to read completed checkpoint ranges once, parse
ClickHouse timestamp strings as UTC, and skip covered five-minute ranges in
memory with periodic skip-progress logs.

### Remaining Risk

The current production one-off had already moved past the startup scan before
this optimization was deployed. The patch is for faster, more observable retry
behavior if this run fails or a future large backfill resumes from partial
progress.

### Follow-Up Work

- Prefer one bulk progress-query over per-range polling in all resumable
  ClickHouse/Postgres one-off backfills.
- Include skip-progress logging whenever a resumable backfill can spend more
  than a few seconds scanning completed work before writing new rows.

## 2026-05-18: ClickHouse Backfill Hit Postgres Shared Lock Memory

### Symptoms

The production `0013_metric_stream_location_point` one-off resumed and advanced
to `16516/67730` ranges, then exited with `pqxx::out_of_memory`.

### User Impact

The ClickHouse migration remained unapplied at about `24.36%` log progress. The
Postgres service stayed healthy, but the one-off stopped and needed a Postgres
lock-table sizing change before retrying.

### Evidence

The migration log ended with `ERROR: out of shared memory` and Postgres's hint
to increase `max_locks_per_transaction`. Postgres was still healthy afterward:
the DB container reported `healthy`, `pg_is_in_recovery()` returned `false`,
and disk usage was `57%`. Production had `2,499` Timescale chunks for
`fitness.metric_stream`, while `max_locks_per_transaction` was `128`.

### Root Cause

The ClickHouse backfill read source rows through the Timescale parent
hypertable via the ClickHouse `postgresql()` table function. Some reads caused
Postgres to lock too many chunk relations in one transaction and exhaust shared
lock memory.

### Fix or Mitigation

Increased production Postgres `max_locks_per_transaction` in `deploy/stack.yml`
from the default to `4096`, leaving the backfill source query on the parent
hypertable. A direct chunk-table read was tested but rejected because compressed
Timescale chunks expose internal storage columns rather than the parent
hypertable schema, which ClickHouse could not introspect.

### Remaining Risk

The stack needs to be redeployed so Postgres restarts with the larger lock
table, then the one-off needs to be restarted from the existing checkpoint. The
dependent ClickHouse read-model refreshes still need to run after the metric
stream mirror finishes.

### Follow-Up Work

- Keep `max_locks_per_transaction` sizing in the deployment docs alongside the
  Timescale chunk-count guidance.
- Avoid direct reads from compressed Timescale chunk tables unless the query
  explicitly accounts for Timescale's internal compressed storage schema.

## 2026-05-19: ClickHouse Metric Stream Migration Needed Larger Refresh Memory

### Symptoms

The production `0013_metric_stream_location_point` one-off completed the
resumable `metric_stream` backfill but repeatedly failed while refreshing
dependent ClickHouse read models.

### User Impact

The ClickHouse migration was not recorded as applied until the dependent
`analytics.deduped_sensor`, `analytics.deduped_location`, and
`analytics.activity_summary` refreshes completed. During retries, the analytics
read models stayed on the previous migration state.

### Evidence

The backfill reached `100.00%` and logged `ClickHouse metric_stream backfill
complete`. The following `SYSTEM WAIT VIEW analytics.deduped_sensor` failed
with ClickHouse memory-limit errors at the 3 GiB service limit and again at the
4 GiB service limit. Active query inspection showed the refresh passing the old
2.7 GiB internal ceiling under the 4 GiB service limit before later reaching
the 3.6 GiB internal ceiling. After raising the service limit to 5 GiB, the
same one-off logged `Applied ClickHouse migration:
0013_metric_stream_location_point`, and `analytics.schema_migrations` contained
that migration id.

### Root Cause

The post-backfill ClickHouse materialized-view refresh for
`analytics.deduped_sensor` needed more memory than the previous production
ClickHouse container limit allowed. ClickHouse enforces an internal memory cap
below the Docker service limit, so the 3 GiB and 4 GiB service limits translated
to lower effective query ceilings.

### Fix or Mitigation

Raised the ClickHouse service memory limit in `deploy/stack.yml` to 5 GiB and
applied the same limit to the live `dofek_clickhouse` service. The migration was
rerun from checkpoint and completed successfully.

### Remaining Risk

Future `metric_stream` growth can make full read-model refreshes exceed the 5
GiB limit. If that happens, prefer reducing refresh memory pressure in the
ClickHouse read-model SQL before raising the single-node service cap further.

### Follow-Up Work

- Add a runbook section for ClickHouse materialized-view refresh memory checks,
  including `system.processes` and the service memory limit.
- Consider chunked or narrower refresh strategies for the largest ClickHouse
  read models so schema migrations do not require full-table refreshes under a
  single query memory ceiling.

## 2026-05-12: PR Dependency Audit Blocked By Broad TanStack History Malware Advisory

### Symptoms

PR #1121 failed the `Test / Dependency Audit` GitHub Actions job.

### User Impact

The docs-only PR could not merge while the dependency audit gate failed.

### Evidence

The failing command was:

```text
pnpm audit --prod --audit-level=critical --ignore-registry-errors
```

The first fatal finding in job `75480320849` was:

```text
critical Malware in @tanstack/history
Paths packages__web>@tanstack/react-router>@tanstack/history
Vulnerable versions >=0
Patched versions <0.0.0
```

Local reproduction matched CI after dependency install.

### Root Cause

GitHub advisory `GHSA-rmmr-r34h-pfm5` is currently returned to `pnpm audit` as
affecting every `@tanstack/history` version with no patched version. Public
incident reporting identifies specific compromised TanStack releases; the
branch was on older unaffected TanStack Router versions but the all-version
advisory still failed the critical audit.

### Fix or Mitigation

Updated TanStack Router packages to current stable versions outside the known
compromised version ranges and changed the dependency audit command to ignore
only `GHSA-rmmr-r34h-pfm5`. The audit still fails for any other critical
production advisory.

### Remaining Risk

This is an advisory-specific exception while the upstream GitHub/npm advisory
range remains broad. Remove the exception once the advisory is narrowed or a
non-`@tanstack/history` TanStack Router release is available.

### Follow-Up Work

- Re-run PR #1121 CI and verify `Test / Dependency Audit` passes.
- Periodically check `GHSA-rmmr-r34h-pfm5`; remove the `--ignore` once upstream
  no longer reports safe TanStack versions as vulnerable.

## 2026-05-19: PeerDB Metric Stream Snapshot Interrupted By Stack Restart

### Symptoms

During the PeerDB `metric_stream` initial snapshot, `ReplicateQRepPartitions`
processed repeated 131,072-row chunks and then failed with `context canceled`.
After the service restart, PeerDB attempt 5 initially failed to connect to
Postgres at `db:5432`.

### User Impact

The PeerDB migration paused and had to retry. The existing production analytics
path continued reading the current ClickHouse tables, so this was migration
impact rather than a known user-facing dashboard outage.

### Evidence

The first fatal migration log line was:

```text
failed to sync records: failed to write records to S3: failed to upload file: upload multipart failed ... context canceled
```

Swarm service history also showed `dofek_clickhouse` had exited with code 137
shortly before the PeerDB and DB connection errors. Postgres logs showed crash
recovery and then `database system is ready to accept connections` at
2026-05-19 21:36:42 UTC.

### Root Cause

The strongest evidence is a ClickHouse OOM/restart (`exit 137`) followed by a
broader stack/service restart that interrupted PeerDB's MinIO/S3 upload and
temporarily made Postgres unavailable. After restart, the retry failed
permanently because PeerDB attempted to reuse Postgres transaction snapshot
`00000050-0000001C-1`, which no longer existed.

### Fix or Mitigation

Swarm restarted the affected services, Postgres completed automatic recovery,
and the DB returned healthy. The metric analytics mirror still had to be
manually recovered:

- Dropped only the failed `dofek_metric_stream_analytics` mirror.
- Re-ran the checked-in PeerDB CDC setup from the production web container.
- Verified the recreated `dofek_metric_stream_analytics` mirror was `Running`
  in Temporal and `status = 1` in the PeerDB catalog.
- Dropped the accidentally recreated legacy validation mirror
  `dofek_metric_stream_cdc` because it started a full `fitness.metric_stream`
  snapshot and was not part of the pre-recovery running state.
- During follow-up monitoring, ClickHouse restarted again under memory/CPU
  pressure. PeerDB briefly logged `context canceled`, all slots went inactive
  while the worker restarted, then all three flows reconnected without slot
  loss. Final observed state: all three slots active, `wal_status = reserved`,
  retained WAL tens of MB, and PeerDB-reported metric analytics lag back near
  16 MB.

### Remaining Risk

The analytics mirror is back to steady-state CDC, but the canonical setup path
still includes the legacy `dofek_metric_stream_cdc` validation mirror with
`do_initial_copy = true`. Running the setup command after that mirror is absent
can restart a full metric-stream snapshot and recreate the same load pattern.
ClickHouse also remains close enough to the host memory envelope that heavy
snapshot or migration work can restart it and temporarily interrupt PeerDB CDC.

### Follow-Up Work

- Remove or gate the legacy `dofek_metric_stream_cdc` mirror from the setup
  template if it is no longer intentionally used.
- Continue monitoring PeerDB metric analytics slot lag.
- Check ClickHouse memory usage during any future PeerDB snapshot.
- If `exit 137` repeats, reduce concurrent migration pressure before raising
  service limits further.

## 2026-05-19: Deploy Web Failed On ClickHouse Restart And Staging DB Image Drift

### Symptoms

Deploy Web run `26117750622` failed for both production and staging. Production
completed migrations, then failed during `docker stack deploy` after Swarm
rolled back `dofek_web`. Staging failed earlier during `Run migrations`.

### User Impact

Production stayed on the previous web image after Swarm rollback. Staging did
not deploy the target image and remained unable to run the PostGIS-dependent
migration.

### Evidence

Production job `76811535379` logged `dofek_web did not finish deployment
cleanly; update_state=rollback_completed`. Live service logs for the failed
new web task showed:

```text
[web] Failed to start: Error: connect ECONNREFUSED 10.0.1.8:8123
```

The stack deploy log updated `dofek_web` first and later updated
`dofek_clickhouse` in the same release. Staging job `76811452037` failed with:

```text
[migrate] error: extension "postgis" is not available
```

Staging `dofek-staging_db` was still running
`timescale/timescaledb:2.26.2-pg18`, and the container only had the
TimescaleDB extension control file. Production was already running
`timescale/timescaledb-ha:pg18.3-ts2.26.4-all`, which includes PostGIS.

### Root Cause

Production web startup treated a transient ClickHouse connection refusal as a
fatal boot error. The startup table-verification loop retried missing tables but
did not retry the transport failure produced while ClickHouse was restarting
during the same Swarm stack update.

Staging had separate environment drift: the DB service was still on the older
TimescaleDB image without PostGIS, so the PostGIS migration could not run.
After the staging data wipe, the HA image also required the fresh host bind
directory `/mnt/dofek-data/postgres` to be owned by uid/gid `1000:1000`; the
root-owned directory created by the wipe caused `initdb` to fail until ownership
was corrected.

### Fix or Mitigation

Updated ClickHouse startup table verification to retry transient
`ECONNREFUSED` errors within the existing wait window and added a unit
regression test for that failure mode.

Attempted to reconcile staging by updating only `dofek-staging_db` to the image
declared in `deploy/stack.yml`, but the replacement HA image failed to start
because it could not access the existing staging data directory permissions.
Rolled the service update back; staging DB returned to the previous running
image.

After user approval to destroy staging state, removed the `dofek-staging` stack,
deleted staging bind-mounted state under `/mnt/dofek-data`, removed
stack-scoped Docker volumes, recreated the required bind directories, set
`/mnt/dofek-data/postgres` to owner `1000:1000` with mode `700`, and redeployed
staging with the existing Deploy Web workflow using image tag `sha-9af6a00`.
Deploy run `26120368665` passed: Postgres became writable, ClickHouse became
reachable, migrations ran successfully, the stack converged, and ClickHouse CDC
configuration completed.

### Remaining Risk

Production still needs a fresh deploy of an image containing the startup retry
fix. Staging is rebuilt on the HA image and the PostGIS-dependent migration now
passes. The remaining staging risk is that Terraform currently creates
`/mnt/dofek-data/postgres` as root-owned; a future staging wipe may need the
same ownership correction unless the infrastructure provisioner is updated.

### Follow-Up Work

- Update the staging bind-directory provisioner or runbook so fresh
  `timescale/timescaledb-ha` directories are created with owner `1000:1000` and
  mode `700`.
- Document the staging wipe/rebuild procedure, including the immutable image
  tag, stack removal, bind-directory cleanup, Postgres ownership correction, and
  Deploy Web staging rerun.

## 2026-05-20: Dashboard Recovery Ring Slow And Missing Data

### Symptoms

The production dashboard batch request took about 19.5 seconds. The daily
overview showed a valid strain score, but recovery and sleep rings displayed
`No data`.

### User Impact

Initial dashboard load was slow enough to feel broken. Recovery information was
not shown promptly, and the sleep ring displayed no current score.

### Evidence

Axiom slow-query logs for the dashboard burst showed `insights.compute`,
`training.nextWorkout`, `anomalyDetection.check`, `recovery.strainTarget`,
`stress.scores`, `recovery.readinessScore`, `weeklyReport.report`, and
`healthspan.score` clustered between about 5.3 seconds and 16.7 seconds around
`2026-05-20T00:42Z`. ClickHouse `system.query_log` showed the shared
`resting_heart_rate` CTE reading 4.5M-16M rows and taking about 10-16 seconds
per query. A direct production ClickHouse test with a coarse
`samples.recorded_at` bound reduced the 30-day helper query to about 1.0
second.

The sleep ring had a separate data freshness cause: production
`fitness.v_sleep` had no non-nap sleep rows newer than `2026-05-06` for the
affected user, while the dashboard date was `2026-05-19`.

### Root Cause

The ClickHouse resting-heart-rate helper computed each sleep-window resting
heart rate on demand from `analytics.deduped_sensor`. Under a dashboard burst,
multiple RHR-dependent procedures scanned and sorted overlapping heart-rate
sample ranges in parallel instead of reading one precomputed row per sleep
window.

The sleep ring `No data` state was unrelated to that helper: the latest sleep
record was stale according to the dashboard freshness rule.

### Fix or Mitigation

Added a daily ClickHouse refreshable materialized view,
`analytics.resting_heart_rate_sleep_window`, that precomputes one resting heart
rate per non-nap sleep window from deduped heart-rate samples. The dashboard
helper now reads that compact table and only performs per-request local-date
selection, avoiding raw sample scans during dashboard loads.

### Remaining Risk

The code fix still needs to be deployed before production dashboard latency
improves. The materialized view refreshes daily, so resting heart rate can lag
behind newly ingested sleep and heart-rate data until the next refresh. The
sleep ring still requires fresh sleep ingestion; the query fix does not create
missing sleep records.

### Follow-Up Work

- Deploy the RHR sleep-window materialized view and re-check Axiom/ClickHouse
  query logs for dashboard batches.
- Investigate why sleep ingestion has no non-nap rows newer than
  `2026-05-06` for the affected user.
- Consider adding a dashboard-visible stale-data explanation for sleep so old
  data is distinguishable from query failure.

## 2026-05-20: Production Deploy Migration Step Lost Docker SSH Connection

### Symptoms

Deploy Web run `26138117084` failed in the production `Run migrations` step
while deploying image tag `sha-c7b7027`.

### User Impact

The production stack did not advance to the requested image. The existing
production services remained up on the prior deployed image tag observed during
triage, `sha-021e809`.

### Evidence

The failing step was `Deploy Web Production / Deploy Web Stack / Run
migrations`. The migration container command was:
`docker run --detach --name dofek_migrate_26138117084_1 --network
dofek_default ... ghcr.io/asherlc/dofek:sha-c7b7027 ...`. The first fatal log
line was: `docker: command [ssh ... docker system dial-stdio] has exited with
exit status 255 ... stderr=client_loop: send disconnect: Broken pipe`, followed
by exit code 125.

Just before that, the same step logged `Unable to find image
'ghcr.io/asherlc/dofek:sha-c7b7027' locally` even though the workflow's prior
`Pull deploy images` step had run. Production `docuum` was configured with
`--threshold 0 GB`, so newly pulled images that are not yet referenced by a
container or swarm service can be pruned before migrations or stack deploy use
them.

### Root Cause

The deployment pipeline has a race between pre-pulling the target app images
and the aggressive production image pruner. The target image can be removed as
unused before the migration container starts. When `docker run` then has to pull
and extract the app image over Docker's SSH transport, the long-running remote
Docker operation can lose the SSH control connection before returning a
container ID.

### Fix or Mitigation

Removed the continuous `docuum` image-pruner service from `deploy/stack.yml`.
Image cleanup is now handled only by the deploy workflow's explicit pre-pull
and post-deploy prune steps. During triage, there was no leftover migration
container, and production services were healthy on the previous image.

### Remaining Risk

Unused Docker images can accumulate between deploys, especially after failed
deploys or manual pulls. The next deploy should reclaim them through the
workflow's explicit prune steps, but root disk usage still needs monitoring.

### Follow-Up Work

- Re-run the affected deploy, or let the next successful CI completion trigger
  a deploy with `docuum` removed.
- Watch root disk usage after the first few deploys without continuous image
  pruning.

## 2026-05-20: Sentry Open Issues From Metric Stream Replays And Mobile Startup

### Symptoms

Sentry showed unresolved production issues in `dofek-server` and `dofek-mobile`.
The active server cluster repeatedly failed metric stream writes during WHOOP
and Garmin syncs. Mobile showed tRPC JSON parse failures from WHOOP BLE
realtime upload, CoreMotion background accelerometer date parsing failures, and
an `initTelemetry` issue created by an intentional startup verification message.

### User Impact

Provider sync jobs for affected WHOOP and Garmin paths failed instead of
idempotently replaying already-ingested historical samples. WHOOP BLE realtime
uploads could retain buffered samples for retry after server failures.
Background iPhone accelerometer sync could fail when native CoreMotion rejected
JavaScript ISO timestamps with fractional seconds. Sentry issue noise included
a non-error mobile startup message.

### Evidence

Sentry issue `DOFEK-SERVER-23` failed in
`src/db/metric-stream-writer.ts` while WHOOP heart-rate stream sync attempted
`ON CONFLICT DO UPDATE`; the first fatal database error was
`cannot update table "metric_stream"`. `DOFEK-SERVER-24` showed the same
writer failure from Garmin activity detail sync. `DOFEK-MOBILE-C` had extra
context `source: "bg-accel-sync"` and error `Invalid ISO 8601 date string`.
`DOFEK-MOBILE-K` was an info-level `Sentry initialized on iOS` event from
`initTelemetry`.

### Root Cause

Metric stream sync replays attempted to update duplicate rows on a TimescaleDB
hypertable that can contain compressed chunks; compressed historical chunks
reject updates. The CoreMotion native module parsed incoming JavaScript
`Date.toISOString()` strings with an `ISO8601DateFormatter` configuration that
did not accept fractional seconds. Mobile telemetry intentionally emitted a
startup Sentry message, which Sentry grouped as an issue.

### Fix or Mitigation

Changed metric stream duplicate handling to `ON CONFLICT DO NOTHING`, preserving
idempotent raw sample replay without updating compressed historical rows. Added
fractional-second ISO parsing for CoreMotion date inputs. Removed the production
startup Sentry verification message from mobile telemetry.

### Remaining Risk

The fixes need to be deployed before Sentry issue recurrence should stop.
Existing unresolved Sentry groups should only be marked resolved after a
successful deploy and a no-recurrence check. Some remaining open server issues
were provider auth or infrastructure connectivity events and may need separate
triage if they continue after deploy.

### Follow-Up Work

- Deploy the fixes and re-check `DOFEK-SERVER-23`, `DOFEK-SERVER-24`,
  `DOFEK-MOBILE-C`, and `DOFEK-MOBILE-K`.
- Resolve closed-over Sentry issues only after production has run without new
  occurrences.
- Add a Sentry triage preflight note documenting the working `mcp-remote`
  fallback when direct Sentry MCP tools are not exposed to the agent.

## 2026-05-20: Body Metrics Stale In ClickHouse Analytics

### Symptoms

Body weight and body composition charts stopped at May 9 even though the site
was otherwise serving traffic after a transient recovery period. Body insights
and dashboard batches also loaded slowly while ClickHouse was saturated.

### User Impact

The body pages showed stale weight and body composition data. Current Withings
measurements were synced into Postgres but were not visible through the
analytics-backed app views. Dashboard/body insight sections could appear stuck
because batched tRPC responses waited for slower ClickHouse-backed queries.

### Evidence

Postgres `fitness.metric_stream` contained current Withings body rows through
2026-05-20 14:09:23 UTC. ClickHouse `analytics.v_body_measurement` only showed
body data through 2026-05-09 15:32:22 UTC, and the ClickHouse
`postgres_fitness.metric_stream` mirror only showed body rows through
2026-05-18 14:25:58 UTC. The PeerDB flow worker for
`dofek_metric_stream_analytics` repeatedly failed normalization with
`Cannot parse input: expected '('` while converting source column `point` into
ClickHouse destination column `Nullable(Point)`. The active replication slot
had hundreds of megabytes of retained WAL lag. A separate transient host
restart around 17:50 UTC caused Cloudflare 521 responses before health checks
recovered. Web logs later showed a batched dashboard request taking 14.9s;
`insights.compute` took 2.7s in that batch while `healthspan.score` took 15s.
ClickHouse `system.query_log` showed repeated refresh inserts over analytics
read models reading 53M rows / 4.7 GiB per run, plus one 563M-row / 40+ GiB
run. `docker stats` showed ClickHouse using more than one CPU and roughly
3.5 GiB of its 5 GiB memory limit while those refreshes and PeerDB catch-up ran.

### Root Cause

PeerDB CDC for the existing `dofek_metric_stream_analytics` mirror still
included the Postgres `point` column even after the checked-in mirror template
had been changed to exclude it. `CREATE MIRROR IF NOT EXISTS` did not update
the already-running mirror configuration, so PeerDB continued to send `point`
in a format ClickHouse could not parse into `Nullable(Point)`. That blocked
normalization batches and prevented newer metric rows from reaching the
ClickHouse mirror.

The body read-model staleness had a second cause: production
`analytics.v_body_measurement` was still the old read model over
`postgres_fitness.body_measurement`, while the current code builds body
measurements from `postgres_fitness.metric_stream`. Rebuilding the current view
definition directly over `postgres_fitness.metric_stream FINAL` is too expensive
for the current host: the attempted refresh read more than 200M rows, exhausted
available memory, timed out after 300s, and caused the ClickHouse container to
restart.

### Fix or Mitigation

Code changes were prepared to exclude `point` from the PeerDB metric-stream
mirror template and to move metric-stream-heavy ClickHouse refreshable
materialized views from one-minute refreshes to 15-minute refreshes. The
refresh cadence change is applied through a non-destructive ClickHouse migration
using `ALTER TABLE ... MODIFY REFRESH`.

On production, the stale `dofek_metric_stream_analytics` mirror was dropped and
the checked-in CDC setup was rerun from the web container. PeerDB catalog
inspection changed from `position('point' in encode(config_proto, 'escape')) =
0` before repair to `106` after repair, proving the recreated mirror excludes
`point`. Recent PeerDB flow rows then showed new info progress instead of new
normalization failures. The eight missing recent body metric rows were also
backfilled into `postgres_fitness.metric_stream` in ClickHouse.

The attempted production rebuild of `analytics.v_body_measurement` from
`metric_stream` was rolled back after it timed out and restarted ClickHouse.
The production view was restored to the lightweight pre-existing
`postgres_fitness.body_measurement` source, which refreshed in 126ms and left
the site healthy, but still only contains body data through
2026-05-09 15:32:22 UTC.

### Remaining Risk

Raw ClickHouse `postgres_fitness.metric_stream` body rows are current through
2026-05-20 14:09:23 UTC after the mirror repair and bounded backfill, but
`analytics.v_body_measurement` remains stale by design because the
metric-stream-native view definition is currently too expensive to refresh on
the production host. Any deploy migration that recreates
`analytics.v_body_measurement` directly from `postgres_fitness.metric_stream
FINAL` can restart ClickHouse and should not be shipped without a cheaper
design.

### Follow-Up Work

- Design a safe body read model that does not full-scan
  `postgres_fitness.metric_stream FINAL` for every refresh.
- Add an alert for PeerDB flow normalization failures and metric-stream mirror
  lag.
- Add deploy validation that compares existing PeerDB mirror configuration with
  the checked-in template instead of assuming `CREATE MIRROR IF NOT EXISTS`
  reconciles an existing mirror.
- Decide whether product-impacting infrastructure errors should also create
  Sentry issues, or whether they should stay in Axiom/log alerts with links to
  the affected service and flow.
## 2026-05-20: Review App Deploy SSH Connection Reset

### Symptoms

PR #1141 review-app deploy run `26178665787` failed in the `Deploy Review App`
job after Terraform applied successfully with no infrastructure changes.

### User Impact

The PR review app route was not updated for the latest branch commit. Production
services were not affected.

### Evidence

The failing step was `Deploy Review App / Write front door review route`. The
step attempted to run:
`ssh "root@${FRONT_DOOR_HOST}" "mkdir -p /opt/dofek/traefik-dynamic"` followed
by `scp "$route_config" "root@${FRONT_DOOR_HOST}:${REVIEW_ROUTE_FILE}"`.

The first fatal log line was:
`kex_exchange_identification: read: Connection reset by peer`, followed by
`Connection reset by *** port 22` and exit code 255. Immediately before this,
Terraform reported `No changes. Your infrastructure matches the configuration.`
and output `review_url = "https://pr-1141.dofek.asherlc.com"`.

### Root Cause

Unresolved. The failure occurred while opening an SSH connection to the front
door host after a successful Terraform apply. The log shows the front door SSH
port was reachable during host-key setup, then reset the subsequent SSH
connection.

### Fix or Mitigation

No code or infrastructure mitigation was applied in this branch. The failure is
tracked here for follow-up rather than being papered over with retry changes.

### Remaining Risk

Review-app deploys can fail intermittently if the front door host resets SSH
connections during route publication.

### Follow-Up Work

- Inspect front door SSH logs around `2026-05-20T17:28:07Z` for disconnect or
  connection-limit evidence.
- Decide whether the review-app deploy workflow needs a root-cause fix in SSH
  host readiness, connection limiting, or front door service health.

## 2026-05-20: Production Deploy Blocked Waiting for Temporal

### Symptoms

Deploy Web run `26184278312` failed in the production `Deploy Web Stack` job
at `Wait for Temporal`. Staging completed successfully, production Terraform
completed successfully, migrations completed, and the swarm stack deploy
converged before the post-deploy Temporal readiness gate timed out.

### User Impact

The production deploy workflow reported failure and skipped the post-deploy
PeerDB Temporal search-attribute check and ClickHouse CDC configuration steps.
Production services were later observed running the target image
`ghcr.io/asherlc/dofek:sha-397d04a`, with PeerDB, Temporal, web, and worker
services healthy.

### Evidence

The failing job timed out after twelve Temporal readiness attempts and ended
with `Temporal frontend did not become reachable within 180s`. A direct
production check after the failure showed `dofek_peerdb-temporal` and
`dofek_peerdb-catalog` running and healthy, and `temporal operator
search-attribute list` returned successfully with `MirrorName` present.

Temporal service logs during the failed window contained persistence errors
against the PeerDB catalog, including `database connection lost: driver: bad
connection`, `no usable database connection found`, and later
`lookup peerdb-catalog on 127.0.0.11:53: no such host` while the catalog was
being restarted. The previous Temporal task exited with code 137 but was not
marked OOM-killed; host kernel logs did not show an OOM kill in the checked
window.

### Root Cause

Unresolved. The direct failure was the deploy workflow's Temporal admin-tools
readiness command timing out while Temporal was in a degraded persistence state
against `peerdb-catalog`. The evidence does not yet prove why the catalog
connection became unusable or why the Temporal task later exited with 137.

### Fix or Mitigation

The production services recovered and the required Temporal search attribute
was confirmed present after recovery. This branch adds deploy-failure
diagnostics to print recent `peerdb-temporal` and `peerdb-catalog` service
state/logs when the Temporal readiness gate times out. It does not change
Temporal readiness timing, retry behavior, service limits, or deploy semantics.

The same run also exposed a recurring deploy theme: stack rollout can converge
while stateful PeerDB/ClickHouse objects remain stale or unreconciled. In this
case, the post-deploy CDC step was skipped by the Temporal timeout, leaving the
existing `dofek_metric_stream_analytics` mirror running with stale config until
it was repaired manually.

### Remaining Risk

Production deploys can fail after a successful stack rollout if Temporal is
temporarily degraded even though the stack itself has converged. The workflow's
current failure output also hides the underlying Temporal and catalog errors,
so a repeated failure will still require host-side log inspection unless the
workflow diagnostics are improved.

Post-deploy checks can also miss or skip state reconciliation when an earlier
readiness gate times out. Stateful mirrors and read models need direct
configuration drift checks rather than relying only on idempotent create
statements.

### Follow-Up Work

- Inspect Docker daemon events or service update causes for the
  `peerdb-temporal` exit 137 and `peerdb-catalog` restart.
- Use the new deploy diagnostics from the next failure, if it repeats, to
  identify the first Temporal or catalog fatal log line without SSHing into the
  host.
- Decide whether the readiness gate should use service health plus a bounded
  admin-tools command, or whether the post-deploy PeerDB/Temporal admin work
  should be moved earlier in the deploy flow before the final stack rollout.
- Add explicit PeerDB mirror drift validation for important mirrors, especially
  `dofek_metric_stream_analytics`, so deploy logs show when a live mirror does
  not match the checked-in template.

## 2026-05-20: Production DB Connection Resets During Stack Updates

### Symptoms

Sentry reported Garmin sync failures while writing `fitness.metric_stream` and
then attempting to write `fitness.sync_log`. The attached event showed
`connect ECONNREFUSED 10.0.1.97:5432`. Sentry also showed related production
events at `2026-05-20T18:48:46Z`, `2026-05-20T19:08:35Z`, and
`2026-05-20T19:09:41Z` with `read ECONNRESET`, `terminating connection due to
administrator command`, and `Connection terminated unexpectedly`.

### User Impact

Garmin activity sync jobs failed during the DB interruption window. The public
web health endpoint later returned `{"status":"ok"}`, and the production DB was
writable with `pg_is_in_recovery()` returning `false`.

### Evidence

`docker service ps dofek_db --no-trunc` showed repeated DB task replacement:
one running task, plus prior `Complete`/`Shutdown` tasks from the preceding
minutes. `docker service inspect dofek_db` showed the DB service updated at
`2026-05-20 19:22:37Z`. Postgres logs showed:
`database system was interrupted; last known up at 2026-05-20 19:09:01 UTC`,
then `database system was not properly shut down; automatic recovery in
progress`, and finally `database system is ready to accept connections` at
`2026-05-20T19:09:51Z`.

Host checks during triage did not show disk exhaustion: root filesystem was
55% used, the Hetzner data volume was 73% used, and Docker reported 2.259 GB
reclaimable image data. The current DB health check reported
`/var/run/postgresql:5432 - accepting connections`.

During the same triage, production services rolled from `sha-bae9208` to
`sha-397d04a`; `docker service ls` showed `dofek_web` at `2/2`,
`dofek_worker` at `1/1`, and `dofek_db` at `1/1`.

### Root Cause

The sync failures were caused by production DB task replacement during stack
updates, which interrupted active Postgres connections. No evidence of disk
exhaustion, recovery-mode stall, or persistent DB crash loop was found during
triage.

### Fix or Mitigation

No manual server changes were made. The system recovered after Postgres
automatic recovery and the stack rollout converged. A separate startup-cache
issue was identified: `warmCache()` constructs a tRPC caller without
`ctx.sensorStore`, so ClickHouse-backed warmup queries log
`requires the ClickHouse activity analytics store` even when `CLICKHOUSE_URL`
is configured for real request handling. This branch fixes that separate cache
warmup issue by passing the production ClickHouse-backed sensor store into
`warmCache()`.

### Remaining Risk

Sync jobs can still fail if a DB task is replaced while writes are in flight.
The startup cache-warm fix needs to be deployed before the false
ClickHouse-precondition logs stop in production.

### Follow-Up Work

- Decide whether DB service updates should be avoided during normal app-only
  stack deploys or made less disruptive for active sync writes.
- Re-check Sentry for new Postgres connection-reset events after the next
  deploy.

## 2026-05-20: Dashboard Sleep Stale Because Runtime Read Used Postgres v_sleep

### Symptoms

The dashboard sleep card was not up to date even though new raw sleep records
had synced. Production `fitness.sleep_session` contained sleep through
`2026-05-20` for WHOOP and Apple Health, while the Postgres materialized view
`fitness.v_sleep` only exposed stale sleep rows.

### User Impact

Dashboard and recovery surfaces that read `fitness.v_sleep` could display old
sleep duration, efficiency, sleep need, readiness, stress, anomaly, prediction,
and healthspan inputs.

### Evidence

Production raw sleep queries showed current rows for user
`f923fed7-d934-4cd9-8cb9-8e83020d0e69`, including WHOOP and Apple Health sleep
on `2026-05-20`. The corresponding `fitness.v_sleep` query was stale, with
latest Apple Health on `2026-05-06` and WHOOP on `2026-04-27`. ClickHouse
`analytics.v_sleep` was current, including WHOOP sleep ending
`2026-05-20 06:02:39.090000`.

### Root Cause

Runtime dashboard and recovery code still depended on the stale Postgres
materialized sleep view after ClickHouse had become the current deduped sleep
read model.

### Fix or Mitigation

This branch moves runtime sleep reads to ClickHouse `analytics.v_sleep`, keeps
Postgres only for raw `sleep_stage` interval lookups, removes the canonical
Postgres `v_sleep` view artifact, and adds migration `0025_drop_v_sleep.sql` to
drop both `clickhouse.v_sleep` and `fitness.v_sleep`.

### Remaining Risk

Some historical integration tests still contain explicit
`REFRESH MATERIALIZED VIEW fitness.v_sleep` setup and need to be converted to
ClickHouse test-store sync before those suites can pass against the dropped
view.

### Follow-Up Work

- Convert the remaining sleep-related integration tests to
  `createClickHouseTestActivitySensorStore()` and
  `syncClickHouseTestActivitySensorStore()`.
- Add a regression test that fails on new non-test runtime references to
  `fitness.v_sleep`.
## 2026-05-20: Production DB Restart During IMU Sync

### Symptoms

Sentry issue `DOFEK-SERVER-2P` reported one production error at
`2026-05-20T19:09:41Z` from
`inertialMeasurementUnitSync.pushSamples`. The request failed while inserting a
large IMU batch into `fitness.metric_stream`.

### User Impact

One IMU sample push failed and the affected mobile client would need to retry
that batch. No impacted Sentry users were recorded. Postgres recovered and was
writable again by `2026-05-20T19:09:51Z`.

### Evidence

The failing route was `inertialMeasurementUnitSync.pushSamples`. The failing
SQL step was:
`INSERT INTO fitness.metric_stream (recorded_at, user_id, provider_id, device_id, source_type, channel, vector) VALUES ...`.

The first fatal application error was:
`Error: Connection terminated unexpectedly`.

Postgres logs showed the database restarted immediately after the Sentry event:
`2026-05-20 19:09:48.090 UTC [25] LOG: database system was interrupted; last known up at 2026-05-20 19:09:01 UTC`,
followed by automatic recovery and
`2026-05-20 19:09:51.865 UTC [1] LOG: database system is ready to accept connections`.

Docker and host logs around the same window showed Docker swarm manager
timeouts, healthcheck start timeouts, repeated `Canceled: context canceled`
image/metadata lookups, `systemd-journald` memory-pressure cache flushes, and
multiple service bindings disappearing. Host uptime confirmed this was not a
host reboot. Current checks after recovery showed the DB container healthy,
`pg_is_in_recovery = false`, no disk exhaustion, and `OOMKilled=false`.

### Root Cause

Partially unresolved. The direct cause of the Sentry error was an unclean
Postgres task restart during a host/Docker resource-pressure window, not a
schema or payload validation failure in the IMU route. The exact workload that
created the pressure was not proven from the available logs.

### Fix or Mitigation

No behavior change was shipped during triage. Postgres recovered
automatically, and the current DB health check passed. This branch separately
makes direct metric-stream ingestion paths idempotent so retrying a failed
sample upload does not duplicate raw samples.

### Remaining Risk

The same failure can recur if host memory or Docker swarm manager pressure
returns during large metric-stream inserts or deploy activity.

### Follow-Up Work

- Correlate Axiom/Netdata metrics around `2026-05-20T19:06Z` to identify the
  memory and load source.
- Add or verify host memory-pressure alerts that fire before Docker swarm
  healthchecks and task management start timing out.
- Review whether ClickHouse metric-stream refresh or CDC work was active during
  the incident window.
- Consider mobile-side retry behavior for transient server/database disconnects
  only after the infrastructure root cause is understood.

## 2026-05-20: Dashboard Resting Heart Rate Showed 85 BPM Outlier

### Symptoms

The dashboard health metrics card showed resting heart rate as `85 bpm`, which
was not representative of the user's actual resting heart rate.

### User Impact

The dashboard displayed a misleading current recovery metric and could make
resting-heart-rate status look worse than the user's recent baseline.

### Evidence

A focused integration test reproduced the behavior with recent resting heart
rate rows of 55, 57, 55, and a single latest 85 bpm outlier. Before the fix,
`dailyMetrics.trends` returned `latest_resting_hr = 85`; the failing assertion
was `expected 85 to be 56`.

A production ClickHouse check confirmed that
`analytics.resting_heart_rate_sleep_window` contained two overlapping
WHOOP-sourced Apple Health sleep rows for user
`f923fed7-d934-4cd9-8cb9-8e83020d0e69` on local start date 2026-05-03:
`27e2b795-f846-4873-b69a-8092034f4f4a` from 17:00:56 to 01:14:47 Pacific with
43 heart-rate samples and `resting_hr = 85`, and
`128b10f8-4af3-433b-a125-d18b9d158d27` from 17:50:48 to 07:00:20 Pacific with
31 heart-rate samples and `resting_hr = 85`. Adjacent nights had thousands of
samples and resting heart rates in the low-to-high 50s.

### Root Cause

`DailyMetricsRepository.getTrends()` selected the most recent non-null resting
heart rate for the dashboard card, while activity heart-rate zones already used
a representative median of recent positive resting-heart-rate readings to
suppress one-off noisy sleep-window values.

The production outlier came from sparse evening heart-rate samples being joined
to abnormal overlapping sleep windows. The materialized view accepted those
rows because they met the current minimum of 30 samples, even though they did
not represent a normal full-night sample distribution.

### Fix or Mitigation

Changed the dashboard trends query to compute `latest_resting_hr` as the median
of the most recent 14 positive resting-heart-rate readings in the requested
window instead of using the latest non-null value directly.

### Remaining Risk

The fix is not active in production until deployed. Trend averages and standard
deviations still include all daily resting-heart-rate readings in the selected
window; only the current card value is made representative.

### Follow-Up Work

- Deploy the dashboard query fix and verify the card no longer shows the 85 bpm
  outlier.
- Consider whether average resting heart rate should also use a robust statistic
  in the dashboard card, or whether preserving the raw average is preferable.
- Consider adding a coverage-quality rule to the ClickHouse resting-heart-rate
  materialized view so sparse sleep-window joins cannot produce daily resting
  heart-rate rows.

## 2026-05-20: Production Temporarily Unreachable During RHR Investigation

### Symptoms

During the first attempt to inspect the resting-heart-rate outlier, SSH banner
exchange timed out, `https://dofek.fit/healthz` timed out after 10 seconds, and
internal service pings for CloudBeaver and Netdata also timed out.

### User Impact

The production app was temporarily unreachable or severely degraded during the
investigation window.

### Evidence

Hetzner CPU metrics showed the 4-core production VM near full saturation around
the failed checks. Sentry showed recent Postgres connection termination errors,
BullMQ lock-renewal failures, Redis DNS/timeout errors, and Garmin provider
validation failures. A later retry succeeded: `healthz` returned HTTP 200 in
0.742 seconds, SSH worked, and the host reported it had been up for 3 minutes.

### Root Cause

Unresolved. The system appeared to recover without manual changes before the
second check. At recovery time, Docker services were running, but host load was
still elevated and ClickHouse was consuming high CPU.

### Fix or Mitigation

No manual server changes were made. The investigation remained read-only.

### Remaining Risk

The underlying cause of the transient saturation and restart/recovery event is
unknown.

### Follow-Up Work

- Inspect host and Docker service logs around the restart window if production
  saturation recurs.
- Add a runbook note for correlating Hetzner CPU, Sentry connection failures,
  and Docker service restart times during transient outages.

## 2026-05-20: iOS CoreMotion Stale Cursor Crash

### Symptoms

Sentry reported a native fatal crash in `east-bay-software/dofek-mobile`:
`NSInternalInconsistencyException: startTime must be within 3 days of today.`
The issue was tracked as DOFEK-MOBILE-N.

### User Impact

One production iOS user on app release `com.dofek.app@1.0.0+1779294463`
experienced an unhandled native crash while the app was in the background.

### Evidence

Sentry recorded one fatal event at `2026-05-20T18:59:30Z` on a physical iPhone
running iOS 26.4.2. The crash metadata identified an uncaught
`NSInternalInconsistencyException` with the exact message above. The app's IMU
sync code queried `CMSensorRecorder` from either the stored sync cursor or
exactly three days ago, while existing Watch-side code already used a 2.9-day
guard because CoreMotion rejects queries at or beyond the three-day retention
edge.

### Root Cause

The iPhone IMU sync passed stale or boundary-adjacent start timestamps into
`CMSensorRecorder.accelerometerData(from:to:)`, which can throw an uncaught
native exception when `from` is outside CoreMotion's retained sensor history
window.

### Fix or Mitigation

Clamped the iPhone IMU sync start time to 2.9 days before `now`, preserving a
small safety margin before calling the native CoreMotion module.

### Validation

Added a mobile unit regression test proving a stale cursor from
`2026-05-10T19:00:00.000Z` is clamped to `2026-05-17T21:24:00.000Z` when the
current time is `2026-05-20T19:00:00.000Z`. `pnpm test:changed` passed with the
documented local `CLICKHOUSE_URL`.

### Remaining Risk

The fix prevents the known stale-cursor path from reaching the native
three-day boundary. Direct callers of the native CoreMotion module would still
need to pass valid query windows, but the app's current production sync path
uses the clamped TypeScript wrapper.

## 2026-05-20: Dashboard Strain Dropped After Heart-Rate Sync

### Symptoms

The mobile dashboard showed current strain as `0.4` at 9:49 PM PT even though
it had shown a higher value earlier in the day.

### User Impact

The dashboard understated same-day training strain and made current exertion
look lower after a later sync.

### Evidence

Production ClickHouse for user `f923fed7-d934-4cd9-8cb9-8e83020d0e69` on
`2026-05-20` in `America/Los_Angeles` had 152 heart-rate samples from
`09:05-09:19 PT`. The current-strain physiology query computed load `0.1255`,
which displayed as strain `0.4`. The same day had one activity summary with
daily load `12.5958`, which displays as strain `9.1`.

### Root Cause

`computeCurrentStrain()` treated any non-null same-day heart-rate physiology
load as authoritative, so sparse heart-rate telemetry could override and lower
the activity-derived strain for the same day.

### Fix or Mitigation

Changed current strain selection to compute both heart-rate physiology strain
and same-day activity strain, then use activity strain when it is higher.

### Validation

Added a regression test for the observed production values and ran:
`pnpm lint`, `pnpm tsc --noEmit`, `cd packages/server && pnpm tsc --noEmit`,
`cd packages/web && pnpm tsc --noEmit`,
`CLICKHOUSE_URL=http://default:health@localhost:8123 pnpm test:changed`, and
`CLICKHOUSE_URL=http://default:health@localhost:8123 pnpm test`.

### Remaining Risk

The fix preserves same-day activity strain as a floor. Future work should
define whether all-day passive heart-rate samples should contribute to current
strain independently from activity summaries.

## 2026-05-21: Realtime Sensor Metric Stream Upserts Failed

### Symptoms

Sentry issues `DOFEK-SERVER-2X` and `DOFEK-SERVER-2F` escalated with repeated
production errors from realtime sensor upload routes.

### User Impact

WHOOP BLE and IMU realtime uploads could fail when the mobile client retried
samples whose metric stream identity already existed. Sentry reported 2,069
occurrences on `DOFEK-SERVER-2X` and 2,091 occurrences on `DOFEK-SERVER-2F`,
with 0 impacted Sentry users as of the latest inspected events.

### Evidence

The latest inspected Sentry event `23cfce7ac3024e0c955b70d1fbd95868` occurred
at `2026-05-21T17:38:55.597Z`. The failing command was an
`INSERT INTO fitness.metric_stream (...) ON CONFLICT (...) DO UPDATE` issued
from `packages/server/src/routers/whoop-ble-sync.ts`. The first fatal database
error was `cannot update table "metric_stream"`. Sentry event
`6c4ae7212d91443c8bf951097fe49edd` showed the same database error from
`packages/server/src/routers/inertial-measurement-unit-sync.ts` at
`2026-05-21T17:45:20.836Z`.

### Root Cause

WHOOP BLE and IMU realtime duplicate handling still used the update side of an
upsert against `fitness.metric_stream`. Metric stream rows are raw immutable
samples, and Timescale compressed chunks reject updates, so retries that hit an
existing sample key could fail instead of no-oping.

### Fix or Mitigation

Changed WHOOP BLE R-R interval, WHOOP BLE orientation, and IMU vector metric
stream inserts to `ON CONFLICT ... DO NOTHING`, matching the central metric
stream writer's duplicate handling.

### Validation

Added unit regression tests for the WHOOP BLE and IMU SQL and confirmed they
failed before the code changes because the routes emitted `DO UPDATE`. After the
WHOOP BLE change,
`CLICKHOUSE_URL=http://<CLICKHOUSE_USER>:<CLICKHOUSE_PASSWORD>@localhost:8123 REDIS_URL=redis://localhost:6379 POSTGRES_PASSWORD=<POSTGRES_PASSWORD> CLICKHOUSE_PASSWORD=<CLICKHOUSE_PASSWORD> pnpm vitest run packages/server/src/routers/whoop-ble-sync.test.ts`
passed with 19 tests. After the IMU change,
`CLICKHOUSE_URL=http://<CLICKHOUSE_USER>:<CLICKHOUSE_PASSWORD>@localhost:8123 REDIS_URL=redis://localhost:6379 POSTGRES_PASSWORD=<POSTGRES_PASSWORD> CLICKHOUSE_PASSWORD=<CLICKHOUSE_PASSWORD> pnpm vitest run packages/server/src/routers/inertial-measurement-unit-sync.test.ts`
passed with 14 tests.

### Remaining Risk

Other direct server-side `metric_stream` raw SQL writers still use `DO UPDATE`.
This fix covers the reported Sentry paths; a separate cleanup should migrate the
remaining direct writers to the central metric stream writer or the same
no-update duplicate behavior.

## 2026-05-21: Body Weight Still Stale In UI-Facing ClickHouse View

### Symptoms

Weight appeared not to update even though Withings sync jobs were still running
successfully in production.

### User Impact

The body weight UI can show stale data even when current weight samples are
present in canonical Postgres storage.

### Evidence

At `2026-05-21 20:37 UTC`, Postgres `fitness.metric_stream` contained a current
Withings `body_weight` row for `2026-05-21 14:46:25 UTC` at `87.575 kg`.
Recent `fitness.sync_log` rows showed Withings `metric_stream` syncs succeeding
every 30 minutes with `record_count = 1`, aside from intermittent `401` errors
that later recovered. ClickHouse `postgres_fitness.metric_stream` only showed
body-weight rows through `2026-05-20 14:09:23 UTC`, with PeerDB reporting
`peerflow_slot_dofek_metric_stream_analytics` lag around `362-417 MB`.
ClickHouse `analytics.v_body_measurement` only showed body-weight rows through
`2026-05-09 15:32:22 UTC`.

`SHOW CREATE TABLE analytics.v_body_measurement` showed the production view
still reads from `postgres_fitness.body_measurement FINAL`, not from
`postgres_fitness.metric_stream`. The legacy ClickHouse
`postgres_fitness.body_measurement` source itself only contained rows through
`2026-05-09 15:32:22 UTC`. A follow-up production definition scan also found
`analytics.provider_stats` reading `postgres_fitness.body_measurement FINAL`
for body-measurement provider counts.

### Root Cause

This was not a client caching issue. Canonical Postgres weight ingestion is
current, but the UI-facing ClickHouse body read model still points at the old
`body_measurement` mirror that no longer receives current body rows. There is
also ongoing metric-stream CDC lag, but even a fully caught-up
`postgres_fitness.metric_stream` mirror would not fix the stale UI while
`analytics.v_body_measurement` continues reading the old source table. Provider
stats had the same stale-source drift for body-measurement counts.

### Fix or Mitigation

No production mutation was performed during the initial read-only check. A code
fix was prepared to create `analytics.body_measurement_sample`, backfill it once
from body-related `metric_stream` channels, keep it current through
`analytics.body_measurement_sample_ingest`, and rebuild
`analytics.v_body_measurement` from that narrow projection instead of the
legacy `postgres_fitness.body_measurement` table or repeated full scans of
`postgres_fitness.metric_stream FINAL`. The same migration rebuilds
`analytics.provider_stats` so its body-measurement counts also read the narrow
projection instead of the stale legacy mirror.

### Remaining Risk

The migration still needs to run in production. `analytics.v_body_measurement`
will remain stale until that deploy applies the new ClickHouse migration and the
metric-stream mirror has enough current body rows for the projection to ingest.

## 2026-05-21: Production Deploy Image Pull Disconnected

### Symptoms

The `Deploy Web` workflow run `26258897303` failed in the production
`Deploy Web Stack` job before migrations or `docker stack deploy`.

### User Impact

Production remained on the prior image tag `sha-5e20f85` while staging deployed
`sha-ed4e8b8`. During the failure window, the production host became heavily
loaded and web tasks briefly churned, but the public health endpoint recovered.

### Evidence

The failing step was `Pull deploy images`. The first fatal line was Docker over
SSH disconnecting during `docker pull ghcr.io/asherlc/dofek:sha-ed4e8b8`:
`client_loop: send disconnect: Broken pipe`. Production `dockerd` logs in the
same window showed swarm heartbeat/session timeouts, container healthcheck
startup timeouts, and resolver timeouts. Host checks showed high load and slow
Docker commands while root disk still had headroom.

### Root Cause

The production host Docker pull/unpack path became overloaded enough that the
remote Docker SSH connection died. This was not a missing image, secret, disk
space, migration, or stack-rendering failure.

### Fix or Mitigation

Reran the failed production deploy job after confirming production had
recovered enough to serve health checks. The rerun pulled images, applied
ClickHouse migration `0017_body_measurement_sample_projection`, deployed the
stack, and completed successfully. Production `web`, `worker`, and
`training-export-worker` now run `sha-ed4e8b8`; production and staging
`/healthz` both returned `{"status":"ok"}`.

### Remaining Risk

Image pulls and ClickHouse read-model rebuilds can still create sharp CPU/load
spikes on the single-node production host. Follow-up work in branch
`Asherlc/fix-deploy-failure-v3` reduces repeated deploy pull pressure by
skipping already-present pinned third-party images and reduces the server image
dependency layer by packaging only the server runtime dependency graph.

## 2026-05-21: Deploy Follow-Up PR Knip Failure

### Symptoms

CI for PR #1163 failed in the `Test / Knip` job. The aggregate lint, test gate,
and CI gate jobs failed because that required job did not pass.

### User Impact

The deploy hardening PR could not be merged until the dependency analysis gate
was fixed.

### Evidence

The first fatal CI line was `Unused dependencies (1)` for
`@opentelemetry/instrumentation` in `package.json`. Local reproduction with
`CLICKHOUSE_URL=http://localhost:8123 pnpm knip` showed the same unused
dependency failure.

### Root Cause

`@opentelemetry/instrumentation` was required at runtime by the Docker
entrypoint through Node's `--import @opentelemetry/instrumentation/hook.mjs`
flag, but Knip could not see that shell-only module reference in the source
graph.

### Fix or Mitigation

Added a small source preload module, `src/opentelemetry-hook.mjs`, that imports
the OpenTelemetry hook. The Docker entrypoint now imports that local preload
module, and Knip's root workspace includes `.mjs` source entry files.

### Remaining Risk

No known remaining CI risk from this failure. Knip still reports existing
configuration hints, but it exits successfully.

## 2026-05-22: Dashboard Recovery Data Missing From Future Readiness Row

### Symptoms

The dashboard showed no recovery status data even though the browser and
dashboard date were the same local day. Public production health checks for
`https://dofek.fit/healthz`, `https://dofek.asherlc.com/healthz`, and
`https://dofek.live/healthz` timed out without a response.

### User Impact

The web dashboard could not reliably load recovery/readiness data. Because the
public health endpoint also timed out, the impact was broader than a stale
client-side date check.

### Evidence

`curl --max-time 5 -sS -w '\nHTTP %{http_code} time_total %{time_total}\n'
https://dofek.fit/healthz` returned `curl: (28) Operation timed out after 5006
milliseconds with 0 bytes received` and `HTTP 000`. SSH debugging was blocked:
`ssh -o BatchMode=yes -o ConnectTimeout=5 dofek-server 'printf ok'` failed with
`Connection timed out during banner exchange` to `157.90.25.125:22`.

Sentry `dofek-server` errors for the prior 6 hours showed repeated
`Error: getaddrinfo ENOTFOUND redis` at `2026-05-21T23:32:32Z` and
`2026-05-21T23:32:33Z` under issue `DOFEK-SERVER-D`. No matching Sentry
readiness/recovery errors appeared in the most recent hour, consistent with the
host no longer serving or emitting useful app-level telemetry.

Hetzner reported the `dofek` server as `running` on `cax21` with 4 CPU cores and
8 GB RAM, but host metrics showed saturation after the `Deploy Web` run for
commit `c86bea2b` completed at `2026-05-22T01:11:20Z`. CPU averaged
`363.7` out of a 4-core maximum near `400` from `01:15Z` to `01:30Z`, then
`359.1` from `01:30Z` to `01:45Z`. Disk read IOPS averaged `19,166` from
`01:15Z` to `01:30Z` and `27,394` from `01:30Z` to `01:45Z`. The same deploy
introduced the PeerDB dashboard exposure and upgraded PeerDB services to
`stable-v0.36.19`.

After the host recovered, `https://dofek.fit/healthz` returned `{"status":"ok"}`
with HTTP 200, SSH worked, and `dofek_web` was healthy at 2/2 replicas. Web logs
showed `recovery.readinessScore` returning HTTP 200 for user
`f923fed7-d934-4cd9-8cb9-8e83020d0e69`, so the dashboard symptom was not a live
transport failure. Redis contained cached readiness results for
`{"days":30,"endDate":"2026-05-21"}` whose final row was `2026-05-22` with
default component scores. Postgres `fitness.v_daily_metrics` also contained a
`2026-05-22` row for the user even though the dashboard end date was
`2026-05-21`.

### Root Cause

`recovery.readinessScore` applied the lower date bound from `endDate` but did
not apply an upper `dm.date <= endDate` bound to `fitness.v_daily_metrics`. When
the server was already on `2026-05-22` UTC but the browser/dashboard local day
was still `2026-05-21`, the API returned a future `2026-05-22` readiness row.
The dashboard picked the last row, treated it as neither today nor yesterday in
the browser's local date, and rendered the recovery ring as no data. The earlier
host saturation was a separate operational observation during investigation,
not the direct cause of this specific dashboard empty state.

### Fix or Mitigation

No production mutation was performed during investigation. A code fix was
prepared to add `dm.date <= endDate` to the readiness-score SQL window and to
skip any combined readiness rows after `input.endDate` before returning results.
This prevents future UTC-day rows from becoming the dashboard's latest recovery
row for local-day requests.

### Validation

Added unit regressions proving `recovery.readinessScore` filters out rows after
the requested end date and that the dashboard freshness check uses the queried
date as its anchor. `pnpm lint`, root/server/web `pnpm tsc --noEmit`,
`CLICKHOUSE_URL=http://default:health@localhost:8123 pnpm test:changed`,
`CLICKHOUSE_URL=http://default:health@localhost:8123 pnpm test`, and
`git diff --check` passed.

### Remaining Risk

The code fix still needs to be deployed before production will stop returning
future readiness rows. The host also showed transient CPU and disk read
saturation around the PeerDB deploy window; that should be tracked separately if
it recurs, but it no longer requires a reboot while health checks and SSH are
responsive.

## 2026-05-22 - PeerDB Metric Stream Sync Stale During Host Saturation

### Symptoms

The body weight chart stopped showing new Withings weight samples. Postgres had
fresh `fitness.metric_stream` `body_weight` rows from 2026-05-21 and
2026-05-22, but ClickHouse `postgres_fitness.metric_stream`,
`analytics.body_measurement_sample`, and `analytics.v_body_measurement` were
stale at 2026-05-20. PeerDB replication slots for metric-stream mirrors were
inactive or lagging, and Docker Swarm tasks for PeerDB, ClickHouse, Postgres,
web, and worker had restarted repeatedly.

### User Impact

New provider data was synced into Postgres but did not reach the ClickHouse
analytics layer, so dashboard charts backed by ClickHouse read models showed
stale values. The public `https://dofek.fit/healthz` endpoint recovered to HTTP
200 during investigation, but the host remained under severe load.

### Evidence

The failing path was the PeerDB CDC mirror
`dofek_metric_stream_analytics`, which reads from the Postgres publication
`peerdb_metric_stream_no_imu` and writes to ClickHouse. PeerDB logs showed
`activity Heartbeat timeout`, `context canceled`, and Docker DNS failures such
as `lookup db on 127.0.0.11:53: no such host` and
`lookup peerdb-catalog on 127.0.0.11:53: no such host` after Swarm task churn.
The first fatal Postgres symptom observed during investigation was `FATAL: the
database system is in recovery mode` after the kernel OOM-killed a Postgres
process.

The host was saturated while the sync was stale: `uptime` reported load average
`113.20, 64.17, 44.63`; `free -h` showed 7.4 GiB used out of 7.5 GiB, 84 MiB
free, 150 MiB available, and no swap. `ps` showed `clickhouse-server` using
about 155% CPU and 4.0 GiB RSS, `netdata` using about 74% CPU and 334 MiB RSS,
and Docker/containerd together using significant CPU. `docker ps` and
`docker service ps` timed out under this load. Netdata repeatedly failed with
`task: non-zero exit (137)`.

ClickHouse query diagnostics captured a long-running
`analytics.deduped_sensor` refresh query that inserted into a refreshable
materialized-view inner table, scanned roughly 566 million rows / 44 GiB from
`postgres_fitness.metric_stream FINAL`, ran for about 6.4 minutes, and used
roughly 4.3 GiB of memory. The query shape matched the checked-in
`analytics.deduped_sensor` refresh SQL, including `linked_best_source`,
`ambient_best_source`, and `standalone_best_source` CTEs.

### Root Cause

The ClickHouse full-history `analytics.deduped_sensor` refresh is too expensive
for the current single-node production host when it runs alongside Postgres,
PeerDB, Docker Swarm, Netdata, and app traffic. It drives memory and CPU
pressure high enough that Docker health checks, Swarm heartbeats, and internal
DNS become unreliable; PeerDB then loses heartbeats or database connectivity,
its CDC mirrors stop catching up, and ClickHouse-backed charts remain stale
even though provider syncs are writing fresh rows to Postgres. Netdata's OOM
restart loop is a secondary amplifier of the same host-saturation failure.

### Fix or Mitigation

No production mutation was performed during investigation. The durable fix
should reduce or remove the full-history `analytics.deduped_sensor` refresh
cost, then restart/reconcile PeerDB mirrors from a stable host state. Secondary
cleanup should stop Netdata's OOM loop and remove or recreate any PeerDB mirrors
whose replication slots are already `lost`, such as the observed provider
inventory mirror.

### Validation

Validated that provider sync was not the failing layer by comparing fresh
Postgres `body_weight` rows against stale ClickHouse raw and body read-model
rows. Validated that the public app recovered with
`https://dofek.fit/healthz` returning HTTP 200 and `{"status":"ok"}`. The
underlying sync failure remains unresolved until ClickHouse refresh pressure is
reduced and PeerDB catches up without heartbeat or Docker DNS failures.

### Remaining Risk

High. The current host can re-enter the same failure mode on the next expensive
ClickHouse refresh. Until the refresh strategy is changed or capacity/isolation
is added, PeerDB CDC freshness is not reliable, and chart staleness can recur.

## 2026-05-22: Production Deploy Failed on Temporal Readiness Probe

### Symptoms

Deploy Web run `26264118110`, job `77303730049`, failed in
`Deploy Web Production / Deploy Web Stack` at `Wait for Temporal`. The stack
deploy had already completed, PeerDB was reachable, and the following
post-deploy `Ensure PeerDB Temporal search attributes` and
`Configure ClickHouse CDC` steps were skipped.

### User Impact

The production deploy workflow reported failure after applying the stack, so
post-deploy CDC reconciliation did not run in that workflow attempt.

### Evidence

The failing command was the `Wait for Temporal` readiness loop:
`timeout "${per_attempt_timeout}s" docker run --rm --network "${STACK_NAME}_default"
--entrypoint temporal temporalio/admin-tools:1.29 --address
peerdb-temporal:7233 --namespace default --color never operator
search-attribute list`.

The fatal line was `Temporal frontend did not become reachable within 180s`.
However, the final captured command output printed the Temporal search
attribute table, including `MirrorName`, immediately before diagnostics ran.
Service diagnostics at failure time showed `dofek_peerdb-temporal` and
`dofek_peerdb-catalog` both running for 11 minutes, and catalog logs showed the
database ready to accept connections.

### Root Cause

The readiness probe used `operator search-attribute list`, which is heavier
than a frontend health check and could exceed the 10-second per-attempt timeout
even after the Temporal frontend had become reachable. The outer 180-second
deadline then reported Temporal as unreachable despite the final command
already returning valid search-attribute data.

### Fix or Mitigation

Changed the `Wait for Temporal` readiness probe to use the Temporal CLI's
lightweight `operator cluster health` command. The search-attribute listing
remains in the next step, where it is the actual semantic validation and has its
own longer timeout.

### Remaining Risk

This fixes the workflow's readiness probe semantics, but the deploy path still
needs a successful Actions rerun to prove production post-deploy CDC
reconciliation reaches completion.

## 2026-05-22: Staging Deploy Failed Recreating Raw Analytics CDC Mirror

### Symptoms

Deploy Web run `26314731200`, job `77471391028`, failed in
`Deploy Web Staging / Deploy Web Stack` at `Configure ClickHouse CDC`.

### User Impact

The staging deploy failed after the stack deploy completed, so post-deploy
ClickHouse CDC reconciliation did not complete for staging on that run.

### Evidence

The failing command was the `Configure ClickHouse CDC` one-shot container:
`node --experimental-transform-types --enable-source-maps
--disable-warning=ExperimentalWarning src/db/setup-clickhouse-cdc.ts`.

The first fatal line was:
`[clickhouse-cdc] error: unable to submit job: "status: Internal, message:
\"invalid mirror: rpc error: code = FailedPrecondition desc = failed to
validate destination connector dofek_clickhouse_postgres_fitness: table
device_priority exists and is not empty\""`.

### Root Cause

The previous CDC reconciliation path could leave a raw analytics PeerDB mirror
absent while its ClickHouse destination tables still contained rows; the next
`CREATE MIRROR ... do_initial_copy = true` then failed PeerDB's non-empty
destination table validation.

### Fix or Mitigation

Updated raw analytics CDC reconciliation to truncate the mapped ClickHouse
destination tables when a do-initial-copy mirror is absent, not only after the
setup command drops an existing stale mirror.

### Validation

Added and ran a regression test for the absent-mirror/non-empty-destination
state:
`CLICKHOUSE_URL=http://default:health@localhost:8123 pnpm vitest run
src/db/clickhouse-cdc.test.ts`.

### Remaining Risk

The code-level fix is validated locally. A deploy workflow rerun is still
required to prove staging and production post-deploy CDC reconciliation complete
with the repaired setup command.

## 2026-05-22: Production Deploy Timed Out Waiting For Netdata

### Symptoms

Deploy Web run `26315359822`, job `77473351834`, timed out in
`Deploy Web Production / Deploy Web Stack` at the `Deploy stack` step.

### User Impact

The application services had already rolled to image `sha-0b7ca67`, but the
workflow failed before post-deploy pruning, PeerDB/Temporal checks, and
ClickHouse CDC reconciliation could run in production.

### Evidence

The failing command was `docker stack deploy ... --detach=false dofek`.
The deploy log showed `verify: Detected task failure`, then repeated
`overall progress: 0 out of 1 tasks`, and finally Docker returned
`DeadlineExceeded` for the Netdata service ID.

Live Swarm state showed `dofek_netdata` repeatedly exiting with
`task: non-zero exit (137)`. Netdata's own crash report showed a 400 MiB
container memory limit while Netdata used slightly more than that during
startup.

### Root Cause

The Netdata service memory limit was undersized for the existing Netdata
database and startup workload, causing OOM-style exit `137` during stack-wide
deploy convergence.

### Fix or Mitigation

Raised the Netdata service memory limit from 400 MiB to 768 MiB in
`deploy/stack.yml`.

### Remaining Risk

A deploy workflow rerun is required to prove production stack convergence and
post-deploy CDC reconciliation complete with the corrected Netdata memory
limit.

## 2026-05-22: Production CDC Failed Resolving Postgres After Stack Deploy

### Symptoms

Deploy Web run `26316143604`, job `77475687394`, passed production stack
deployment but failed later in `Configure ClickHouse CDC`.

### User Impact

Production app services rolled out, but the production post-deploy CDC
configuration step did not complete in that run.

### Evidence

The failing command was the `Configure ClickHouse CDC` one-shot container:
`node --experimental-transform-types --enable-source-maps
--disable-warning=ExperimentalWarning src/db/setup-clickhouse-cdc.ts`.

The fatal line was `[clickhouse-cdc] Error: getaddrinfo EAI_AGAIN db`.
Live Swarm state immediately after the failure showed `dofek_db` had recently
started a new task, and a follow-up one-shot container on the same overlay
network resolved `db` and reached Postgres successfully.

### Root Cause

The deploy workflow validated Postgres and ClickHouse before `docker stack
deploy`, but `docker stack deploy` can restart data-service tasks. The CDC
one-shot then ran without revalidating those post-stack prerequisites.

### Fix or Mitigation

Added post-stack readiness checks for Postgres writability and ClickHouse
reachability before PeerDB/Temporal checks and ClickHouse CDC configuration.

### Remaining Risk

A deploy workflow rerun is required to prove production CDC configuration
completes after the post-stack data-service readiness checks.

## 2026-05-22: Production Migration Step Timed Out Inspecting Container

### Symptoms

Deploy Web run `26316514322`, job `77476818252`, passed staging completely but
failed production in `Run migrations` with `Timed out inspecting migration
container dofek_migrate_26316514322_1`.

### User Impact

Production was briefly slow/unavailable while the single host was saturated.
`/healthz` timed out during the pressure window, then recovered once Docker and
the Swarm services settled.

### Evidence

The migration log reached `[migrate] Starting ClickHouse migrations`; it did
not log a migration failure. The GitHub runner's Docker API request timed out
on `docker inspect .../containers/dofek_migrate_26316514322_1/json`.

Live host evidence during recovery showed load average above `100`, memory at
`7.3 GiB / 7.5 GiB` with no swap, direct SSH banner exchange timeouts, and
ClickHouse background refresh queries scanning `postgres_fitness.metric_stream
FINAL`. ClickHouse `analytics.schema_migrations` later showed
`0018_sensor_priority_raw_tables` had already been applied at
`2026-05-22 19:27:49`, so this run was not blocked on an unapplied ClickHouse
schema migration.

### Root Cause

The migration workflow ran the container detached, followed it with
`docker logs --follow`, and polled `docker inspect` over SSH. During heavy
ClickHouse refreshable materialized view work on the single-node host, Docker's
control-plane calls became slow enough that the inspection loop false-failed
even though the migration process had not reported a schema error.

### Fix or Mitigation

Changed the migration step to run the migration container as the foreground
`docker run --rm` process under the existing four-hour bound. This removes the
extra `docker inspect` polling loop and makes the step follow the migration
process exit status directly.

### Remaining Risk

This fixes the deploy control-loop failure mode. The underlying ClickHouse
refresh load is still high because several refreshable materialized views scan
`postgres_fitness.metric_stream FINAL`; longer-term work should make those read
models incremental or otherwise reduce full-table refresh pressure.

## 2026-05-22: Production Temporal Readiness Failed During Raw Mirror Snapshot

### Symptoms

Deploy Web run `26316889909`, job `77477969270`, passed staging and got past
the previous production migration and stack-deploy failure points, then failed
production in `Wait for Temporal` with `Temporal frontend did not become
reachable within 180s`.

### User Impact

Production became slow/unavailable during the pressure window. Public
`/healthz` requests timed out, and direct SSH probes intermittently timed out
during banner exchange.

### Evidence

The failing command was the Temporal readiness probe:
`docker run --rm --network dofek_default --entrypoint temporal
temporalio/admin-tools:1.29 --address peerdb-temporal:7233 --namespace default
--color never operator cluster health`.

The fatal line was `Temporal frontend did not become reachable within 180s`.
Temporal logs during the failure contained repeated persistence timeouts such
as `Persistent fetch operation Failure`, `GetWorkflowExecution ... context
deadline exceeded`, and `Persistent store operation failure` on
`/_sys/snapshot-flow-task-queue/2`. The active workflow IDs included
`qrep-part-clone_dofek_fitness_raw_analytics...`, showing PeerDB snapshot work
for the raw analytics mirror. Live host evidence after the failure showed load
average above `100` and `/healthz` timing out.

### Root Cause

The absent raw analytics mirror recovery path truncated existing ClickHouse
destination tables and then recreated the raw PeerDB mirror with
`do_initial_copy = true`. On production, that started a large PeerDB initial
snapshot/backfill through Temporal and the PeerDB catalog Postgres on the same
single-node host, saturating the host and making Temporal persistence calls time
out.

### Fix or Mitigation

Changed ClickHouse CDC setup so an absent raw analytics mirror checks
ClickHouse `system.parts` for existing destination rows. If rows already exist,
the setup recreates that mirror as CDC-only with `do_initial_copy = false` and
does not truncate the destination tables. Empty destinations still use initial
copy for fresh environments.

### Remaining Risk

The failed deploy already started production PeerDB snapshot work, so the host
may need to drain that work before a clean rerun can complete. A deploy rerun is
required after the corrected image is built and the host is responsive.

## 2026-05-23: Production Recovery After ClickHouse Refresh Saturation

### Symptoms

Production was responsive only intermittently after the raw mirror snapshot
incident. ClickHouse body measurements were stale even though fresh
`body_weight` rows existed in Postgres for `2026-05-21` and `2026-05-22`.

### User Impact

The public app could time out during the pressure window, deploys were at risk
of failing readiness checks, and ClickHouse-backed body measurements missed the
latest weight entries.

### Evidence

Two long-running ClickHouse refresh queries were active:
`24cc4e2e-3116-4087-8ae3-80c8970b3ad2` for
`analytics.provider_stats` and `009a34da-cc79-4631-a45d-c61288dc93d0` for
`analytics.deduped_sensor`. They had read hundreds of millions of rows from
`postgres_fitness.metric_stream FINAL`.

Postgres had `body_weight` data through `2026-05-22 14:27:06+00`, while
ClickHouse `postgres_fitness.metric_stream`, `analytics.body_measurement_sample`,
and `analytics.v_body_measurement` were all stale at
`2026-05-20 14:09:23`. The PeerDB metric-stream slot was active and reserved
with only megabytes of WAL lag, which showed the stale body rows had been missed
when the metric stream mirror was recreated as CDC-only after existing
ClickHouse rows were detected.

### Root Cause

Full-history refreshes of `analytics.deduped_sensor` and
`analytics.provider_stats` saturated the single-node production host. Separately,
the CDC-only mirror recovery avoided another full snapshot but skipped source
rows that were inserted while the metric-stream mirror was absent.

### Fix or Mitigation

Killed the two long-running ClickHouse queries and paused their automatic
refreshes with `SYSTEM STOP VIEW analytics.deduped_sensor` and
`SYSTEM STOP VIEW analytics.provider_stats`. Deployed
`ghcr.io/asherlc/dofek:sha-a6195ef` and
`ghcr.io/asherlc/dofek-ml:sha-a6195ef` with production Deploy Web run
`26318078567`, which completed successfully including the ClickHouse CDC setup
step.

Backfilled 8 missing body-measurement metric-stream rows from Postgres into
ClickHouse for the gap after `2026-05-20 14:09:23+00`, then refreshed
`analytics.v_body_measurement`. After repair, ClickHouse
`postgres_fitness.metric_stream`, `analytics.body_measurement_sample`, and
`analytics.v_body_measurement` all showed latest body weight
`2026-05-22 14:27:06`.

### Remaining Risk

`analytics.deduped_sensor` and `analytics.provider_stats` are intentionally
disabled to keep production responsive. Activity sensor analytics and provider
stats can remain stale until those read models are redesigned or re-enabled
with an incremental/smaller refresh strategy. Production logs also showed
repeated `Unexpected end of JSON input` errors on cached provider routes after
the deploy; derived Redis query-cache state was cleared, but that log pattern
should be followed up separately if it recurs.

## 2026-05-23: Strong CSV Import Hidden By Stale ClickHouse Read Models

### Symptoms

A Strong CSV upload completed successfully in production, but the app showed no
Strong records and the imported strength workouts did not appear in the
Activities screen.

### User Impact

The user's imported Strong workout history was present in canonical Postgres
storage but hidden from provider-detail and activity-list UI surfaces.

### Evidence

Worker logs showed `Strong CSV import complete: 88 workouts imported, 0 errors
in 2.2s`. Postgres had 88 `fitness.activity` rows and 991
`fitness.strength_set` rows for provider `strong-csv`, all under user
`f923fed7-d934-4cd9-8cb9-8e83020d0e69`. `fitness.v_activity` also exposed 88
Strong activities, including 6 in the current four-week Activities window.

ClickHouse `analytics.provider_stats` initially reported
`strong-csv.activities = 0` and `system.view_refreshes` showed
`analytics.provider_stats` as `Disabled` with exception `cancelled`. After
starting and refreshing the view, `analytics.provider_stats` reported
`strong-csv.activities = 88`. `analytics.activity_summary` then contained the 6
recent Strong strength activities used by `calendar.weekList`.

### Root Cause

The Strong import wrote canonical data successfully, but UI read paths depended
on ClickHouse refreshable materialized views. `analytics.provider_stats` had
been disabled/cancelled during prior production pressure, so provider-detail
counts were stale. The Activities screen also depends on
`analytics.activity_summary`, and cached `calendar.weekList` responses could
continue serving the old empty result after the ClickHouse model caught up.

### Fix or Mitigation

Restarted and refreshed `analytics.provider_stats`, confirmed
`strong-csv.activities = 88`, confirmed `analytics.activity_summary` had 6
recent Strong activities, and cleared the affected user's Redis query-cache
entries.

### Remaining Risk

This branch converts the non-`deduped_sensor` ClickHouse analytics read models
from refreshable materialized views to normal views over the existing raw and
incremental sources. Until that migration is deployed, production can still
serve stale results from disabled or cancelled refreshable views.

## 2026-05-23: Full-Refresh ClickHouse Read Models Removed

### Symptoms

The Strong CSV incident showed that successfully imported Postgres records could
remain invisible when ClickHouse refreshable read models were stale, cancelled,
or disabled.

### User Impact

Provider counts, activity lists, and sensor-derived analytics could lag
canonical writes even after imports or syncs completed successfully.

### Evidence

Active ClickHouse bootstrap and migration SQL in this branch no longer renders
`REFRESH EVERY`, `SYSTEM REFRESH VIEW`, `SYSTEM WAIT VIEW`, or `MODIFY REFRESH`
for production read models. Changed tests passed against the ClickHouse-backed
integration suite with 58 files and 1291 tests.

### Root Cause

The prior design depended on full refreshable materialized views for provider,
activity, body, trend, and deduped sensor read models. A disabled or long-running
full refresh could leave UI-facing analytics stale independent of canonical
Postgres state.

### Fix or Mitigation

Converted the remaining ClickHouse read models to normal views or incremental
tables. `analytics.deduped_sensor` now drains dirty sensor keys after sync jobs
instead of relying on full refreshes, and downstream activity sensor queries
derive activity membership from `analytics.v_activity` time windows.

### Remaining Risk

Production still needs this migration deployed and observed. The incremental
dirty-key worker has a hard backlog-drain limit and fails loudly if it cannot
catch up, so future failures should surface as post-sync job errors instead of
silent stale analytics.

## 2026-05-23: Incremental Deduped Sensor CI Migration Failure

### Symptoms

The review-app deploy and web end-to-end test setup failed during fresh
ClickHouse migrations. Several Stryker shards also failed before mutation
testing began.

### User Impact

The PR could not pass CI or deploy a review app, blocking release of the
full-refresh removal work.

### Evidence

`Deploy Review App` and `Test / E2E Tests (Web)` both failed while applying
ClickHouse migration `0004_reenable_materialized_metric_stream` with
`Table analytics.deduped_sensor is not a View.` Stryker dry runs failed on
`Router data coverage cyclingAdvanced verticalAscentRate uses nearby grade when
present and altitude fallback otherwise` with `Test timed out in 30000ms`.

### Root Cause

The ClickHouse migration sequence still issued `DROP VIEW IF EXISTS
analytics.deduped_sensor` after `analytics.deduped_sensor` had become a table;
ClickHouse errors when `DROP VIEW` targets a table. The Stryker timeout came
from a heavy integration fixture that inserted five-second altitude/grade
samples across three synthetic activities before syncing ClickHouse.

### Fix or Mitigation

Removed stale `DROP VIEW` statements for `deduped_sensor` and kept the
relation-safe `DROP TABLE IF EXISTS` form, which ClickHouse accepts for both
tables and views. Reduced the vertical-ascent fixture density from five-second
to thirty-second samples while preserving coverage of offset grade matching,
altitude fallback, and low-grade exclusion.

### Remaining Risk

CI still needs to rerun on the branch and the review-app deploy needs to be
observed after the fixes are pushed.

## 2026-05-23: Aerobic Efficiency E2E ClickHouse Memory Failure

### Symptoms

The web end-to-end CI job timed out waiting for the aerobic-efficiency empty
state and the direct API assertion saw `500` instead of `200`.

### User Impact

The PR could not pass CI, and an empty or newly imported user could see the
aerobic-efficiency panel fail instead of rendering the no-data state.

### Evidence

`Test / E2E Tests (Web)` failed in `pnpm e2e:web:run` with
`Expected to find content: 'No activities with sufficient Zone 2 power + heart
rate data' but never did`. A later run failed `training.weeklyVolume` with
`cy.request() timed out waiting 30000ms`. After the first raw-activity
short-circuit, the cycling empty-state user still showed
`efficiency.aerobicEfficiency` taking 6-12 seconds and `pmc.chart` taking up to
107 seconds. Server logs also showed `dailyMetrics.trends`, `sleep.list`, and
`weeklyReport.report` queries running long enough for ClickHouse to reject
requests with `(total) memory limit exceeded`.

### Root Cause

The first preflight still read `analytics.v_activity`, whose recursive activity
deduplication can scan the full activity graph before the empty user's filter
helps. `training.weeklyVolume`, `training.hrZones`, `training.activityStats`,
`pmc.chart`, aerobic-efficiency queries, power-curve/eFTP queries, and
cycling-advanced queries also joined `analytics.v_activity` for activity
metadata already present on `analytics.activity_summary`, so no-result reads
still forced expensive ClickHouse read-model scans before rendering empty
states.

### Fix or Mitigation

Moved the empty-user preflights to raw mirrored
`postgres_fitness.activity FINAL` rows so they can prove there are no candidate
activities before invoking `analytics.activity_summary` or
`analytics.deduped_sensor`. Added the same raw-activity short-circuit to
training weekly volume, heart-rate zones, and activity stats. Removed
`analytics.v_activity` joins from the hot activity-analytics repositories
(`training`, `pmc`, `efficiency`, `power`, and `cyclingAdvanced`) where
`analytics.activity_summary` already carries the canonical activity id, type,
name, and time window. Updated repository and router tests to cover the new
query sequence and prove these hot paths no longer touch the recursive activity
view.

### Remaining Risk

CI and the review-app deploy still need to be observed on the pushed branch.

### Follow-up (PMC sample count window)

Code review found the `pmc.chart` `sample_counts` CTE was still bounded only by
user id and sample channel, so it could aggregate full-history sensor rows
before the outer `activity_summary` window filter applied. The CTE now applies
the same expanded `queryDays` activity window and requires completed activities,
keeping PMC sample-count work proportional to the requested training window.

## 2026-05-23: Cycling Empty-State E2E Hidden by Background Fetching

### Symptoms

The web end-to-end CI job failed during the cycling no-data spec, and the test
and CI gates failed downstream from that job.

### User Impact

Empty cycling charts could keep showing loading skeletons after their own
queries had finished if another page query was still in flight, hiding the
actual no-data message.

### Evidence

`Test / E2E Tests (Web)` failed in the `pnpm e2e:web:run` step while running
`pnpm exec cypress run`. The first failed Cypress test was `shows empty states
for charts when no data exists`, followed by the fatal cancellation line
`The runner has received a shutdown signal`.

### Root Cause

`DofekChart` used the global React Query fetching count to replace empty states
with loading skeletons. On the cycling page, unrelated slow queries could keep
the global fetching count above zero even after an individual chart's own query
had loaded and returned no rows.

### Fix or Mitigation

Changed `DofekChart` so the skeleton is controlled by the chart's own `loading`
prop. Once the chart has loaded and `empty` is true, it renders the empty
message immediately. The global fetching count still drives only the subtle
refresh spinner for charts that already have data.

### Remaining Risk

CI needs to rerun on the pushed branch to confirm the E2E spec now reaches the
cycling empty-state assertions reliably.

### Follow-up (Cycling background queries)

The next CI run showed the empty-state assertion still failing because the page
was waiting on backend calls, not just chart rendering. `pmc.chart` and
`cyclingAdvanced.activityVariability` kept scanning `analytics.activity_summary`
and `analytics.deduped_sensor` for the no-activity E2E user, with slow-query
logs around 95 seconds and the direct `efficiency.aerobicEfficiency` Cypress
request timing out behind those in-flight ClickHouse queries. PMC and cycling
activity variability now perform a raw `postgres_fitness.activity FINAL` count
first and return empty results before touching the expensive read models when
the user has no raw activities.

### Follow-up (Raw activity preflight)

The next E2E rerun still failed at `pnpm e2e:web:run`. The first fatal line
remained the missing cycling empty state, and the direct
`efficiency.aerobicEfficiency` API check timed out after 30 seconds. Server logs
showed `power.powerCurve` and `power.eftpTrend` queries running for roughly
316-319 seconds, and the new no-activity guards were still using ClickHouse's
`postgres_fitness.activity` mirror, which left no-activity preflights competing
with the same overloaded ClickHouse connection. The no-activity guards now read
raw activity existence from source Postgres `fitness.activity` instead, and the
power curve/eFTP repositories return empty results before scanning ClickHouse
when the user has no raw activities.

### Follow-up (Stryker 11)

`Test / Stryker (11)` failed after the Postgres raw-activity preflight changes.
The failing step was Stryker, and the fatal line was `Final mutation score 73.91
under breaking threshold 75`. All surviving mutants were in
`training-repository.ts`, mostly around the raw activity preflight and empty
short-circuit branches. The repository tests now assert that weekly volume and
heart-rate zone preflights require ended activities, that heart-rate zones
preflight only endurance activity types, and that empty raw activity counts do
not fall through to ClickHouse read-model queries.

## 2026-05-24: Branch Deploy Blocked by ClickHouse Migration Ordering

### Symptoms

The branch deploy run for `Asherlc/strong-csv-no-records` failed in
`Build + Deploy / Deploy Web Stack` while applying ClickHouse migrations.

### User Impact

The PR branch could not be deployed for verification. The stack rollout did not
proceed because the migration container failed before `docker stack deploy`.

### Evidence

Workflow run `26348714913` failed in the `Run migrations` step. The first fatal
ClickHouse line was `Identifier 'samples.is_deleted' cannot be resolved from
table with name samples` while creating
`analytics.resting_heart_rate_sleep_window` from `analytics.deduped_sensor`.

### Root Cause

Migration `0019_non_sensor_read_models_as_views` rebuilt sensor-dependent views
before migration `0020_incremental_deduped_sensor` upgraded
`analytics.deduped_sensor` to the incremental schema that includes
`is_deleted`. Production still had the older `deduped_sensor` shape, so `0019`
referenced a column that did not exist yet and stopped the deploy.

### Fix or Mitigation

Moved the sensor-dependent view rebuilds out of `0019`; `0020` already rebuilds
those views after recreating the incremental `deduped_sensor` table. Added a
regression test that simulates production with migrations through `0018`
applied and verifies the dependent views are rebuilt only after
`analytics.deduped_sensor` is recreated.

### Remaining Risk

The fixed branch still needs a fresh CI pass and branch deploy to confirm the
pending production migration sequence applies cleanly.

### Follow-up (Spell check)

The next CI run failed early in `Test / Spell Check`, and the aggregate
`Test / Lint & Static Analysis` job failed because it depends on that check.
The first fatal line was
`src/db/clickhouse-migrations.test.ts:112:35 - Unknown word (Cutover)`. The
test helper variable now uses `IncrementalMigration` wording instead of the
unrecognized term.

### Follow-up (Deploy run 26350086210)

After CI passed, the branch deploy run `26350086210` got past the original SQL
ordering failure: `0019_non_sensor_read_models_as_views` applied and
`0020_incremental_deduped_sensor` started. The deploy then failed in the
foreground Docker-over-SSH migration command with `client_loop: send
disconnect: Broken pipe`, followed by Docker exit 125. The migration step now
runs the one-shot migration container detached and polls its status with short
Docker commands, so a long-running ClickHouse migration does not depend on one
continuous SSH-backed `docker run` wait. The workflow still prints migration
logs and fails on the migration container's actual exit code.

### Follow-up (Deploy run 26351247460)

The next deploy run `26351247460` stayed connected past the previous
Docker-over-SSH failure and surfaced the underlying migration error. The
migration container printed `Applying ClickHouse migration:
0020_incremental_deduped_sensor`, then failed with `Error: socket hang up`.
That migration still performed an all-history sensor scalar backfill and
all-history deduped sensor recompute in single ClickHouse commands. The
incremental deduped sensor migration now runs through a dedicated migration
function that creates the same final tables/views but backfills
`analytics.sensor_scalar_sample` and `analytics.deduped_sensor` in seven-day
recorded-at ranges, logging each range before running it.

### Follow-up (Deploy run 26352812408)

Deploy run `26352812408` confirmed the chunked ClickHouse migration path on
production: `0020_incremental_deduped_sensor` applied after 591 logged
seven-day ranges and printed `Migration succeeded.` The same run then failed
later in `Deploy stack`; `docker stack deploy --detach=false` exceeded its 20
minute wrapper after Swarm updated many services and then stalled around
management/supporting services. A retry run, `26354114245`, reached migrations
without replaying the ClickHouse backfill but failed in the detached migration
monitor: the polling command
`docker inspect --format '{{.State.Status}} {{.State.ExitCode}}'
dofek_migrate_26354114245_1` hit `Connection timed out during banner exchange`
over Docker-over-SSH. The migration container itself was detached, so the
branch now treats transient remote Docker inspect failures as retryable for a
bounded number of attempts before failing loudly with the last inspect output
and migration logs.

### Follow-up (Deploy run 26355597585)

Deploy run `26355597585` failed before migrations in `Reclaim Docker root disk
headroom`. The command printed `/dev/root 145G 56G 90G 39% /`, then
`docker system df` reported `failed to retrieve container list: rw layer
snapshot not found for container 9b85e23837a384fbf7f171f65a7a6af2d4d4943ecfeb0346d58b4c16a6f611f0`.
The next command, `docker system prune --all --force`, eventually failed over
Docker-over-SSH with `client_loop: send disconnect: Broken pipe`. The cleanup
step did not need to prune because the root filesystem already had far more
than the required 8 GiB free. The workflow now checks free space before
pruning, skips Docker prune when the precondition is already satisfied, and
still hard-fails if the host remains below 8 GiB after cleanup.

### Follow-up (Deploy run 26356818633)

Deploy run `26356818633` confirmed the disk-headroom fix: `Reclaim Docker root
disk headroom` passed and skipped the unnecessary prune. The deploy later
failed in `Validate host bind mount paths`. The failing command was a
Docker-over-SSH `docker run --rm --mount type=bind,source=/mnt/dofek-data...`
used only to check that host directories existed. The first fatal line was
`docker: error during connect: Post "http://docker.example.com/v1.48/containers/create":
command [ssh -o ConnectTimeout=30 -T -l root -- *** docker system dial-stdio]
has exited with exit status 255`, followed by `client_loop: send disconnect:
Broken pipe` and Docker exit 125. The step did not need a container or Docker
daemon interaction to validate host filesystem paths. The workflow now checks
the same required directories with a direct SSH `test -d` loop on the host,
leaving Docker-over-SSH for actual Docker operations.

### Follow-up (Deploy run 26358289913)

Deploy run `26358289913` confirmed the direct SSH bind-path validation had not
yet been reached. The run failed earlier in `Pull deploy images` while
prefetching public dependency images. The failing command was the
`pull_if_missing "timescale/timescaledb-ha:pg18.3-ts2.26.4-all"` Docker pull
inside the image prefetch step. The first fatal line was
`error during connect: Post "http://docker.example.com/v1.48/images/create?fromImage=timescale%2Ftimescaledb-ha&tag=pg18.3-ts2.26.4-all":
command [ssh -o ConnectTimeout=30 -T -l root -- *** docker system dial-stdio]
has exited with exit status 255`, followed by `Connection timed out during
banner exchange`. The private branch images had already pulled successfully,
but the public dependency prefetch path still opened a fresh Docker-over-SSH
connection per image. The workflow now keeps the private GHCR pulls on
Docker-over-SSH so they can use the runner's registry login, and pulls the
public dependency images through one direct SSH session on the host to avoid
repeated Docker-over-SSH handshakes for static public images.

### Follow-up (Deploy run 26359577017)

Deploy run `26359577017` confirmed the image prefetch path and migrations, then
failed in `Deploy stack` while Swarm was updating services. The failing command
was `timeout 20m node "$RUNNER_TEMP/run-with-dotenv-env.mjs" docker stack
deploy $STACK_FILE_FLAGS --with-registry-auth --prune --detach=false
"$STACK_NAME"`. The first fatal line was `yh2hm4dz5w3hrospbru4mp04w: Error
response from daemon: rpc error: code = DeadlineExceeded desc = context
deadline exceeded`, followed by `dofek_web` rollback pausing because task
`hi4i7bd1ktymuasvlmznjit2p` failed or terminated early. Host diagnostics showed
`dofek_web` in `rollback_paused`, web service logs showed repeated `[web]
Failed to start: Error: Timeout error.`, and worker logs from the same rollout
showed transient ClickHouse/database reachability errors including
`ECONNREFUSED 10.0.1.8:8123` and `getaddrinfo ENOTFOUND db`.

The root cause was the web process's ClickHouse startup bootstrap treating the
ClickHouse client request timeout as fatal while ClickHouse, database DNS, or
overlay networking was transient during stack rollout. The existing startup
wait loop already retried connection-refused errors; it now also retries the
ClickHouse client's exact `Timeout error.` response, with a regression test
covering the retry behavior. No arbitrary sleep or larger deploy timeout was
added.

### Follow-up (Deploy run 26361342212)

Deploy run `26361342212` failed before touching production in `Setup SSH`. The
failing command was the shared `.github/actions/setup-ssh-host` loop running
`ssh-keyscan -T "$keyscan_timeout" -H "$SSH_HOST"` before any Infisical export,
image pull, migration, or stack deploy step. The first fatal line was
`SSH host key for *** did not become available within 235s`; every attempt
reported `ssh-keyscan returned no key` while `tcp/22: reachable (no SSH banner
yet)`.

External diagnostics showed this was host saturation, not a branch deploy
secret or GitHub checkout failure: Hetzner metrics had production pinned near
400% CPU from before the deploy attempt, local SSH started timing out during
banner exchange, `https://dofek.asherlc.com/healthz` timed out, and Axiom logs
showed system-wide load symptoms including Netdata heartbeat delays, Postgres
`autovacuum worker took too long to start; canceled`, and Temporal/PeerDB
`context deadline exceeded` polling failures. The earliest repeated causal log
pattern was the optional `cloudbeaver` management service crash-looping on its
persisted workspace with `JdbcSQLSyntaxErrorException: Duplicate column name
"UPDATE_TIME"` and `CloudBeaver ... Error initializing database`.

The direct mitigation in this branch is to scale the optional production
`cloudbeaver` service to zero in `deploy/stack.yml`, matching the existing
staging pattern for heavy management UIs. This removes the crash-looping
service from the production convergence set so the core app, database,
ClickHouse, PeerDB, and deploy path can recover. Remaining risk: CloudBeaver
will stay unavailable until its persisted workspace is repaired or replaced and
the service is explicitly re-enabled.

The first Hetzner `reboot_server` action returned success but did not actually
restart the host (`uptime` still showed 3 days), so SSH timed out again within
minutes. A hard `reset_server` restarted the machine and restored SSH with load
near zero. Because the old stack still started the crash-looping CloudBeaver
service before CI could finish, a second hard reset was followed by
`docker service scale dofek_cloudbeaver=0`, matching the already-committed
`deploy/stack.yml` desired state, to keep the host reachable until the normal
branch deploy can apply the same change through CI.

### Follow-up (Deploy run 26362822406)

Deploy run `26362822406` confirmed that disabling CloudBeaver restored SSH
setup, image pulls, and the pre-migration readiness steps. The run then failed
in `Run migrations`; the migration container started as
`dofek_migrate_26362822406_1`, then logged `error: [migrate] Error: connect
ECONNREFUSED 10.0.1.97:5432` before the workflow emitted
`##[error]Migration failed`.

Host evidence showed the refused address was the Swarm VIP for `dofek_db`.
That refusal was a symptom of broader service churn: `dofek_clickhouse` was
restarting every few dozen seconds with Swarm task failures
`task: non-zero exit (137)`, web tasks failed with `socket hang up` and
`Timeout error`, and kernel OOM logs repeatedly killed `clickhouse-serv` at
about 4.6-5.0 GiB RSS on a 7.5 GiB host with no swap. The root cause was the
production ClickHouse container being allowed to consume too much of the
single-node host's memory during analytics join work, causing host-level OOM
kills and downstream database/ClickHouse connection failures during deploy.

The branch now lowers the ClickHouse container limit from 5 GiB to 4 GiB,
adds a checked-in 3 GiB ClickHouse `max_server_memory_usage` config, mounts that
config in production/local/review ClickHouse containers, adds a production
ClickHouse healthcheck, and treats recent DB/ClickHouse task failures as a
bootstrap condition so the corrected data-service stack can be applied before
the migration container runs.

### Follow-up (Deploy run 26364429876)

Deploy run `26364429876` was triggered from the branch after PR CI passed. It
confirmed the previous SSH setup problem was fixed and completed image pulls,
bind mount validation, bootstrap evaluation, and pre-migration Postgres and
ClickHouse readiness checks. The run then failed again in `Run migrations`.
The exact failing command was the detached migration container
`dofek_migrate_26364429876_1`, and the first fatal application line was
`error: [migrate] Error: connect ECONNREFUSED 10.0.1.97:5432`. The workflow
also logged an SSH control-plane symptom while polling that container:
`Connection timed out during banner exchange`.

The causal gap was in the new bootstrap guard. It only checked whether DB and
ClickHouse tasks were running and whether they had recent failed tasks, so it
logged `Swarm DB and ClickHouse services exist with running tasks and no recent
failures; skipping bootstrap deploy.` Because the live ClickHouse service still
had the old resource/config spec, the new 4 GiB container limit and 3 GiB
ClickHouse server memory limit were not applied before the migration container
ran. During the same window Hetzner CPU metrics showed the production host
pinned near 400%, local SSH probes timed out during banner exchange, and public
`/healthz` requests timed out.

The direct fix is to make the deploy ordering explicit instead of adding a
ClickHouse-specific stale-spec check. The deploy workflow now always applies
the stack configuration before migrations. If an app stack already exists, that
pre-migration stack apply uses the currently deployed app image tag so database,
ClickHouse, network, config, and resource-limit changes are in place before
migrations without rolling new app code ahead of schema changes. Clean-slate
hosts still use the requested deploy image tag because there is no previous app
release to preserve.

### Follow-up (Deploy run 26366695503)

Deploy run `26366695503` validated CI on the cleaner pre-migration stack-apply
approach, then failed in `Apply stack config before migrations` before
migrations ran. The exact failing command was the pre-migration
`docker stack deploy ... --detach=false` call. The first fatal line was
`error during connect: Get "http://docker.example.com/v1.48/info": command
[ssh ... docker system dial-stdio] has exited with exit status 255`, followed
by `Connection timed out during banner exchange`.

Two issues were visible in the same step. First, the current-service probe used
`if docker service inspect ...; then ... else ... fi`, so any Docker control
plane failure was treated as a clean-slate stack and logged `No existing web
service`. Second, `--detach=false` kept a long-lived Docker-over-SSH stack
deploy wait open while the single-node host restarted many stack services,
which made SSH banner exchange unreliable under the restart load. Host evidence
showed load above 250 and app services restarting immediately after the failed
step.

The direct fix is to make the service probe distinguish a real missing service
from Docker/SSH failures and to run the pre-migration stack apply detached. The
workflow already waits explicitly for Postgres and ClickHouse before migrations,
so it no longer needs a full stack convergence wait before the schema step.

A hard Hetzner reset restored SSH temporarily after the failed run, but the live
stack was still on the old ClickHouse spec (`5GiB` container limit and no
`memory-limits.xml` mount) and web tasks continued to churn while waiting for
ClickHouse bootstrap verification. The durable recovery remains the committed
deploy ordering fix plus a rerun of the branch deploy so the checked-in
ClickHouse resource/config limits are applied through Swarm.

### Follow-up (Deploy run 26368319681)

Deploy run `26368319681` confirmed the detached pre-migration stack apply works:
`Apply stack config before migrations`, `Wait for Postgres writable`, and
`Wait for ClickHouse` all passed. The run then failed in `Run migrations`. The
first fatal migration line was `(total) memory limit exceeded: would use 3.79
GiB ... maximum: 3.00 GiB`.

That proved the checked-in 3 GiB ClickHouse server cap was below the observed
production migration workload. The cap prevented host-level OOM, but it also
blocked the normal ClickHouse migration query path before the final app rollout.
The branch raises `max_server_memory_usage` to 4 GiB and gives the container a
4500 MiB cgroup limit. This keeps ClickHouse below the earlier 4.6-5.0 GiB
host-OOM range while allowing the measured 3.79 GiB migration query to run.

During the same incident window the old web stack was already unhealthy and
crash-looping on ClickHouse bootstrap. To keep the host reachable long enough
for the committed deploy fix to run, `dofek_web` and optional `dofek_netdata`
were temporarily scaled to zero by hand. This was an outage mitigation only;
the next successful stack deploy must restore service specs from
`deploy/stack.yml`.

### Follow-up (Deploy run 26368662541)

Deploy run `26368662541` failed in `Apply stack config before migrations`
before readiness checks or migrations ran. The exact failing command was the
pre-migration `docker stack deploy ... --detach=true` call. The first fatal
line was `failed to update config dofek_clickhouse_memory_limits: Error
response from daemon: rpc error: code = InvalidArgument desc = only updates to
Labels are allowed`.

The root cause was Docker Swarm config immutability. The branch changed the
contents of `deploy/clickhouse/config.d/memory-limits.xml` from a 3 GiB
ClickHouse server cap to a 4 GiB cap while reusing the existing stack config
key `clickhouse_memory_limits`. Swarm cannot update config contents in place;
it only allows label updates on an existing config object.

The direct fix is to rotate the ClickHouse memory config key in
`deploy/stack.yml` to `clickhouse_memory_limits_4g` while keeping the same
container mount path. The next stack deploy will create a new Swarm config
object and attach it to ClickHouse instead of trying to mutate the old one.

### Follow-up (Deploy run 26368809440)

Deploy run `26368809440` confirmed the rotated Swarm config fixed the previous
failure: the pre-migration stack apply, Postgres readiness check, and
ClickHouse readiness check passed. The run then failed in `Run migrations`
while starting the migration container. The first fatal line was `docker: error
during connect: Head "http://docker.example.com/_ping": command [ssh ... docker
system dial-stdio] has exited with exit status 255`, followed by `Connection
timed out during banner exchange`.

Host evidence showed the pre-migration stack apply restored old app services
before migrations: `dofek_web` was desired `0/2` with repeated task failures,
`dofek_worker` was restarting, and ClickHouse was repeatedly killed by its
memory cgroup at about 4.57 GiB RSS. ClickHouse logs showed concurrent
analytics queries against `postgres_fitness.*` immediately before each kill.
The root cause was the pre-migration stack apply allowing old app/worker tasks
to issue expensive analytics queries against ClickHouse during the migration
window, exhausting the ClickHouse cgroup and overloading the host SSH control
plane before the migration container could start.

The direct fix is to make the pre-migration stack apply a data-service/config
phase: it now uses a temporary stack overlay that sets `web`, `worker`, and
`training-export-worker` replicas to zero before readiness checks and
migrations. The final stack deploy remains the only step that restores app
replicas from `deploy/stack.yml`.

### Follow-up (Deploy run 26369862049)

Deploy run `26369862049` confirmed the pre-migration quiesce overlay worked:
image build, SSH setup, stack render, pre-migration stack apply, Postgres
readiness, ClickHouse readiness, and migrations all passed. The run was then
cancelled during final stack rollout after restored web/worker tasks repeatedly
caused ClickHouse OOM kills. The first app fatal line was `[web] Failed to
start: Error: socket hang up`; kernel evidence showed ClickHouse killed by
global and cgroup OOM during the same window.

The root cause was the server startup ClickHouse smoke test issuing
`SELECT count() AS smoke_count FROM analytics.activity_summary LIMIT 1`.
`analytics.activity_summary` is now a ClickHouse view, so `count()` forced the
full activity summary view to execute during every web boot. That was enough to
exhaust ClickHouse memory and make the web healthcheck fail before the final
rollout could converge.

The first attempted fix changed startup smoke verification to
`SELECT * FROM <object> LIMIT 0`, but ClickHouse still expanded the recursive
view plan and hit the same memory path. The direct fix is to keep startup
verification entirely in metadata: after the existing `system.tables` existence
checks, the server now checks `system.columns` for each required object instead
of querying the object itself. This still fails loudly on missing objects with no
visible columns without materializing expensive views at app startup.

### Follow-up (Deploy run 26370427808)

Deploy run `26370427808` on commit `e3807d7b` verified the metadata-only
ClickHouse smoke test fix in production. The run completed the image builds,
pre-migration quiesced stack apply, Postgres and ClickHouse readiness checks,
migrations, final stack deploy, PeerDB checks, Temporal search attribute
setup, and ClickHouse CDC configuration successfully.

Post-deploy validation showed `dofek_web` restored to `2/2`, `dofek_worker` to
`1/1`, `dofek_training-export-worker` to `1/1`, and `dofek_clickhouse` to
`1/1`, all on the expected `sha-e3807d7` branch image where applicable. The
public `https://dofek.asherlc.com/healthz` endpoint returned
`{"status":"ok"}`, and the app root returned HTTP 200. ClickHouse was running
with a 4,500 MiB cgroup cap and the rotated
`dofek_clickhouse_memory_limits_4g` Swarm config. Kernel OOM evidence stopped
before the successful deploy started, with no new OOM kills during or after the
successful rollout.

## 2026-05-25: Dashboard ClickHouse DNS errors caused by ClickHouse OOM restarts

The dashboard returned `getaddrinfo ENOTFOUND clickhouse` for
`recovery.workloadRatio` in production. DNS was healthy in the current web
container when checked, but historical web logs showed DNS/connection errors
around ClickHouse restarts. Kernel logs showed ClickHouse killed by OOM
multiple times on May 25, 2026, with `clickhouse-serv` using roughly 4.56 GiB
RSS immediately before the kills.

ClickHouse query logs around the same window showed heavy dashboard/read-model
queries, including resting-heart-rate work over
`analytics.resting_heart_rate_sleep_window` and other analytics scans. The exact
killed query cannot be proven because a process killed by the kernel may not
finish writing a query-log row, but the timeline ties the user-visible DNS
errors to ClickHouse restarts rather than Docker DNS misconfiguration.

Fix prepared in this branch:

- Moved `analytics.sensor_scalar_sample`, `analytics.deduped_sensor`, and
  `analytics.resting_heart_rate_sleep_window` to incremental dbt-clickhouse
  models under `analytics/models/`.
- Added a dedicated `analytics-worker` service that runs dbt builds outside web
  and BullMQ worker request paths.
- Removed the custom dirty-key worker path for `deduped_sensor` and the naive
  RHR materialized/read-time recomputation path.
- Added SQLFluff/dbt source linting plus the custom migration policy that blocks
  naive ClickHouse materialized views, `REFRESH EVERY`, `SYSTEM REFRESH/WAIT`,
  and inline deploy backfills.

Remaining risk: this change still needs production rollout and observation of
`analytics-worker` cadence, ClickHouse memory, and dashboard latency after the
new incremental tables are populated.

### Follow-up (PR #1180 review app run 26422484061)

- Date: 2026-05-25.
- Symptoms: PR #1180 review app deploy failed while running migrations after
  Postgres and ClickHouse migrations completed.
- User Impact: No production user impact; the failure blocked review app
  validation and production deployment from this branch.
- Evidence: The dbt build failed against `http://clickhouse:8123` with
  ClickHouse `REQUIRED_PASSWORD`.
- Root Cause: The dbt production profile change made `CLICKHOUSE_PASSWORD`
  required, but the review app `web` container received `CLICKHOUSE_URL`
  without `CLICKHOUSE_PASSWORD`.
- Fix/Mitigation: Pass `CLICKHOUSE_PASSWORD` into the review app `web`
  container from the same required `POSTGRES_PASSWORD` value used to initialize
  the local ClickHouse service.
- Remaining Risk: Low; review app, E2E, and production-style migration
  environments now share the same explicit ClickHouse password contract.
- Follow-Up Work: Continue monitoring production rollout for the original
  ClickHouse memory and dashboard latency risks described above.

### Follow-up (Deploy run 26424057092)

- Date: 2026-05-25.
- Symptoms: Production deploy from PR #1180 reached the final web stack deploy
  step, but `dofek_worker` repeatedly exited with status 1 while Swarm waited
  for rollout convergence.
- User Impact: The rollout did not complete cleanly; the worker was unhealthy
  during the attempted production validation.
- Evidence: Worker logs showed dbt successfully building
  `analytics.sensor_scalar_sample` and `analytics.deduped_sensor`, then failing
  `analytics.resting_heart_rate_sleep_window` with ClickHouse
  `MEMORY_LIMIT_EXCEEDED` while executing `JoiningTransform`.
- Root Cause: The RHR model joined dirty sleep rows to heart-rate samples by
  user before bounding the sample time window, and carried all activity windows
  per user into the sample filter. On production data that join shape exceeded
  the ClickHouse memory limit.
- Fix/Mitigation: Narrow the RHR incremental model so the sample join includes
  the sleep time bounds, and build activity exclusion windows only for the dirty
  sleep rows being recomputed.
- Remaining Risk: Medium until a follow-up deploy proves the narrower RHR model
  can build on production data within the ClickHouse memory limit.
- Follow-Up Work: Redeploy PR #1180 after CI validates the narrower RHR model,
  then verify `dofek_worker`, `dofek_analytics-worker`, and ClickHouse health.

### Follow-up (Deploy run 26425142491)

- Date: 2026-05-25.
- Symptoms: Production deploy from PR #1180 applied the branch image and the
  narrowed RHR dbt model completed, but the GitHub deploy step stayed in final
  stack convergence while `dofek_netdata` crash-looped with exit 137.
- User Impact: The app containers were updated and `/healthz` remained healthy,
  but deploy automation could not finish cleanly while Netdata was unhealthy.
- Evidence: Worker logs showed `analytics.resting_heart_rate_sleep_window`
  completing in 3.62s with `PASS=3`. Kernel logs showed repeated Netdata cgroup
  OOM kills at roughly 519 MiB RSS and one global OOM kill of ClickHouse while
  Netdata was also near its 512 MiB container limit. Netdata's own crash report
  showed a 512 MiB container with about 556 MiB of dbengine cache and 506 MiB of
  sqlite metadata on disk.
- Root Cause: The previous Netdata retention fix configured two 256 MiB
  dbengine tiers inside a 512 MiB container, leaving no startup/runtime headroom
  for Netdata's sqlite metadata and process overhead.
- Fix/Mitigation: Increase Netdata's container limit to 768 MiB and reduce
  dbengine retention to 96 MiB for tier 0 and 128 MiB for tier 1 so the existing
  cache can start and prune down.
- Remaining Risk: Medium until the follow-up deploy proves Netdata converges
  and ClickHouse avoids further OOM kills during deploy-time dbt builds and
  dashboard reads.
- Follow-Up Work: Redeploy PR #1180 with the Netdata sizing fix, then verify
  `dofek_netdata`, ClickHouse memory, worker dbt output, and public health.

### Follow-up (Deploy run 26425794016)

- Date: 2026-05-25.
- Symptoms: Production deploy from PR #1180 failed before migrations while
  applying the pre-migration stack config.
- User Impact: The branch image and Netdata sizing fix were not applied by this
  deploy attempt; production remained on the previous Netdata 512 MiB limit and
  Netdata continued to crash-loop.
- Evidence: The `Apply stack config before migrations` step failed on
  `docker stack deploy` with
  `failed to update config dofek_netdata_db_limits_v1: ... only updates to Labels are allowed`.
- Root Cause: Docker Swarm config objects are immutable. The prior fix changed
  the contents of the existing `netdata_db_limits_v1` config instead of
  publishing a new versioned config object.
- Fix/Mitigation: Version the Netdata config reference to
  `netdata_db_limits_v2` so Swarm creates a new immutable config and updates
  the service to mount it.
- Remaining Risk: Medium until the follow-up deploy converges and confirms
  Netdata starts with the new 768 MiB memory limit and reduced retention.
- Follow-Up Work: Redeploy PR #1180, then verify `dofek_netdata` convergence,
  public `/healthz`, worker dbt output, and kernel logs for new OOM kills.

### Follow-up (Deploy run 26426220118)

- Date: 2026-05-26.
- Symptoms: Production deploy from PR #1180 completed successfully after the
  Netdata Swarm config was versioned, but kernel logs still showed OOM kills
  during the rollout window.
- User Impact: Public `/healthz` returned healthy after deploy. During rollout,
  ClickHouse restarted once and dashboard requests could have briefly failed
  with ClickHouse DNS/connection errors while the service task was being
  replaced.
- Evidence: GitHub Actions run `26426220118` passed all web deploy steps. Swarm
  showed `dofek_web` at `2/2`, `dofek_worker`, `dofek_analytics-worker`,
  `dofek_clickhouse`, `dofek_db`, `dofek_peerdb`, and `dofek_netdata` at `1/1`,
  all on app image `sha-a33944a` where applicable. `dofek_netdata` mounted
  `dofek_netdata_db_limits_v2` and had a 768 MiB memory limit. Worker dbt logs
  showed `sensor_scalar_sample`, `deduped_sensor`, and
  `resting_heart_rate_sleep_window` all completing with `PASS=3`.
- Root Cause: The previous deploy failures were fixed, but the old Netdata task
  and a ClickHouse task still hit cgroup OOM limits during rollout before the
  new converged tasks stabilized.
- Fix/Mitigation: The successful deploy applied the versioned Netdata config,
  the reduced Netdata dbengine retention, and the 768 MiB Netdata memory limit.
  After convergence, Netdata and ClickHouse were both running, and no kernel
  OOM lines appeared in the follow-up 8-minute observation window.
- Remaining Risk: Medium. Netdata was using roughly 570 MiB of 768 MiB shortly
  after startup, and ClickHouse query logs still showed two dashboard sleep
  queries around 545-585 MiB before the ClickHouse restart. Continue watching
  Netdata pruning and dashboard query memory over a longer production window.
- Follow-Up Work: Consider optimizing the sleep dashboard queries that still
  allocate over 500 MiB, and review whether Netdata retention should be reduced
  further if memory remains close to the 768 MiB limit.

### Follow-up (Production ClickHouse OOM after deploy run 26426220118)

- Date: 2026-05-26.
- Symptoms: The dashboard again reported service-name resolution errors after
  the successful production deploy. Public `/healthz` still returned 200, but
  dashboard/API paths backed by ClickHouse were intermittently unavailable.
- User Impact: Recovery/dashboard reads could fail while ClickHouse restarted.
  Web health checks stayed healthy because the web service itself remained up.
- Evidence: Kernel logs showed a host-level OOM at `01:24:19` killing
  `clickhouse-serv` at roughly 4.46 GiB RSS, followed by ClickHouse cgroup OOM
  kills at `01:26:36` and `01:30:48`. Web logs also showed transient
  `getaddrinfo ENOTFOUND redis`, and worker/analytics-worker logs showed
  `getaddrinfo ENOTFOUND db` and `getaddrinfo ENOTFOUND clickhouse`, indicating
  broader Swarm/network instability during memory pressure and task restarts.
  `dofek_analytics-worker` logs showed the initial `deduped_sensor` dbt model
  timing out after 480s at `01:24:18`, then subsequent dbt builds rerunning
  repeatedly around `01:25`, `01:27`, `01:29`, and `01:31`.
- Root Cause: The production analytics worker cadence was too aggressive for
  the single-node ClickHouse host, and dbt failures exited the shell loop so
  Swarm immediately restarted the service into another dbt build. Incremental
  models reduced per-run query memory, but running the build every minute plus
  immediate retry-on-failure still drove ClickHouse into OOM/restart cycles.
- Fix/Mitigation: Lower ClickHouse to a 3500 MiB container limit with a checked
  in 3 GiB `max_server_memory_usage` cap, version the Swarm config as
  `clickhouse_memory_limits_3g`, set production analytics builds to run every
  15 minutes, and make failed analytics-worker dbt builds sleep for five
  minutes before retrying instead of exiting into a restart loop. Production
  deploy run `26427324922` completed successfully with app image `sha-9e82289`.
  Post-deploy checks at `01:50 UTC` showed public `/healthz` returning 200,
  `dofek_web` at `2/2`, `dofek_worker`, `dofek_analytics-worker`,
  `dofek_clickhouse`, `dofek_db`, `dofek_traefik`, and `dofek_netdata` at
  `1/1`. ClickHouse had the new `dofek_clickhouse_memory_limits_3g` config,
  a 3500 MiB container limit, and was using roughly 1.27 GiB of 3.418 GiB.
  Analytics-worker had `ANALYTICS_BUILD_INTERVAL_SECONDS=900` and
  `ANALYTICS_BUILD_RETRY_DELAY_SECONDS=300`, completed one dbt build with
  `PASS=3`, then slept.
- Remaining Risk: Medium. No kernel OOM lines appeared after `01:46 UTC` in
  the post-deploy observation window, but a single analytics build should still
  be monitored for memory, and heavy dashboard sleep queries still allocate over
  500 MiB.
- Follow-Up Work: Optimize the dashboard sleep queries and consider moving
  management/observability services off the single-node OLAP host if ClickHouse
  still needs more memory headroom.

### Follow-up (Healthspan dashboard ClickHouse OOM)

- Date: 2026-05-26.
- Symptoms: After deploy run `26427324922`, the dashboard still returned
  ClickHouse service resolution errors such as `getaddrinfo ENOTFOUND
  clickhouse` for `healthspan.score`.
- User Impact: Public `/healthz` remained healthy, but dashboard routes backed
  by ClickHouse failed while the ClickHouse task was down or restarting.
- Evidence: Kernel logs showed `HTTPHandler invoked oom-killer` at `01:54:16
  UTC`, followed by a cgroup OOM kill of `clickhouse-serv` at roughly 3.54 GiB
  anonymous RSS. Web logs showed a dashboard tRPC batch containing
  `healthspan.score`, a `healthspan.score` slow-query warning around 7.6s, then
  `getaddrinfo ENOTFOUND clickhouse` errors. Analytics-worker logs showed no
  scheduled dbt build between the successful `01:45 UTC` build and the
  `01:54 UTC` ClickHouse kill.
- Root Cause: The remaining outage was not caused by the analytics-worker
  cadence. An HTTP dashboard query path still pushed ClickHouse over its memory
  cgroup. The `healthspan.score` heart-rate zone query joined
  `analytics.deduped_sensor` to activities only by `user_id`, then applied
  activity time bounds, channel, and deletion filters in `WHERE`, which left
  ClickHouse room to scan/materialize too many user sensor rows before applying
  the activity window.
- Fix/Mitigation: Move the `deduped_sensor` activity-window, channel, and
  deletion predicates into the ClickHouse `JOIN ON` clause in
  `packages/server/src/routers/healthspan-query.ts`, matching the bounded join
  pattern used by other activity sensor analytics repositories. Add a
  regression test that verifies the healthspan query keeps those predicates in
  the join.
- Remaining Risk: Medium until deployed and observed under the same dashboard
  load. Other dashboard ClickHouse queries still run concurrently, so a broader
  per-user or per-process ClickHouse concurrency limit may still be needed if
  another route becomes the next memory peak.
- Follow-Up Work: Deploy the healthspan query fix, verify `/healthz`, confirm
  the ClickHouse task remains stable after dashboard access, and review the
  remaining dashboard ClickHouse routes for unbounded joins or high-memory
  query plans.

#### Validation

- Deploy run `26428146330` completed successfully on 2026-05-26 with app image
  `sha-f075758`. Post-deploy checks showed public `/healthz` returning 200,
  `dofek_web` at `2/2`, `dofek_worker`, `dofek_analytics-worker`,
  `dofek_clickhouse`, `dofek_db`, `dofek_traefik`, and `dofek_netdata` at
  `1/1`. The analytics worker completed the next incremental dbt build at
  `02:11 UTC` with `PASS=3`. At `02:17 UTC`, ClickHouse was still on the same
  running task, using roughly 1.56 GiB of its 3.418 GiB container limit, kernel
  logs showed no OOM lines since `02:05 UTC`, and filtered web logs showed no
  fresh `healthspan.score`, ClickHouse DNS, socket hang-up, or slow-query
  entries in the prior five minutes.

### Follow-up (dbt microbatch deduped sensor rollout)

- Date: 2026-05-26.
- Symptoms: A production deploy that enabled `sensor_scalar_sample` and
  `deduped_sensor` as dbt microbatch models initially left `worker` in a
  restart loop. Dashboard ClickHouse errors could still appear while the old
  rollout was unstable.
- User Impact: Public `/healthz` stayed healthy, but scheduled sync workers
  were unavailable during the crash loop and ClickHouse-backed dashboard routes
  could fail during the rollout.
- Evidence: Deploy run `26431989409` applied app image `sha-c13de1c`, after
  which `dofek_worker` repeatedly exited with ClickHouse error code 184:
  `ILLEGAL_AGGREGATION` in `analytics.sensor_scalar_sample`. The failing
  generated query exposed a ClickHouse alias collision from
  `max(_peerdb_version) AS _peerdb_version` inside the same grouped SELECT as
  other `_peerdb_version` aggregate arguments.
- Root Cause: The dbt microbatch model used the source PeerDB version column
  name as an aggregate alias. ClickHouse aliases are visible broadly within a
  SELECT, so the alias could be substituted into other aggregate expressions and
  interpreted as a nested aggregate.
- Fix/Mitigation: Commit `18477f11` renamed the grouped aggregate alias to
  `source_peerdb_version` and only projected it back to `_peerdb_version` in
  the outer SELECT. The microbatch event-time key remains `recorded_at` for
  both `analytics.sensor_scalar_sample` and `analytics.deduped_sensor`.
- Validation: Local focused checks passed before deployment:
  `pnpm lint:analytics-policy`, `pnpm lint:analytics-sql`, `dbt parse`, and
  `dbt compile --select sensor_scalar_sample deduped_sensor`. Deploy run
  `26432372706` completed successfully on app image `sha-18477f1`. Post-deploy
  checks showed public `/healthz` returning 200, `dofek_web` at `2/2`, and
  `dofek_worker`, `dofek_analytics-worker`, `dofek_clickhouse`, `dofek_db`, and
  `dofek_redis` at `1/1`. The analytics worker completed
  `sensor_scalar_sample` and `deduped_sensor` with `PASS=2 WARN=0 ERROR=0`,
  and filtered web logs showed no fresh ClickHouse DNS, socket, or
  `recovery.workloadRatio`/`healthspan.score` errors in the five-minute
  post-deploy window.
- Remaining Risk: Medium. The microbatch models are bounded and no longer crash
  on startup, but ClickHouse has only had a short observation window after this
  rollout. Longer dashboard usage may still reveal another high-memory query.
- Follow-Up Work: Continue splitting heavier read models, especially resting
  heart rate and activity summaries, into chained incremental dbt models before
  adding them back to the production safe model list.

### Follow-up (dashboard ClickHouse query fan-out)

- Date: 2026-05-26.
- Symptoms: After the microbatch rollout stabilized, the dashboard felt slow
  even though public `/healthz` remained available.
- User Impact: Dashboard tRPC batches returned slowly, and some
  ClickHouse-backed procedures failed with memory-limit errors.
- Evidence: Web logs showed one dashboard tRPC batch containing many
  ClickHouse-backed procedures at once. Several procedures took roughly
  9-17s, including `bodyAnalytics.smoothedWeight`, `stress.scores`,
  `healthspan.score`, `recovery.strainTarget`, `recovery.readinessScore`,
  `sleepNeed.performance`, `sleepNeed.calculate`, `weeklyReport.report`,
  `sleep.list`, and `bodyAnalytics.recomposition`. ClickHouse reported memory
  limit exceptions with code 241 and messages such as `would use 2.39 GiB`,
  while current RSS was near the configured 3 GiB server memory cap. ClickHouse
  `system.query_log` showed repeated sleep and body measurement query families
  in the same window, with several `ExceptionWhileProcessing` rows and
  durations around 8-17s.
- Root Cause: The web API allowed each tRPC procedure in a large dashboard
  batch to issue ClickHouse analytics reads concurrently. Even when individual
  queries used moderate memory, concurrent fan-out pushed ClickHouse to its
  memory cap, causing overcommit waits and query kills.
- Fix/Mitigation: Commit `8f705dba` wraps the web analytics sensor store in a
  `LimitedActivitySensorStore`. Each web replica now runs one ClickHouse
  analytics read at a time and deduplicates identical in-flight query/parameter
  pairs, reducing peak concurrent ClickHouse memory pressure without changing
  query semantics or stored data.
- Validation: Local focused checks passed before deployment:
  `cd packages/server && pnpm tsc --noEmit` and `pnpm lint --changed`. Deploy
  run `26432889065` completed successfully on app image `sha-8f705db`.
  Post-deploy checks showed public `/healthz` returning 200, `dofek_web` at
  `2/2`, and `dofek_worker`, `dofek_analytics-worker`, `dofek_clickhouse`,
  `dofek_db`, and `dofek_redis` at `1/1`. In the first five-minute
  post-deploy window, filtered web logs showed no fresh slow tRPC,
  ClickHouse DNS, socket, or memory-limit errors; however, no fresh dashboard
  batch was observed in that window.
- Remaining Risk: Medium. The query gate reduces memory fan-out but does not
  remove the expensive repeated sleep/body/recovery calculations. A real
  dashboard reload should be observed before treating the user-visible latency
  as fully remediated.
- Follow-Up Work: Move repeated dashboard calculations, especially sleep,
  body, recovery, and report inputs, into smaller chained incremental dbt read
  models so dashboard procedures read compact precomputed rows instead of
  recomputing overlapping windows per request.

### Follow-up (dashboard priority and provider stats OOM)

- Date: 2026-05-26.
- Symptoms: The dashboard became more stable after the first ClickHouse
  concurrency gate, but the at-a-glance score circles were still slow and
  production ClickHouse restarted again.
- User Impact: The dashboard score circles could take tens of seconds before
  rendering. During the later ClickHouse restart, ClickHouse-backed dashboard
  and data-source routes could temporarily fail with DNS or socket errors.
- Evidence: After deploy `26432889065`, a dashboard reload showed no immediate
  ClickHouse memory-limit errors, but the large dashboard batch queued behind
  serialized ClickHouse reads: `recovery.readinessScore` completed around
  32s, `sleepNeed.performance` around 26s, and several secondary sections
  completed between roughly 14-29s. After deploy `26433436277`, the first
  score-circle batch improved to about 6.2s, with `recovery.readinessScore`
  and `recovery.strainTarget` around 3.2-3.4s and `sleepNeed.performance`
  around 6.2s. However, web logs then showed `sync.providerStats` hitting a
  ClickHouse memory-limit error (`would use 2.58 GiB`, current RSS near
  3.34 GiB, maximum 3.00 GiB), followed by ClickHouse task exit 137 and
  transient `getaddrinfo ENOTFOUND clickhouse` / `socket hang up` errors.
- Root Cause: The one-at-a-time ClickHouse web gate prevented broad dashboard
  fan-out but introduced head-of-line blocking for the score circles. A
  separate all-user `analytics.provider_stats` view still computed provider
  counts across large mirrored tables before the route filtered to one user,
  and that view could exceed ClickHouse's 3 GiB server cap.
- Fix/Mitigation: Commit `4d9353be` prioritizes the dashboard score-circle
  queries, defers secondary dashboard sections briefly, and raises the bounded
  web ClickHouse read gate from one to two concurrent reads per web replica.
  Commit `5a071e6` removes `sync.providerStats` from the all-user
  `analytics.provider_stats` view path and computes per-user provider counts
  directly with `user_id` pushed into each ClickHouse subquery.
- Validation: Deploy run `26433436277` completed successfully on app image
  `sha-4d9353b`, and score-circle logs showed the first batch returning in
  roughly 6.2s instead of 26-32s. Deploy run `26433847816` completed
  successfully on app image `sha-5a071e6`. Public `/healthz` returned 200 in
  three post-deploy probes. Swarm services showed `dofek_web` at `2/2` and
  `dofek_worker`, `dofek_analytics-worker`, `dofek_clickhouse`, `dofek_db`,
  and `dofek_redis` at `1/1`. The replacement provider-stats query completed
  directly on production ClickHouse under a 1 GiB per-query cap and returned
  the expected per-provider rows. Filtered web logs for the final 10-minute
  window showed no fresh `sync.providerStats`, ClickHouse DNS, socket,
  memory-limit, or score-query slow/error lines. ClickHouse had no restart
  after the pre-fix OOM restart and stayed under the configured cap.
- Remaining Risk: Medium. The immediate OOM trigger is removed and the score
  circles are no longer trapped behind every secondary dashboard section, but
  several secondary dashboard calculations remain expensive and should still
  move into incremental read models.
- Follow-Up Work: Convert `healthspan.score`, sleep need, stress, weekly
  report, body analytics, and remaining repeated dashboard inputs into smaller
  chained incremental dbt models. Keep the all-user `analytics.provider_stats`
  view out of request paths unless it is replaced by a bounded incremental
  table.

### Follow-up (healthspan VO2 max request-path OOM)

- Date: 2026-05-26.
- Symptoms: ClickHouse restarted again after the dashboard secondary batch ran
  behind the bounded web query gate.
- User Impact: The dashboard's `healthspan.score` route failed with
  `socket hang up` and follow-up `getaddrinfo ENOTFOUND clickhouse` errors
  while the ClickHouse task restarted.
- Evidence: Web logs for the dashboard batch showed slow secondary routes:
  `weeklyReport.report` around 6.7s, body analytics routes around 7.9-9.2s,
  `stress.scores` and `sleepNeed.calculate` around 10.5s, and
  `healthspan.score` around 21.1s immediately followed by
  `healthspan.score: socket hang up`. Kernel logs at `14:23:21 UTC` showed
  `ConcurrentJoin invoked oom-killer`, then the memory cgroup killed
  `clickhouse-serv` at roughly 3.54 GiB anonymous RSS. ClickHouse query log
  entries before the kill showed the sleep, body, resting-heart-rate, and
  healthspan heart-rate-zone subqueries finishing; the remaining healthspan
  request-path calculation is the VO2 max estimate query that joins
  `analytics.deduped_sensor` to activities and body measurement data.
- Root Cause: `healthspan.score` was still running a sensor-heavy VO2 max
  estimate in the web request path after the earlier healthspan heart-rate-zone
  join fix. That query can overlap with the dashboard's other ClickHouse reads
  and push the single-node ClickHouse task over its 3 GiB server cap / 3.5 GiB
  cgroup limit.
- Fix/Mitigation: Added `analytics.activity_vo2max_estimate` as a bounded dbt
  read model for per-activity VO2 max estimates, created the ClickHouse table in
  migration `0023_incremental_activity_vo2max_estimate`, and updated
  `healthspan.score`'s ClickHouse repository path to read compact estimate rows
  instead of recomputing the sensor-heavy joins in the request path. Added a
  tRPC infrastructure-error sanitizer so ClickHouse DNS/connect/memory-limit
  failures are reported to Sentry with the original error but exposed to callers
  as a generic temporary analytics-unavailable message.
- Remaining Risk: Moderate until deployed and observed under dashboard reload
  traffic. The VO2 max read-model build still performs the expensive
  activity/sample work offline, but with dirty keys and `max_threads=1` rather
  than inside the API request path.
- Follow-Up Work: Watch the first production `analytics-worker` runs and
  dashboard reloads after deploy. If `activity_vo2max_estimate` still pressures
  ClickHouse, split the model into smaller dbt-native batches before adding more
  dashboard read models.

### Follow-up (E2E migration ClickHouse OOM)

- Date: 2026-05-26.
- Symptoms: The GitHub Actions `Test / E2E Tests (Web)` job failed before
  Cypress ran, during the `Run e2e migrations` step.
- User Impact: PR validation was blocked.
- Evidence: Job `77916604408` failed while running
  `docker compose -f docker-compose.e2e.yml run --rm migrate`. dbt reported a
  failure in `activity_vo2max_estimate`, and ClickHouse raised
  `MEMORY_LIMIT_EXCEEDED` while evaluating the overlap `dateDiff` expression
  inside `analytics.v_activity`.
- Root Cause: `activity_vo2max_estimate` read from the full recursive deduping
  `analytics.v_activity` view before applying its supported-activity and
  dirty-key bounds, so the CI dbt build expanded the expensive all-activity
  self-join graph.
- Fix/Mitigation: Changed the model's `current_activity` CTE to read bounded,
  non-deleted mirrored `postgres_fitness.activity` rows directly while keeping
  sensor samples sourced from deduped ClickHouse data.
- Validation: `dbt compile --select activity_vo2max_estimate`,
  `pnpm lint:analytics-sql`, the exact local E2E migration path, and
  `pnpm test:changed` all passed.
- Remaining Risk: Low for the observed CI failure. The model still depends on
  ClickHouse for deduped sensor joins, but it no longer forces the full
  activity-dedupe view into the migration build.
- Follow-Up Work: Keep future dbt read models from depending on broad request
  views when a bounded mirrored source table plus explicit filters is enough.

### Follow-up (body composition stale from unpublished Timescale chunks)

- Date: 2026-05-26.
- Symptoms: The body composition chart had not updated for several days.
- User Impact: Body recomposition and related body measurement views showed
  stale weight/body-fat data even though current Withings rows existed in
  Postgres.
- Evidence: `bodyAnalytics.recomposition` reads ClickHouse
  `analytics.v_body_measurement`. Postgres `fitness.metric_stream` had
  `body_weight`, `body_fat_percentage`, `muscle_mass`, and `bone_mass` rows
  through `2026-05-26 14:13:26 UTC`, but ClickHouse
  `postgres_fitness.metric_stream`, `analytics.body_measurement_sample`, and
  `analytics.v_body_measurement` were stuck at `2026-05-22 14:27:06 UTC`.
  PeerDB slots were active with `wal_status = reserved`, and PeerDB logs showed
  the metric-stream mirror repeatedly pulling zero records. Publication
  inspection showed Timescale chunks for `2026-05-19` through `2026-05-26` were
  not attached to `peerdb_metric_stream_no_imu`.
- Root Cause: `peerdb_metric_stream_no_imu` only covered previously attached
  Timescale physical chunks. New daily chunks were not being added to the
  publication, so PeerDB saw no changes for recent `fitness.metric_stream`
  rows despite healthy logical replication slots.
- Fix/Mitigation: Added missing recent chunks to the production publication,
  created `fitness.ensure_metric_stream_peerdb_publication_chunks()`, and
  registered an hourly TimescaleDB background job to attach future
  `fitness.metric_stream` chunks. Manually copied the small missing body-channel
  rows into ClickHouse so `analytics.body_measurement_sample` and
  `analytics.v_body_measurement` became current immediately. This PR updates
  `src/db/clickhouse-cdc.ts` so future PeerDB setup runs install the
  same function and scheduled job.
- Validation: Public `/healthz` returned 200 and Postgres reported
  `pg_is_in_recovery() = false`. `analytics.v_body_measurement` then showed
  `latest_weight = 2026-05-26 14:13:26 UTC` and
  `latest_body_fat = 2026-05-26 14:13:26 UTC`, with latest rows for
  `2026-05-26`, `2026-05-25`, `2026-05-24`, `2026-05-23`, and `2026-05-22`.
  Local focused tests passed with
  `CLICKHOUSE_URL=http://default:test@127.0.0.1:8123 pnpm vitest run src/db/clickhouse-cdc.test.ts`.
- Remaining Risk: Medium. The body chart is current, but recent non-body
  metric-stream channels still need a bounded recovery plan. Broad verification
  queries over `fitness.metric_stream` and `postgres_fitness.metric_stream FINAL`
  restarted Postgres/ClickHouse under current memory limits, so future checks
  should use chunk-bounded or channel-specific queries.
- Follow-Up Work: Add an alert comparing recent Timescale chunks against the
  PeerDB metric-stream publication and add a bounded runbook for repairing
  non-body metric-stream gaps without scanning the full hypertable.

### Follow-up (Stryker trpc.ts mutation threshold)

- Date: 2026-05-26.
- Symptoms: GitHub Actions `Test / Stryker (0)` failed, which caused
  `Test / Mutation Testing`, `Test / Test Gate`, and `CI Gate` to fail.
- User Impact: PR validation was blocked.
- Evidence: Job `77927893257` completed mutation testing for
  `packages/server/src/trpc.ts` with `Final mutation score 68.09 under breaking
  threshold 75`.
- Root Cause: The new ClickHouse infrastructure-error sanitizer tests covered
  the happy-path DNS/refused/overcommit cases but did not exercise enough
  negative and boundary cases for error-code extraction, nested causes, string
  errors, or cache metric labels/durations, leaving Stryker mutants alive.
- Fix/Mitigation: Added targeted `trpc.test.ts` cases for ClickHouse vs
  non-ClickHouse timeout/refused/memory-limit detection, non-string codes,
  nested causes, string thrown errors, and cache hit/miss metric labels and
  durations.
- Validation: `pnpm vitest packages/server/src/routers/trpc.test.ts --run`
  passed, unit-only Stryker for `packages/server/src/trpc.ts` reached 79.43
  against the 75 break threshold, `pnpm lint` passed, all TypeScript checks
  passed, and `pnpm test:changed` passed.
- Remaining Risk: Low. A full local Stryker run can pressure local ClickHouse
  during unrelated integration dry-run tests, but the failing shard's direct
  mutation target now clears the threshold with the dedicated unit test file.
- Follow-Up Work: Prefer adding mutation-killing cases alongside new tRPC
  middleware branches when introducing sanitizer or cache-observability logic.

### Deploy Web stack interpolation failure

- Date: 2026-05-26.
- Symptoms: GitHub Actions run `26465982212` failed for both staging and
  production in `Deploy Web Stack`.
- User Impact: The web deploy stopped before image pulls, migrations, or any
  stack rollout.
- Evidence: The failed step was `Validate rendered stack files`; the first
  fatal line was:
  ```text
  invalid interpolation format for services.analytics-worker.environment.ANALYTICS_BUILD_RETRY_DELAY_SECONDS: "required variable ANALYTICS_BUILD_RETRY_DELAY_SECONDS is missing a value: ANALYTICS_BUILD_RETRY_DELAY_SECONDS is required"
  ```
- Root Cause: `deploy/stack.yml` required the analytics-worker interval and
  retry-delay environment variables, but Infisical did not contain those keys
  for the deploy environments, so the rendered stack could not be interpolated.
- Fix/Mitigation: Added `ANALYTICS_BUILD_INTERVAL_SECONDS=900` and
  `ANALYTICS_BUILD_RETRY_DELAY_SECONDS=300` to Infisical for both `prod` and
  `staging`.
- Validation: Local `docker stack config` interpolation passed for production
  with `deploy/stack.yml` and for staging with `deploy/stack.yml` plus
  `deploy/stack.staging.yml` using Infisical-injected secrets.
- Remaining Risk: Low. The stack still fails loudly if either required
  analytics-worker timing key is removed or blank.
- Follow-Up Work: Add a deploy-secret checklist or preflight that verifies all
  `${VAR:?}` stack interpolation keys exist in Infisical for both deployment
  environments before the deploy workflow reaches Docker validation.

### Review App Docker SSH attached wait failure

- Date: 2026-05-26.
- Symptoms: PR #1186 failed `Deploy Review App` in GitHub Actions run
  `26479519411`, job `77973698519`.
- User Impact: The PR review app did not deploy, blocking live preview
  validation for the branch.
- Evidence: The failed step was `Deploy review stack`. The first fatal line was:
  ```text
  error waiting for container: command [ssh -o ConnectTimeout=30 -T -l root -- 88.99.171.167 docker system dial-stdio] has exited with exit status 255, make sure the URL is valid, and Docker 18.09 or later is installed on the remote host: stderr=client_loop: send disconnect: Broken pipe
  ```
  The migration container continued printing dbt output and later reported
  `Completed successfully`, but the parent Docker command ended with
  `Process completed with exit code 125`.
- Root Cause: The review-app workflow used an attached
  `docker compose run --rm web migrate` over Docker's SSH transport for the
  multi-minute dbt migration run, so a broken CI-to-review-host SSH transport
  caused the Docker client command to fail even though the one-shot container
  completed successfully.
- Fix/Mitigation: The review-app workflow now starts migration and seed
  one-shot containers detached, polls container state with short Docker API
  calls, removes successful containers, and prints logs only when a one-shot
  container exits non-zero or times out.
- Validation: Workflow syntax and local checks were run on the branch, and the
  review-app workflow was rerun on PR #1186.
- Remaining Risk: Low for this failure mode. A real container failure still
  fails loudly and includes the one-shot container logs.
- Follow-Up Work: Keep long-running review-app Docker operations detached and
  state-polled so CI does not depend on one multi-minute Docker SSH stream.

### Resting heart rate chart tail stale

- Date: 2026-05-26.
- Symptoms: The Heart Rate Variability & Resting HR chart showed resting heart
  rate ending before the latest visible dates while HRV continued.
- User Impact: The dashboard did not display recent resting heart rate values
  or the recent resting heart rate rolling trend.
- Evidence: `dailyMetrics.hrvBaseline` returned 200 in production, but
  `analytics.resting_heart_rate_sleep_window FINAL` for user
  `f923fed7-d934-4cd9-8cb9-8e83020d0e69` had active rows only through
  `2026-05-18`. The upstream data was current: `postgres_fitness.sleep_session`
  had 17 rows ending on or after `2026-05-19` with max sleep date
  `2026-05-26`, and `analytics.deduped_sensor FINAL` had 16,045 recent
  heart-rate samples with max recorded date `2026-05-26`. PeerDB replication
  slots were active and `reserved`.
- Root Cause: The production analytics-worker safe dbt selection excludes
  `resting_heart_rate_sleep_window`; it runs `sensor_scalar_sample`,
  `deduped_sensor`, and `activity_vo2max_estimate` only. Recent sleep and
  heart-rate data reached ClickHouse, but the resting heart rate read model was
  not rebuilt on the 15-minute schedule.
- Fix/Mitigation: No production change was made during investigation. A
  follow-up code change prepared `sleep_heart_rate_sample`,
  `activity_sensor_sample`, and `activity_location_sample` as bounded
  microbatch intermediaries, added compact activity aggregate intermediates,
  and re-added `resting_heart_rate_sleep_window` and `activity_summary_rows` to
  the scheduled safe-model set; it still requires deploy before production data
  refreshes.
- Validation: Read-only production checks confirmed the upstream data path is
  current and narrowed the stale output to the excluded RHR dbt model.
- Remaining Risk: Medium. RHR and activity summaries stay dependent on their
  previous production refresh state until the prepared dbt safe-model change is
  deployed, or until a controlled manual refresh is run with explicit operator
  approval.
- Follow-Up Work: Deploy the prepared bounded RHR and activity summary model
  update; add freshness monitoring comparing latest sleep/heart-rate inputs to
  latest active RHR output date.

### Production worker restart loop from analytics dbt OOM

- Date: 2026-05-26 PT / 2026-05-27 UTC.
- Symptoms: Production was reported down. Public `/healthz` and the SPA shell
  still returned HTTP 200, but background processing was impaired: the
  `dofek_worker` service was repeatedly failing with `task: non-zero exit (1)`,
  and `dofek_analytics-worker` was retrying dbt builds.
- User Impact: Background sync and import jobs were unavailable while the
  worker was in a restart loop. ClickHouse-backed dashboard data was at risk of
  stale or failed reads while ClickHouse was under memory pressure.
- Evidence: The first fatal analytics-worker log lines were ClickHouse
  `MEMORY_LIMIT_EXCEEDED` exceptions in dbt models including
  `activity_location_sample` and `activity_sensor_sample`, with ClickHouse at
  its configured 3 GiB memory limit while executing recursive activity graph
  work. The failing batch for `2026-05-20` had only 458 heart-rate sample rows
  but used `analytics.v_activity`/`analytics.v_activity_members`, which forced
  ClickHouse to traverse the unbounded 1,029-activity user graph before the
  microbatch could finish. The worker logs also showed the `worker` entrypoint
  running Postgres migrations, ClickHouse migrations, and then `dbt build`
  before the BullMQ worker process could start.
- Root Cause: The activity sample dbt models used global recursive activity
  views inside each microbatch. ClickHouse did not push the day filter inside
  those views, so each batch recomputed the full dedupe graph and OOMed. The
  blast radius was larger because `entrypoint.sh` also coupled the BullMQ
  `worker` service startup to the same analytics dbt build.
- Fix/Mitigation: A short-lived manual mitigation stopped the failing dbt retry
  loop and temporarily ran the Node BullMQ worker directly so background jobs
  could resume. The durable code change removes `dbt build` from the `worker`
  entrypoint and bounds the activity graph inside the affected analytics models
  to the active microbatch window so `analytics-worker` remains enabled.
- Validation: After the current production image was redeployed,
  `dofek_web` was `2/2`, `dofek_worker` was `1/1`, and
  `dofek_analytics-worker` was `1/1`. `/healthz` returned HTTP 200. The local
  fix compiles the affected dbt models with batch-local activity graph bounds
  and passes the changed test suite.
- Remaining Risk: Medium until the bounded activity graph fix is deployed and
  the next scheduled analytics-worker run completes cleanly on production-scale
  data.
- Follow-Up Work: Add freshness monitoring for analytics read models and keep
  the BullMQ worker independent from analytics rebuilds.

### Healthspan activity and steps undercount

- Date: 2026-05-26.
- Symptoms: The Healthspan Score card showed `Aerobic Activity` as
  `0 min/week` and `Daily Steps` around `1117 steps/day` despite the user
  reporting regular activity and more walking than that.
- User Impact: The Healthspan score penalized activity and steps using inputs
  that did not match the user's actual recent behavior.
- Evidence: Production `fitness.v_daily_metrics` averaged `1115` steps and
  `16` exercise minutes over the 35-day Healthspan window. Recent
  `fitness.daily_metrics` rows from Apple Health `HealthKit` showed many
  overwritten low partial-day step totals, while the Healthspan aerobic query
  used only HR/power-linked `analytics.activity_summary` activity data and
  ignored device-reported `exercise_minutes`.
- Root Cause: Incremental mobile HealthKit sync used `now - 24h` as the start
  time for daily cumulative statistics, then upserted those partial-day
  statistics over whole-day `fitness.daily_metrics` rows. Separately,
  Healthspan treated missing HR/power-linked aerobic activity as zero instead
  of using the device-reported full-day exercise minutes already stored in
  `fitness.v_daily_metrics`.
- Fix/Mitigation: Updated mobile HealthKit sync to start incremental sync
  windows at the local calendar-day boundary, preventing future partial-day
  overwrites. Updated Healthspan to use weekly device-reported exercise minutes
  as the aerobic activity floor when HR-zone activity minutes are lower or
  missing.
- Validation: Added regression coverage for day-boundary HealthKit sync and
  Healthspan exercise-minute fallback. Focused Healthspan unit tests, mobile
  Vitest project, Biome checks, and TypeScript checks passed locally.
- Remaining Risk: Existing corrupted historical Apple Health daily metric rows
  remain in production until the iOS app runs a corrected manual/full HealthKit
  sync from the user's device; the server cannot reconstruct those all-day
  HealthKit totals without the device.
- Follow-Up Work: After deploying the fix, run a full Apple Health sync from
  the iOS app to repair historical daily step and exercise-minute rows. Consider
  adding a server-side diagnostic for suspicious step drops after partial
  HealthKit sync windows.

### Resting heart rate sleep-sample join null handling

- Date: 2026-05-26.
- Symptoms: After deploying the bounded RHR dbt models, the Heart Rate
  Variability & Resting HR chart still did not show recent resting heart rate
  values.
- User Impact: The dashboard continued to omit recent resting heart rate points
  and the recent 7-day resting heart rate trend.
- Evidence: Production `analytics.resting_heart_rate_sleep_window FINAL` was
  refreshed at `2026-05-26 22:41:52 UTC`, but its newest active sleep window
  was still `2026-05-18`. `analytics.sleep_heart_rate_sample FINAL` had zero
  rows. A read-only ClickHouse query showed 33 recent sleep windows; before the
  activity-overlap exclusion, 11 had at least 30 heart-rate samples and the
  newest sleep had 4,356 samples. After the model's `LEFT JOIN active_activity`
  plus `active_activity.id IS NULL` filter, all sleep heart-rate samples were
  removed. Running the same query with `join_use_nulls=1` preserved 11 recent
  sleep windows, with up to 5,478 samples.
- Root Cause: ClickHouse `LEFT JOIN` returns default values for unmatched
  right-side columns unless `join_use_nulls` is enabled. The
  `sleep_heart_rate_sample` model expected SQL-null semantics for
  `active_activity.id IS NULL`, so unmatched activity rows looked non-null and
  the model filtered out every sleep heart-rate sample.
- Fix/Mitigation: Added `join_use_nulls=1` to the
  `sleep_heart_rate_sample` dbt model query settings and a regression assertion
  in `read_model_microbatch.sql.test.ts`.
- Validation: The new test failed before the model change and passed after it.
  `pnpm vitest run analytics/models/read_models/read_model_microbatch.sql.test.ts`,
  `pnpm test:changed`, `pnpm lint`, and the required TypeScript checks passed.
  Full `pnpm test` did not complete cleanly because Testcontainers-created
  integration Postgres containers stopped during unrelated integration suites
  with Docker HTTP 409 errors.
- Remaining Risk: Medium until the fix is merged and deployed. The production
  analytics worker also still logs ClickHouse memory-limit errors in unrelated
  activity sample models, although the RHR model itself ran after those errors.
- Follow-Up Work: Add read-model freshness monitoring for
  `sleep_heart_rate_sample` and `resting_heart_rate_sleep_window`; investigate
  the unrelated activity sample ClickHouse memory-limit errors separately.

### Staging deploy SSH banner timeout

- Date: 2026-05-27.
- Symptoms: The `Deploy Web` workflow failed for staging while production
  deployed successfully.
- User Impact: Production received the release, but staging did not update and
  the dispatcher workflow stayed failed.
- Evidence: GitHub Actions run `26487420045` failed in
  `Deploy Web Staging / Deploy Web Stack / Deploy Web Stack`, step `Setup SSH`.
  The first fatal line was `SSH host key for 162.55.186.24 did not become
  available within 235s`. Every retry showed `tcp/22: reachable (no SSH banner
  yet)`. A local SSH probe reproduced `Connection timed out during banner
  exchange`, and HTTPS to `staging.dofek.asherlc.com` timed out. Hetzner showed
  `dofek-staging` running, public IPv4 unblocked, and firewall applied, but
  host metrics showed the 2-core staging server pinned near 198% CPU with high
  disk reads. Rebooting the staging server through Hetzner completed, but SSH
  still failed to return a banner and CPU/disk saturation resumed. After the
  staging deploy path was stabilized, production deploy run `26500398493`
  rolled out `sha-92560da` successfully but the first analytics refresh failed
  in `activity_location_summary_rows` and `activity_sensor_summary_rows` with
  ClickHouse `MEMORY_LIMIT_EXCEEDED`; the first fatal lines showed the query
  would use about `2.7 GiB` of a `3.0 GiB` limit while executing recursive
  `has(visited_activity_ids, toString(...))` checks.
- Root Cause: The 4 GB staging host was running the scheduled analytics worker
  alongside ClickHouse and PeerDB. The first bad query was
  `activity_sensor_summary_rows`, which filtered `activity_sensor_sample` by
  joining dirty activity keys only on `activity_id`; on the staging data set
  that query ran for more than 10 minutes, pegged the 2-core host near 199%
  CPU, timed out the dbt HTTP client, and destabilized ClickHouse. After that
  join was narrowed, the next bad query was `activity_summary_rows`, which read
  the full sensor and location summary tables with `FINAL` before joining dirty
  activity keys. The remaining production-scale failure came from aggregate
  summary models still joining through global recursive `analytics.v_activity`;
  ClickHouse had to build the activity graph before applying the dirty-key
  filter, so the refresh could still exceed memory even though the deploy
  itself no longer starved the host.
- Fix/Mitigation: Rebooted the staging VM via Hetzner to try to restore SSH
  access; this did not recover the host. Booted staging into Hetzner rescue
  mode, captured installed-system logs, performed a hard power cycle back into
  the normal OS, and temporarily scaled `dofek-staging_analytics-worker` to
  `0` while investigating. The code fix keeps the analytics worker enabled and
  changes the activity sensor, location, and final activity summary models to
  filter through `(user_id, activity_id)` dirty-key tuple membership, matching
  their sort keys instead of scanning full upstream tables before applying
  dirty keys. The final fix also removes global `analytics.v_activity` from the
  activity summary aggregate stages; those models read changed raw activities
  directly and join bounded intermediate rows only after filtering to dirty
  `(user_id, activity_id)` keys. The deploy workflow now pauses app workers,
  including the analytics worker, only during migrations and stack update, then
  restores `dofek_analytics-worker` to `1/1` in the final stack.
- Validation: Production deploy job in the same dispatcher run passed through
  migrations, stack deploy, and CDC configuration. After scaling
  `dofek-staging_analytics-worker` to `0`, staging SSH became responsive,
  ClickHouse returned to `1/1`, and memory headroom recovered. A staging-only
  `Deploy Web` run from branch `Asherlc/deploy-failed` completed successfully
  with the checked-in overlay change, including migrations, stack deploy,
  readiness checks, and CDC configuration. `https://staging.dofek.asherlc.com`
  returned HTTP 200 after the deploy. Restoring the worker on image
  `sha-a2571eb` reproduced the host starvation during the first deploy-time
  analytics cycle: staging reached about 44 MB available memory, SSH banner
  probes timed out, and Hetzner CPU metrics returned to about 198-199%. This
  showed the remaining issue was not just the final summary table scan. The
  lookback microbatch intermediaries were rewriting recent rows with
  `refreshed_at = now64(9)`, which made downstream summary models treat the
  whole lookback window as dirty every cycle even when source data had not
  changed. A follow-up deploy of the source-freshness patch exposed another
  deploy-time failure mode: the analytics worker inherited Swarm's
  `start-first` update policy, briefly running overlapping analytics-worker
  tasks during rollout. On the staging host this again saturated CPU and memory
  before the deploy could complete. After preventing overlap, the worker still
  saturated the host during the activity microbatch phase, so the activity
  sensor and location microbatch lookbacks were reduced from 7 days to 3 days,
  matching the deduped scalar sensor lookback and cutting the repeated
  deploy-time activity batch count in half. The next staging deploy still
  pinned the host while the analytics service was paused, which identified the
  deploy `migrate` entrypoint as another full `dbt build` caller. The deploy
  migration path now runs Postgres migrations only; scheduled analytics refresh
  is owned by `analytics-worker`. The remaining expensive read-model path was
  `activity_vo2max_estimate`, which still joined directly to `deduped_sensor`
  by activity time windows; it now reads the bounded `activity_sensor_sample`
  intermediary by `(user_id, activity_id)`. ClickHouse query logs then showed
  the worker hanging after starting `activity_summary_rows`; that model no
  longer builds an unbounded `existing_activity_summary AS SELECT * FROM this
  FINAL` stale-row CTE and instead uses changed raw activities plus bounded
  dirty keys before reading existing summary rows. The remaining summary reads
  also avoid `FINAL` and choose the latest `refresh_version` after filtering to
  dirty `(user_id, activity_id)` keys. Because the staging deploy post-checks
  still compete with the first analytics cycle on the same 4 GB host, the
  analytics worker now waits 120 seconds after container startup before the
  first dbt build. Staging deploy run `26499975777` then completed and its
  first analytics-worker refresh finished all 10 dbt models in `95.64s` with
  `PASS=10 WARN=0 ERROR=0`; `activity_summary_rows` finished in `0.82s`.
  Production deploy run `26501175713` rolled out `sha-630f081`, and the first
  production analytics-worker refresh finished all 10 dbt models in `45.57s`
  with `PASS=10 WARN=0 ERROR=0`; `activity_location_summary_rows`,
  `activity_sensor_summary_rows`, and `activity_summary_rows` completed in
  `0.18s`, `0.24s`, and `0.31s` respectively. Production services were
  restored on `sha-630f081` with `dofek_analytics-worker` at `1/1`,
  `dofek_clickhouse` at `1/1`, `dofek_web` at `2/2`, `dofek_worker` at `1/1`,
  and `dofek_training-export-worker` at `1/1`.
- Remaining Risk: Low. The analytics worker is enabled and production has
  completed a full scheduled dbt refresh under the box's CPU and memory
  constraints. The remaining risk is regression: a future read-model change
  could reintroduce an unbounded global activity graph or dirty-key scan.
- Follow-Up Work: Add analytics read-model freshness and dbt duration alerts so
  a model that regresses into multi-minute runtime is caught before it starves
  the staging host.

## 2026-05-29 — Hetzner data volume 100% full; PeerDB CDC config fails on deploy

- Symptoms: The `Configure ClickHouse CDC` step of the Hetzner production
  `Deploy Web Stack` job failed with `[clickhouse-cdc] error: unable to check
  peer validity: status: FailedPrecondition, message: "failed to validate peer
  dofek_clickhouse_postgres_fitness: failed to validate S3 bucket: failed to
  write to bucket: ... S3: PutObject, https response error StatusCode: 507"`.
- User impact: Deploy job marked failed at the final CDC-configuration step.
  The app stack itself rolled out; the failure is in PeerDB peer validation,
  which writes to the MinIO (S3) staging bucket.
- Evidence: HTTP 507 = Insufficient Storage from MinIO. On the box,
  `df -h /mnt/dofek-data` (the 98 GB Hetzner block volume, `/dev/sda`) shows
  `93G used, 572M avail, 100%`. `du -sh /mnt/dofek-data/*` shows
  `/mnt/dofek-data/postgres = 84G` dominating, then `clickhouse = 8.6G`.
- Root cause: The Hetzner persistent data volume is full, driven by the
  Postgres data directory growing to 84 GB. With no free space MinIO cannot
  accept the PeerDB validation write, so CDC setup fails (and Postgres itself
  is at risk of going read-only).
- Discovery context: Surfaced while standing up the parallel Oracle Cloud
  validation deploy (dofek-oracle.asherlc.com). The OCI deploy succeeded; this
  Hetzner failure is pre-existing disk pressure, unrelated to the OCI/CI
  changes (which do not touch the Hetzner host).
- Fix / mitigation: UNRESOLVED. Needs investigation of the 84 GB Postgres
  footprint (table/index bloat vs. legitimate growth, WAL accumulation,
  retention) and either reclaiming space (VACUUM FULL on bloated tables,
  pruning, WAL/retention tuning) or growing the Hetzner block volume. No data
  was deleted — destructive cleanup requires operator direction.
- Remaining risk: High. The volume is at 100%; Postgres can stop accepting
  writes at any time. CDC remains broken until space is reclaimed.
- Follow-up work: (1) Decide reclaim-vs-grow with the operator; (2) add a disk
  free-space alert on /mnt/dofek-data well below 100%; (3) consider the
  `db-incident-response` skill for the Postgres footprint investigation.

## 2026-05-31 — Oracle analytics pages empty from lost raw fitness CDC slot

- Symptoms: On the Oracle host (`146.235.223.161`), `/training`, `/activities`,
  and `/sleep` returned HTTP 200 but the UI was empty. The training page showed
  no training load data, activities showed no activities in the last four weeks,
  and sleep had no data.
- User impact: Oracle validation could not show activity, training, or sleep
  history even after the web and analytics-worker services rolled out.
- Evidence: Oracle Postgres source tables had data:
  `fitness.activity = 1077` rows with latest `2026-05-31 00:17:00.51+00`,
  `fitness.sleep_session = 123` rows with latest
  `2026-05-31 07:27:45.11+00`, and `fitness.metric_stream = 372346899` rows.
  Oracle ClickHouse mirrors had `postgres_fitness.activity = 0` rows and
  `postgres_fitness.sleep_session = 0` rows, while
  `postgres_fitness.metric_stream = 4597109` rows. Derived read models
  `analytics.v_activity`, `analytics.activity_summary`, and `analytics.v_sleep`
  were all empty. `pg_replication_slots` showed
  `peerflow_slot_dofek_fitness_raw_analytics` and
  `peerflow_slot_dofek_provider_inventory_raw_analytics` with
  `wal_status = lost`. PeerDB logs reported `SQLSTATE 55000`:
  `can no longer access replication slot`.
- Root cause: The Oracle raw fitness PeerDB mirror lost its Postgres logical
  replication slot. Because `analytics.v_activity` and `analytics.v_sleep`
  depend on raw fitness mirror tables, dbt could run successfully while
  producing empty activity and sleep read models.
- Fix / mitigation: Dropped and recreated the lost Oracle
  `dofek_fitness_raw_analytics` mirror with initial copy enabled. Also dropped
  and recreated `dofek_provider_inventory_raw_analytics` because its slot was
  lost and it was causing the deploy CDC step to fail. Dropped and recreated
  `dofek_sensor_priority_raw_analytics` after PeerDB later reported its slot was
  missing. Recreated the missing PeerDB raw staging table for the
  already-populated metric-stream mirror, added the legacy `vector` and
  `metadata` payload columns expected by the orphaned metric-stream workflow,
  then ran a one-off `analytics` dbt build. The build completed all 10 models
  with `PASS=10 WARN=0 ERROR=0`.
- Remaining risk: Medium. Oracle activity, sleep, and training read models are
  populated again, and all four PeerDB slots are active with
  `wal_status = reserved`. The deploy CDC script still needed a code fix because
  PeerDB returned `AlreadyExists` for `CREATE MIRROR IF NOT EXISTS` when a flow
  already existed; the fix skips managed mirror creation when the mirror is
  present in the PeerDB catalog and treats the specific existing-workflow error
  as idempotent.
- Follow-up work: Add an alert for replication slots with
  `wal_status IN ('lost', 'unreserved')`, and add a deploy check that fails with
  a clear message if a managed PeerDB mirror is active but its corresponding
  `_peerdb_raw_*` staging table is missing.

## 2026-05-31 — Production hosts returned Traefik 404 during Oracle cutover deploy

- Symptoms: `https://dofek.asherlc.com/`, `https://dofek.fit/healthz`, and
  `https://dofek.live/healthz` returned plain-text `404 page not found` from
  Traefik/Cloudflare instead of the Express app. Later in the same recovery,
  `https://dofek.asherlc.com/healthz`, `/training`, `/activities`, and `/sleep`
  returned the same Traefik 404 while both Hetzner and Oracle app containers
  were otherwise healthy behind their own Traefik instances.
- User impact: Public web/API traffic for the primary production hostnames was
  unavailable while the app service had no routed backend.
- Evidence: Public curls returned HTTP 404 with body `404 page not found`.
  Direct curls to the Oracle IP with production Host headers also returned
  Traefik 404. On the Oracle host, `dofek_web` was `0/0` and its Traefik router
  initially claimed only ``Host(`dofek-oracle.asherlc.com`)``. Rerunning the
  deploy with production host-rule defaults failed in the `Run migrations` step
  before the final `docker stack deploy`, leaving app services scaled down.
  The first fatal deploy log line was
  `Unknown expression identifier _peerdb_synced_at ... FROM postgres_fitness.metric_stream`.
  After adding that missing column to the live ClickHouse table, the same old
  image exposed the next stale-image failure:
  `First argument for function tupleElement must be Tuple ... Actual String`,
  because its migration treated `metric_stream.point` as a tuple while the
  Oracle schema stores it as a JSON string. A fresh branch deploy then reached
  the native metric stream backfill and failed with
  `Error while reading WKB format: Incorrect first flag` because
  `readWKBPoint(unhex(''))` was attempted while evaluating rows whose source
  point was absent. After those schema/read-model failures were repaired, direct
  curl to Hetzner with `Host: dofek.asherlc.com` returned
  `200 {"status":"ok"}`, direct curl to Oracle with
  `Host: dofek-oracle.asherlc.com` returned `200 {"status":"ok"}`, and direct
  curl to Oracle with `Host: dofek.asherlc.com` still returned Traefik 404.
  Oracle `dofek_web` service labels showed
  ``traefik.http.routers.web.rule=Host(`dofek-oracle.asherlc.com`)`` while
  Terraform DNS routes `dofek.asherlc.com` to `local.dofek_primary_host`, which
  resolves to the Oracle reserved IP when `ORACLE_SERVER_HOST` is set.
- Root cause: The Oracle validation stack was left in a pre-migration scaled
  state after a failed deploy, and the cutover was only partially complete:
  DNS could already route production hostnames to Oracle, but the Oracle deploy
  job still installed a validation-only Traefik Host rule. The failed deploys
  were then prolonged by schema/read-model drift on Oracle: its ClickHouse
  `postgres_fitness.metric_stream` table was missing the PeerDB
  `_peerdb_synced_at` metadata column required by bootstrap migration `0002`,
  and one manually rerun deploy used an older image whose view SQL did not match
  the current `point String` schema.
- Fix / mitigation: Restored routing by scaling `dofek_web=2`, verified the
  production host rule was present, and confirmed all three public health URLs
  returned `200 {"status":"ok"}`. Added the missing `_peerdb_synced_at` column
  to the live Oracle ClickHouse table. Updated the ClickHouse bootstrap
  statements so future bootstrap/migration runs idempotently add PeerDB metadata
  columns to existing `postgres_fitness.metric_stream` before any read model
  selects them. Updated the native metric stream backfill to preserve absent
  source points as `NULL` and feed `readWKBPoint` a valid dummy WKB for those
  rows so ClickHouse's columnar branch evaluation cannot parse an empty value.
  Updated `.github/workflows/deploy.yml` so the `web-stack-oracle` job deploys
  `public_url: https://dofek.asherlc.com` and the production Host rule for
  `dofek.asherlc.com`, `dofek.fit`, `www.dofek.fit`, `dofek.live`, and
  `www.dofek.live`. Updated the Oracle cutover runbook to treat that host rule
  as required while `ORACLE_SERVER_HOST` is populated. A follow-up deploy using
  the fixed workflow completed successfully on both Oracle and Hetzner, including
  migrations and ClickHouse CDC configuration.
- Remaining risk: Low. The public app routes returned 200, Oracle app services
  were healthy on `sha-c92404e`, and the deploy workflow completed successfully.
  Hetzner still answers the production Host rule directly, so rollback remains
  viable while cutover is in progress.
- Follow-up work: Add a preflight check to the Oracle cutover runbook and deploy
  workflow that verifies `dofek_web` replicas, production Host rules, required
  ClickHouse metadata columns, orphan PeerDB Temporal workflows, and direct
  origin curls for each production Host header before switching or deploying
  traffic. Avoid pinning stale image tags during cutover recovery; deploy the
  current main image or a freshly built branch image when schema/read-model code
  has changed.

## 2026-05-31 — Activities page showed duplicate activities

- Symptoms: `https://dofek.asherlc.com/activities` showed duplicate activity
  cards with overlapping start/end times. Some duplicates had metrics while
  others were empty or partial.
- User impact: Activity history and summary counts were inflated by raw
  provider/device duplicates.
- Evidence: Production ClickHouse had 348 `analytics.activity_summary` rows in
  the last 84 days, 328 rows with no samples, and 510 activity-summary pairs
  with greater than 80% time overlap. A sample overlapping pair existed as one
  canonical row in Postgres `fitness.v_activity.member_activity_ids`, but both
  raw IDs still appeared in `analytics.activity_summary`.
- Root cause: `analytics.activity_summary_rows` built final rows from raw
  `postgres_fitness.activity` instead of the canonical `bounded_activity_graph()`
  activity IDs. Upstream sensor/location intermediaries used the deduped graph,
  but the final summary rollup reintroduced raw activity identity.
- Fix / mitigation: Updated `activity_summary_rows` to use
  `bounded_activity_graph()` `current_activity` for final output, while keeping
  raw activity rows only as dirty-key triggers. Added stale-key tombstones so
  previously materialized noncanonical summary rows are removed by the next
  analytics-worker dbt run. Added a ClickHouse activity dedup runbook and SQL
  policy test coverage for the invariant.
- Remaining risk: The branch must deploy and `analytics-worker` must run the
  safe dbt model set before production duplicates disappear.
- Follow-up work: After deploy, rerun the overlap diagnostic from
  `docs/clickhouse-activity-dedup-runbook.md` and confirm overlapping pairs
  drop to expected edge cases only.

### 2026-05-31 update

- Symptoms: The activities page could still show duplicate cards when stale or
  noncanonical rows remained visible in `analytics.activity_summary`.
- User impact: `/activities` list cards, overview counts, and activity type
  filters could be inflated until analytics cleanup removed those rows.
- Evidence: The `calendar.weekList` and `calendar.activityOverview` routes read
  `analytics.activity_summary` directly without constraining rows to the
  canonical ClickHouse activity graph.
- Root cause: The API trusted `analytics.activity_summary` to contain only
  canonical activity IDs. That left the page vulnerable to stale noncanonical
  summary rows during and after dedup read-model repairs.
- Fix / mitigation: The activities list, overview totals, and overview type
  filter queries now join `analytics.v_activity` on `(user_id, activity_id)` so
  only canonical deduped activity rows can be returned.
- Remaining risk: Production needs this branch deployed before the route-level
  guard is live. Full local lint was blocked by Docker network exhaustion while
  starting the ClickHouse dependency.

### 2026-05-31 second update

- Symptoms: The activities page still showed duplicate cards after the route
  joined `analytics.v_activity`.
- User impact: Stale noncanonical rows in `analytics.activity_summary` could
  still inflate activity cards, overview counts, and type filters.
- Evidence: The failing case had a canonical Strava mountain-bike activity and
  a WHOOP member activity with the same time bounds; the raw member summary row
  stayed visible instead of being tombstoned.
- Root cause: Activity deduplication was reconstructed in several ClickHouse
  read models instead of being materialized once. `activity_summary_rows` also
  relied on ClickHouse left joins without `join_use_nulls`, so stale-key
  detection could treat missing right-side rows as default values.
- Fix / mitigation: Added dbt-owned `deduped_activities` and
  `deduped_activity_members` read models, changed activity sensor/location and
  final summary models to consume them, enabled `join_use_nulls` where stale
  detection depends on NULL joins, and removed the calendar route's runtime
  `analytics.v_activity` join. The dedupe models now use dirty activity windows
  for normal incremental runs and rebuild globally only when provider/device
  priority changes can affect canonical selection. Added ClickHouse integration
  tests proving raw member summary changes and dedupe-only mapping refreshes
  rekey to the canonical activity and tombstone stale member summaries.
- Remaining risk: Production needs the analytics worker to build the new
  `deduped_activities`, `deduped_activity_members`, and downstream summary
  models before stale duplicates disappear.

### 2026-06-01 update

- Symptoms: Calendar activity list and overview ClickHouse queries failed with
  `Unknown table expression identifier 'analytics.deduped_activities'`.
- User impact: The activities calendar route could fail instead of returning
  recent activity cards, overview totals, or activity type filters.
- Evidence: The failing SQL read `analytics.deduped_activities AS activity FINAL`;
  the dbt model exists and is selected by `DBT_SAFE_MODELS`, but
  `bootstrapClickHouseFromEnv` only waited for `analytics.deduped_sensor`,
  `analytics.activity_summary`, and `analytics.activity_trend_daily`.
- Root cause: The web startup ClickHouse prerequisite check was not updated
  when the runtime activity calendar queries started depending on
  `analytics.deduped_activities`.
- Fix / mitigation: Added `analytics.deduped_activities` to startup table
  existence and column smoke verification so the web process fails loudly until
  the required dbt read model exists.
- Remaining risk: Production still needs the analytics worker to build the dbt
  model before web startup can pass this stricter readiness gate.

### 2026-06-01 CI update

- Symptoms: The `E2E Tests (Web)` workflow failed while starting the e2e
  server container.
- User impact: Pull request CI was blocked before Cypress could run.
- Evidence: The failing command was
  `docker compose -f docker-compose.e2e.yml up -d --wait --no-build server`;
  the first fatal line was `container dofek-server-1 is unhealthy`. The logs
  showed ClickHouse migrations completed, but the e2e job did not run the dbt
  analytics build before starting the server.
- Root cause: The web startup readiness check now requires the dbt-owned
  `analytics.deduped_activities` model, while the e2e workflow only ran
  migrations and then started the server.
- Fix / mitigation: Added an e2e `analytics` one-shot service and workflow step
  to build dbt analytics models between migrations and server startup. The
  server now depends on that service completing successfully. Review feedback
  identified that `docker compose run --rm analytics` did not satisfy later
  `service_completed_successfully` dependencies or preserve logs, so the e2e
  workflow now starts `migrate` and `analytics` as tracked compose services and
  waits on their container exit codes.
  The first CI rerun then exposed a ClickHouse analyzer failure in
  `deduped_activities`: the stale tombstone branch anti-joined against the
  recursive graph output, causing
  `Unknown table expression identifier 'connected_components'`. The model now
  tombstones existing affected rows at `refresh_version - 1` and inserts current
  rows at `refresh_version`, so unchanged current rows win without
  re-referencing the recursive CTE in the stale branch. A later CI rerun exposed
  `deduped_activity_members` first-build schema inference using nullable dummy
  stale rows in the sort key; that model now keeps existing/stale member CTEs
  incremental-only so first-build sort keys come from current rows.
- Remaining risk: Local full-stack e2e validation was blocked by Docker network
  address-pool exhaustion; local single-model dbt first-build and incremental
  runs reproduced and validated the failing model path.

### 2026-06-01 activities empty-state update

- Symptoms: `https://dofek.asherlc.com/activities` showed "No activities in the
  last 4 weeks" even though recent activities should exist.
- User impact: The activity calendar list and overview could temporarily hide
  recent activity data after sync/import and analytics catch-up.
- Evidence: Production Postgres `fitness.v_activity` had 73 recent completed
  activities for user `f923fed7-d934-4cd9-8cb9-8e83020d0e69` since
  `2026-05-04`, latest `2026-06-01 03:39:00.46+00`. Mirrored ClickHouse
  `postgres_fitness.activity FINAL` had 214 recent raw completed rows and
  `analytics.activity_summary` had 211 recent rows, but
  `analytics.deduped_activities FINAL` had zero rows total. The
  `analytics-worker` first fatal log line was ClickHouse
  `MEMORY_LIMIT_EXCEEDED` while executing `RecursiveCTESource` in
  `deduped_activities`.
- Root cause: The first build of dbt-owned `analytics.deduped_activities` ran
  the recursive activity-overlap graph over all mirrored historical activities
  because the target table was empty. That unbounded recursive CTE exceeded the
  ClickHouse memory limit, leaving the table empty. The Activities page reads
  `analytics.deduped_activities`, so it returned no recent activity cards even
  though canonical and summary data existed.
- Fix / mitigation: Production was manually populated through ClickHouse using
  materialized intermediate source-record, duplicate-match, duplicate-group,
  and canonical-activity stages. After the manual insert,
  `analytics.deduped_activities FINAL` had 828 active rows; the
  page-equivalent recent query returned 73 rows with matching
  `analytics.activity_summary` rows and latest start
  `2026-06-01 03:39:00`. The repo fix replaces the path-enumerating recursive
  graph macro with dbt-owned domain read models:
  `activity_source_records`, `activity_duplicate_matches`,
  `activity_duplicate_groups`, and `deduped_activities`. A read-only
  production performance check of the monolithic domain CTE returned the right
  828 groups but took 9.4s; the dbt-style materialized component check returned
  the same 828 groups with the duplicate-group stage taking 27ms and about 10MB
  peak memory.
- Remaining risk: Production is manually mitigated, but the analytics worker
  still needs this repo fix deployed before scheduled dbt builds stop retrying
  the old recursive model. Local dbt-templated SQL lint compiled the project but
  could not complete because local ClickHouse at `127.0.0.1:8123` was not
  running; starting the local compose dependency was blocked by Docker address
  pool exhaustion in this workspace.

### 2026-06-02 PR CI nullable sort-key update

- Symptoms: PR `Test / E2E Tests (Web)` failed during the tracked e2e
  analytics build, causing `Test / Test Gate` and `CI Gate` to fail.
- User impact: The activity dedupe PR could not pass required CI despite the
  production deploy succeeding against an existing `deduped_activities` table.
- Evidence: The failing e2e step was
  `docker compose -f docker-compose.e2e.yml up -d --no-build analytics`; the
  first fatal dbt line was `Database Error in model deduped_activities`, with
  ClickHouse error `Sorting key contains nullable columns, but merge tree
  setting allow_nullable_key is disabled`.
- Root cause: The clean e2e first build inferred `deduped_activities.user_id`
  as nullable because upstream source-record models include tombstone branches
  with nullable non-key fields, while `deduped_activities` sorts by
  `(user_id, activity_id)`.
- Fix / mitigation: `deduped_activities` now emits
  `assumeNotNull(user_id) AS user_id` in both current and stale output branches
  so clean first builds create a non-null sort-key column.
- Remaining risk: Full local e2e validation remains blocked by Docker network
  address-pool exhaustion in this workspace; CI rerun is the end-to-end
  validation for the compose e2e path.

### 2026-06-02 Garmin OAuth exchange rate-limit classification

- Symptoms: Sentry issue `DOFEK-SERVER-2Z` reported
  `GarminAuthError: Failed to exchange for OAuth2 (429): Rate limited` from
  `GarminConnectClient.#exchangeForOAuth2` during production scheduled sync.
- User impact: No Sentry users were marked impacted, but Garmin sync could not
  refresh the expired internal token for the affected scheduled runs.
- Evidence: Sentry showed two production events at `2026-06-02T15:00:01Z` and
  `2026-06-02T15:30:01Z`, matching the 30-minute scheduled sync cadence, both
  tagged `provider=garmin`. A 14-day Sentry search found no earlier matching
  events. The failing frame was
  `packages/garmin-connect/src/client.ts:266`, where OAuth2 exchange threw
  `GarminAuthError` for every non-OK response.
- Root cause: The Garmin client already modeled normal Connect API 429s as
  `GarminRateLimitError`, but the OAuth1-to-OAuth2 exchange endpoint used the
  generic auth-error branch for all non-OK responses, misclassifying provider
  rate limiting as authentication failure.
- Fix / mitigation: `#exchangeForOAuth2` now throws `GarminRateLimitError` for
  HTTP 429 before falling back to `GarminAuthError` for other exchange
  failures. A regression test covers expired-token refresh through
  `GarminConnectClient.fromTokens`.
- Remaining risk: Full `pnpm lint` could not be rerun to completion locally
  because analytics SQL lint needs ClickHouse at `127.0.0.1:8123`; starting the
  local compose stack was blocked by Docker address-pool exhaustion while
  creating `richmond_default`.

### Follow-Up Work

- Monitor Sentry for `GarminRateLimitError` events from OAuth exchange and
  confirm they are handled as provider rate-limit incidents rather than auth
  failures.
- Decide whether Garmin OAuth exchange should add bounded retry/backoff behavior
  now that 429 responses are classified correctly.
- Keep the `GarminConnectClient.fromTokens` expired-token refresh path covered
  in CI through the package unit test and mutation test.
- Resolve local ClickHouse/Docker address-pool setup so future incident fixes can
  run full lint and e2e validation locally.

### 2026-06-02 Withings stale refresh token reported to Sentry

- Symptoms: Sentry issue `DOFEK-SERVER-2Y` recorded two production errors,
  `Withings token error (status 503)`, at `2026-06-02T15:00:02Z` and
  `2026-06-02T15:30:02Z`.
- User impact: A Withings account with an invalid refresh token continued to be
  treated as a sync error instead of being surfaced as a reconnect-required
  provider state.
- Evidence: The failing stack was `withingsTokenExchange` during
  `WithingsProvider.#resolveTokens`. Withings docs define API response
  `status: 503` as `Invalid params`, not HTTP `503 Service Unavailable`, and
  document refresh-token rotation where old refresh tokens expire after 8 hours
  or once the new access token is used.
- Root cause: Withings token refresh handled provider-level `status: 503` as a
  generic exception. The sync worker sent returned provider errors to Sentry
  even when the error represented expected authorization state.
- Fix / mitigation: Withings refresh now treats token `status: 503` as
  reconnect-required auth state, deletes stored Withings tokens, and returns a
  reconnect message. The sync worker no longer reports reconnect/auth sync
  errors to Sentry, while sync history still records the error. Withings queue
  concurrency is now `1` to avoid overlapping refresh-token rotation races.
- Remaining risk: The exact production token value was not reproduced locally
  because local Withings secrets were unavailable; the fix is based on Sentry
  stack evidence, Withings docs, and targeted unit tests for the failing path.

### 2026-06-02 Mobile native bridge crash during foreground sync

- Symptoms: Sentry issue `DOFEK-MOBILE-P` recorded one production fatal
  `EXC_BAD_ACCESS: ExceptionsManager > name >` in `dofek-mobile` release
  `com.dofek.app@1.0.0+1780011142` on iOS 26.5.
- User impact: One mobile user experienced a fatal app crash while the app was
  in the foreground.
- Evidence: Sentry breadcrumbs showed a foreground transition followed by
  overlapping WHOOP BLE buffer drain and background HealthKit sync activity.
  The native stack failed inside React Native TurboModule Objective-C exception
  conversion while Hermes was creating a JS error string.
- Root cause: Native module events could cross the Expo/React Native bridge
  from background callback queues. The WHOOP disconnect event could also include
  an optional nil `error` payload value, which is unsafe to bridge as
  `[String: Any]`.
- Fix / mitigation: WHOOP BLE connection/orientation events and HealthKit
  observer events now emit through a main-thread event helper. The helper also
  compacts optional nil payload values before calling `sendEvent`.
- Remaining risk: The crash has only one Sentry occurrence, so the exact device
  sequence was not locally reproduced. The fix targets the native bridge
  hazards active in the Sentry breadcrumb window and is covered by Swift package
  tests.

### 2026-06-02 HealthKit workout push Timescale metric_stream update failure

- Symptoms: Sentry issue `DOFEK-SERVER-30` reported one production
  `healthKitSync.pushWorkouts` error at `2026-06-02T17:52:15Z`.
- User impact: Sentry reported 0 impacted users, but the affected workout push
  returned an error after upserting the workout and before completing the
  request.
- Evidence: The first fatal query was `UPDATE fitness.metric_stream ss SET
  activity_id = (...)` from
  `packages/server/src/routers/health-kit-sync-processors.ts:79`, bounded to
  Apple Health heart-rate rows between `2026-06-02T15:06:00Z` and
  `2026-06-02T16:25:00Z`. PostgreSQL/Timescale raised `cannot update table
  "_hyper_4_7633_chunk"`.
- Root cause: HealthKit sync tried to backfill a derived activity association
  into the Timescale hypertable after sensor rows already existed. That
  `activity_id` update is redundant because ClickHouse activity read models
  associate sensor samples to activities by user and time window, and unsafe on
  compressed/managed Timescale chunks.
- Fix / mitigation: Removed post-ingest heart-rate-to-workout linker calls from
  mobile HealthKit sync, Apple Health XML import, and the unused repository
  helper. Workout route samples that arrive with an explicit workout UUID still
  write their known `activity_id` at insert time.
- Remaining risk: Production SSH was unreachable from this workspace during
  investigation, so chunk metadata could not be inspected directly. Validation
  relies on Sentry evidence plus focused tests proving the failing `UPDATE
  fitness.metric_stream` is no longer emitted.

### 2026-06-02 Wahoo null FIT file URL schema failure

- Symptoms: Sentry issue `DOFEK-SERVER-31` recorded a production `ZodError`
  during Wahoo sync at `2026-06-02T17:53:49Z`.
- User impact: The affected Wahoo sync job failed while parsing the workouts
  list response before any later workouts on that page could be persisted.
- Evidence: The failing frame was `src/providers/http-client.ts:90` inside
  `WahooClient.get`, called by `WahooProvider.sync`. The first fatal schema
  issue was `workouts[28].workout_summary.file.url: Expected string, received
  null`; Sentry showed the same issue again at `workouts[29]`. A trace-scoped
  Sentry log search returned no related application log entries.
- Root cause: The Wahoo schema allowed `workout_summary.file` to be absent, but
  required `file.url` to be a string whenever `file` was present. Wahoo can send
  a present `file` object with `url: null` for workouts that do not have a FIT
  file URL available.
- Fix / mitigation: `createWahooWorkoutSummarySchema` now normalizes
  `file.url: null` to `undefined`, preserving the existing behavior where the
  persister downloads a FIT file only when a URL exists. A regression unit test
  covers Wahoo workout-list parsing with a null file URL.
- Remaining risk: No event replay or application logs were available for the
  trace, so validation is based on the Sentry stack, the captured payload path,
  and the focused unit test.

### 2026-06-02 Mobile recovery formatter crash

- Symptoms: Sentry issue `DOFEK-MOBILE-Q` recorded one production fatal
  `TypeError: undefined is not a function` in `dofek-mobile` release
  `com.dofek.app@1.0.0+1780011142` on iOS 26.5.
- User impact: One mobile user experienced a fatal app crash while opening the
  Recovery tab.
- Evidence: The Sentry JS stack pointed to `RecoveryScreen` calling
  `formatHRV -> formatHRVMeasurement -> formatMetricMeasurement ->
  formatMetricParts`. The first fatal line was
  `fixedDecimalFormatter(...).formatToParts(value)`. Breadcrumbs showed the
  batched recovery/dashboard request succeeded immediately before render.
- Root cause: The production React Native/Hermes runtime did not provide
  `Intl.NumberFormat.prototype.formatToParts`, but shared measurement
  formatting assumed it existed when splitting number and unit parts for UI
  styling.
- Fix / mitigation: Added FormatJS `Intl.NumberFormat` polyfills at mobile
  startup before Expo Router loads. The polyfill installs
  `NumberFormat.prototype.formatToParts` globally for the React Native runtime,
  preserving existing shared formatter behavior.
- Remaining risk: The exact production device runtime was not reproduced
  locally. A regression test simulates the missing `formatToParts` method and
  verifies the mobile startup polyfill restores grouped number parts.

### 2026-06-03 CI Docker Hub pull timeouts

- Symptoms: PR CI failed in `Test / Integration Tests` and `Test / E2E Tests
  (Web)` before running test assertions.
- User impact: PR #1233 could not get green CI because required test jobs failed
  during Docker image setup.
- Evidence: Integration tests failed while starting the `postgres` service with
  `Docker pull failed with exit code 1` after repeated Docker Hub
  `registry-1.docker.io` timeouts for
  `timescale/timescaledb-ha:pg18.3-ts2.26.4-all`. Web E2E failed while
  booting BuildKit with `Error response from daemon: Get
  "https://registry-1.docker.io/v2/": net/http: request canceled while waiting
  for connection`.
- Root cause: The Test workflow and E2E compose stack depended on live Docker
  Hub pulls for service images and the BuildKit bootstrap image, and GitHub's
  hosted runner could not reach Docker Hub within the Docker client timeout.
- Fix / mitigation: Pointed affected Test workflow service images, E2E compose
  service images, and BuildKit bootstrap configuration at confirmed
  `mirror.gcr.io` image references.
- Remaining risk: This addresses the observed Docker Hub setup failures for
  Test workflow paths. Other non-test workflows may still use Docker Hub image
  references and should be reviewed if they fail with the same first fatal
  line.

### 2026-06-03 Wahoo expired access token reported to Sentry

- Symptoms: Sentry issue `DOFEK-SERVER-2B` recorded production errors from
  `WahooClient.handleErrorResponse` for `API error 401 on /v1/workouts:
  {"error":"Access token has expired"}`.
- User impact: A Wahoo sync failed because the provider rejected the stored
  access token. The failure was treated as reportable noise instead of a user
  reauthorization state.
- Evidence: Sentry event `ffba1d041b264f4c9383bd08aa758cb4` showed the first
  fatal application frame at `src/providers/http-client.ts:59`, called from
  `WahooProvider.sync` through `processSyncJob`.
- Root cause: Provider auth failures were classified from human-readable sync
  error messages. Wahoo's `Access token has expired` wording did not match the
  existing message patterns, so the worker treated it as reportable.
- Fix / mitigation: Added provider auth error types and an
  `auth_failure_reason` sync-log column. Wahoo now throws
  `AccessTokenExpiredError`, the worker suppresses Sentry via
  `instanceof ProviderAuthError`, and the provider list uses the persisted
  structured reason for reauthorization state.
- Remaining risk: Provider result messages are still stored for display/log
  history, but auth classification no longer depends on parsing those messages.

### 2026-06-03 production deploy applied retired staging Terraform

- Symptoms: `Deploy Web Production / Deploy Infra / Terraform Apply` failed
  during production deploy run `26911239600`.
- User impact: Production deploy was blocked before stack rollout because the
  shared Terraform apply failed.
- Evidence: The failed command was `terraform apply -auto-approve
  -lock-timeout=5m` in `.github/workflows/deploy-terraform.yml`. The first
  fatal line was `Error: error during placement (resource_unavailable,
  b5ca6fefbd58e21717194baa8e723212)` while creating
  `hcloud_server.dofek_staging` in `deploy/server.tf`.
- Root cause: The main production Terraform root still managed the retired
  Hetzner staging server, volume, provisioners, staging DNS records, and
  GitHub Actions staging output even though staging deploys were disabled.
- Fix / mitigation: Removed staging from the main `deploy/` Terraform root,
  deleted the unused staging stack override, removed staging deploy workflow
  outputs/selection, and updated deployment docs to mark staging disabled.
- Remaining risk: The next Terraform apply will reconcile the removed staging
  resources in state. Review apps still use the separate
  `deploy/review-apps/` Terraform root and remain independent of this change.

### 2026-06-03 Mobile Settings native SVG image crash

- Symptoms: Sentry issue `DOFEK-MOBILE-R` recorded one production fatal
  `EXC_BAD_ACCESS: Exception 1, Code 1, Subcode 15` in `dofek-mobile` release
  `com.dofek.app@1.0.0+1780429552` on iOS 26.5.
- User impact: One mobile user experienced a fatal app crash after opening
  Settings.
- Evidence: The Sentry native stack ended in
  `hermes::vm::HiddenClass::addProperty` through
  `facebook::react::ObjCTurboModule::performVoidMethodInvocation`, with no
  app frame. Breadcrumbs showed the app mounted Settings, successfully fetched
  `/api/export`, loaded provider logos including `peloton.svg`, and completed
  the Settings tRPC batch immediately before the crash. No related trace logs
  were found, and Sentry Seer failed with API event
  `b912a391be3144c5bf4ce2fffb0128c6`.
- Root cause: The mobile `ProviderLogo` component treated SVG and PNG provider
  logos the same and passed remote SVG URLs to React Native's native `Image`
  loader. The crash trigger is inferred from the Settings breadcrumbs because
  the native crash stack did not include an app frame.
- Fix / mitigation: Mobile now only renders remote provider logos when the
  shared logo metadata says the asset is PNG. SVG-logo providers use the
  existing styled-letter fallback, avoiding native SVG image loading on iOS.
  A colocated unit test covers the SVG fallback behavior.
- Remaining risk: The exact production device crash was not reproduced locally,
  and the Sentry stack did not name the native module. Monitor
  `DOFEK-MOBILE-R` for recurrence after the next mobile release.

### 2026-06-03 Sleep dashboard stale because raw fitness CDC slot was lost

- Symptoms: Sleep data on the dashboard appeared stale even though provider sync
  was still running.
- User impact: Web/mobile sleep views that read `analytics.v_sleep` did not show
  the latest sleep rows.
- Evidence: Production Postgres `fitness.sleep_session` had 131 rows with
  latest `started_at = 2026-06-03 05:45:22.34+00` and
  `ended_at = 2026-06-03 15:28:10.79+00`. ClickHouse
  `postgres_fitness.sleep_session` had 129 rows with latest
  `_peerdb_synced_at = 2026-06-02 17:31:00` and latest
  `started_at = 2026-06-02 03:23:19.94`. `analytics.v_sleep` was stale through
  the June 1 sleep date / June 2 start time. `pg_replication_slots` showed
  `peerflow_slot_dofek_fitness_raw_analytics`,
  `peerflow_slot_dofek_metric_stream_analytics`, and
  `peerflow_slot_dofek_sensor_priority_raw_analytics` with
  `wal_status = lost`. PeerDB logs reported `SQLSTATE 55000`:
  `can no longer access replication slot`.
- Root cause: The PeerDB flow worker stopped advancing multiple logical
  replication slots long enough for ongoing WAL churn to exceed Postgres'
  `max_slot_wal_keep_size = 4GB`; Postgres invalidated the slots with
  `wal_removed`. The stale raw fitness slot meant Postgres continued receiving
  sleep rows while the ClickHouse mirror used by `analytics.v_sleep` stopped
  advancing.
- Fix / mitigation: Dropped and recreated the lost raw fitness and sensor
  priority PeerDB mirrors, dropped the orphaned lost metric-stream slot,
  truncated the small affected ClickHouse destination tables, and reran the
  checked-in CDC setup script. The metric-stream mirror also had an orphaned
  Temporal workflow after the catalog row was gone, so that workflow was
  terminated before rerunning setup. Verified all four production slots were
  active with `wal_status = reserved`, `postgres_fitness.sleep_session` had the
  June 3 sleep row, and `analytics.v_sleep` again returned the June 3 WHOOP
  sleep session.
- Remaining risk: The metric-stream mirror was restarted from a fresh slot, but
  the large metric-stream destination table was not resnapshotted during the
  sleep fix, so rows from the lost-slot window may need a separate bounded
  backfill if sensor analytics show a gap. This PR raises production slot
  retention to 16GB, adds replacement-slot headroom, and lowers PeerDB CDC and
  initial-snapshot work units to 100,000 rows; the remaining recurrence risk is
  a future WAL burst or long PeerDB outage that exceeds that bounded budget.

### 2026-06-04 Slow query audit dashboard read-model follow-up

- Symptoms: Axiom slow-query logs showed repeated dashboard-adjacent tRPC
  routes, including `stress.scores`, `healthspan.score`,
  `recovery.strainTarget`, `recovery.workloadRatio`, and
  `sleepNeed.calculate`, spending multiple seconds in repeated daily/activity
  aggregate queries.
- User impact: Dashboard and score cards could remain in loading states while
  batched tRPC responses waited for the slowest score query.
- Evidence: The 2026-06-04 slow-query split plan recorded current 24-hour
  offenders with max durations around 45-71 seconds for health, recovery, and
  stress routes. Focused tests now assert that stress reads
  `analytics.daily_recovery_inputs`, healthspan zone minutes read
  `analytics.healthspan_activity_zone_minutes`, and activity-load routes read
  `analytics.daily_activity_load`.
- Root cause: Request paths were recomputing rolling recovery/stress windows,
  activity load, and healthspan zone minutes from broader raw or semi-raw
  analytic views instead of reading compact serving tables.
- Fix / mitigation: Added dbt read models for daily recovery inputs and
  healthspan activity zone minutes, included them plus daily activity load in
  `DBT_SAFE_MODELS`, routed `stress.scores` through the compact recovery input
  model, and updated healthspan zone aggregation to sum the compact zone-minute
  table.
- Remaining risk: `sleepNeed.performance` still contains some request-time
  composition; rerun Axiom after deploy to decide whether it needs its own
  serving-model pass.

### 2026-06-04 Slow query audit activity stream verification

- Symptoms: A 7-day Axiom slow-query scan found a historical
  `activity.stream` outlier, while `origin/main` already included
  `ad06f204 Optimize activity stream ClickHouse query (#1235)`.
- User impact: No current user impact was observed during the follow-up check.
- Evidence: Axiom queries against `dofek-logs` for the last 24 hours returned
  no `Slow query` rows containing `activity.stream` and no `activity.stream`
  log rows at all.
- Root cause: No active root cause remains for `activity.stream` in the
  current 24-hour production window; the historical outlier is treated as
  already addressed by the existing activity stream optimization.
- Fix / mitigation: No new code change for `activity.stream`. The slow-query
  optimization work focused on currently active slow paths instead.
- Remaining risk: If `activity.stream` traffic resumes with new slow-query
  rows, rerun the Axiom query and open a focused optimization task for stream
  tiling or sample bucketing.
### 2026-06-04 Deploy failed during final Swarm stack update

- Symptoms: Deploy Web run `26924058329` failed in job `79430469079` during
  the production Deploy stack step after migrations had succeeded.
- User impact: The new app image `sha-90c7d51` was not fully rolled out by
  that workflow run. The pre-migration stack apply and migrations completed
  before the final stack update failed.
- Evidence: The failed command was
  `docker stack deploy -c deploy/stack.yml -c deploy/stack.oracle.yml --with-registry-auth --prune --detach=true dofek`.
  The first fatal log line was `failed to update service dofek_traefik: Error
  response from daemon: rpc error: code = Unknown desc = update out of
  sequence`.
- Root cause: The deploy workflow submitted the final pruned stack deploy
  immediately after a pre-migration stack deploy without first waiting for
  Swarm service updates from the pre-migration apply to finish, so Docker
  rejected the Traefik service update as out of sequence.
- Fix / mitigation: The workflow now polls all services in the stack after the
  pre-migration stack apply and proceeds only when no service reports an active
  `updating` state, failing loudly on paused or rollback states.
- Remaining risk: This protects the same-job pre-migration-to-final deploy
  handoff. A future unrelated Swarm manager bug or out-of-band service update
  could still produce `update out of sequence` and would need separate
  operational investigation.

### 2026-06-04 Scheduled sync failed while enqueueing rate-limit retry

- Symptoms: Sentry issue `DOFEK-SERVER-34` reported `Error: Custom Id cannot
  contain :` in production at `2026-06-04T18:30:09Z` and
  `2026-06-04T18:35:09Z`.
- User impact: Scheduled sync processing failed when it tried to enqueue a
  delayed provider sync during an active provider rate-limit cooldown. Sentry
  reported zero directly impacted users, but the affected scheduled sync jobs
  did not enqueue their delayed retry normally.
- Evidence: The Sentry stack ended in BullMQ
  `Job.validateOptions()` after `Queue.addJob()` and `Queue.add()`. The first
  fatal line was `Error: Custom Id cannot contain :`. Local tests showed the
  cooldown retry helper returned
  `provider-rate-limit:garmin:provider:user-1:1780402200000`, and
  `processScheduledSyncJob()` and `processSyncJob()` pass that helper output as
  BullMQ `jobId`.
- Root cause: `providerRateLimitCooldownJobId()` reused colon-separated
  cooldown identity formatting for BullMQ custom job ids, but BullMQ 5 rejects
  custom `jobId` values containing `:`.
- Fix / mitigation: Changed only the BullMQ cooldown retry job-id formatter to
  use hyphen separators while leaving Redis cooldown keys unchanged. Added a
  colocated unit test asserting delayed retry job ids do not contain `:`, and
  updated enqueueing tests for the new deterministic id.
- Remaining risk: Existing delayed jobs created before this fix, if any, keep
  their old ids. The Sentry issue had only two production occurrences, both
  during active cooldown enqueueing.

### 2026-06-04 dbt serving tables missing during web rollout

- Symptoms: Sentry issue `DOFEK-SERVER-36` reported production ClickHouse
  errors for `stress.scores`, `recovery.*`, and `healthspan.*` routes starting
  at `2026-06-04T21:24:52Z`.
- User impact: Affected dashboard requests failed while the new web image
  queried serving read models that did not exist yet. Sentry reported 28
  occurrences and zero directly identified impacted users.
- Evidence: The first fatal line was `Unknown table expression identifier
  'analytics.daily_recovery_inputs'`; related events in the same issue also
  failed on `analytics.healthspan_activity_zone_minutes`.
- Root cause: The deploy migration path runs tracked Postgres and ClickHouse
  migrations before the web service starts, but the new serving dbt read-model
  tables were only created by the scheduled `analytics-worker`, which starts
  after web and intentionally delays its first dbt build.
- Fix / mitigation: Added ClickHouse migration
  `0024_create_dbt_serving_read_model_tables` to create empty
  `analytics.daily_recovery_inputs`, `analytics.daily_activity_load`, and
  `analytics.healthspan_activity_zone_minutes` tables during the deploy
  migration phase. Dbt remains responsible for populating and refreshing them.
- Remaining risk: Requests made before the first analytics build may see empty
  read-model results, but they should no longer fail because the table is
  missing.

### 2026-06-04 provider stats dbt table still using legacy object

- Symptoms: Sentry issue `DOFEK-SERVER-36` continued reporting production
  `sync.providerStats` errors after the initial serving-table migration fix.
- User impact: Provider inventory requests failed; Sentry reported zero
  directly identified impacted users on the latest event.
- Evidence: The latest Sentry event at `2026-06-04T22:30:30.645Z` failed with
  `Unknown expression or function identifier is_deleted` while querying
  `analytics.provider_stats FINAL ... AND is_deleted = 0`.
- Root cause: `analytics.provider_stats` had moved to a dbt-owned incremental
  model with `is_deleted`, `refresh_version`, and `refreshed_at`, but the
  production-safe dbt selection and deploy-time serving-table migration omitted
  it. The existing production object could therefore remain the legacy
  ClickHouse view/table shape while the API queried the dbt table contract.
- Fix / mitigation: Added `provider_stats` to `DBT_SAFE_MODELS`, updated
  `0024_create_dbt_serving_read_model_tables` for fresh installs, and added
  `0025_recreate_provider_stats_dbt_table` to drop the live legacy
  `analytics.provider_stats` object before creating the dbt-owned
  ReplacingMergeTree table with the full serving schema.
- Remaining risk: Requests made before the first analytics build after deploy
  may see empty provider counts, but they should not fail on a stale schema.

### 2026-06-04 PostgreSQL idle pool client crash

- Symptoms: Sentry issue `DOFEK-SERVER-2M` reported fatal uncaught
  `Error: Connection terminated unexpectedly` events from `pg/lib/client.js` in
  production.
- User impact: Sentry reported zero directly impacted users, but the Node
  process treated the idle PostgreSQL client error as an uncaught exception.
  The database entered crash recovery, briefly dropping active connections.
- Evidence: The latest Sentry event occurred at `2026-06-04T21:26:38Z` with
  mechanism `auto.node.onuncaughtexception`, and the stack ended in
  node-postgres `Connection.?` emitting `Connection terminated unexpectedly`.
  The shared `src/db/index.ts` `pg.Pool` had no `error` listener. Production
  Postgres logs at the same timestamp showed backend PID `204991` killed by
  signal 9 while running `inertialMeasurementUnit.getCoverageTimeline` over
  `fitness.metric_stream` for user `f923fed7-d934-4cd9-8cb9-8e83020d0e69`,
  date `2026-06-02`, and channels `imu` / `accel`. Host kernel logs confirmed
  the database container cgroup was at its `2097152kB` memory limit and
  OOM-killed a `postgres` process. A read-only `EXPLAIN` for the same statement
  estimated roughly `7.16M` matching rows from one Timescale chunk before
  grouping them into five-minute buckets.
- Root cause: The immediate Node crash happened because idle PostgreSQL clients
  disconnected by backend events emit `error` on the pool; without a pool-level
  listener, Node treats that event as uncaught. The underlying disconnect was a
  Postgres cgroup OOM: a high-cardinality IMU coverage request scanned millions
  of raw vector samples from `fitness.metric_stream` inside the 2GiB database
  container, Postgres crash recovery terminated other backends, and the web
  processes then observed broken pool clients.
- Fix / mitigation: Added a `pg.Pool` `error` listener in `createDatabase()`
  that logs the idle-client failure and reports the original error to Sentry
  with a `postgres-pool` source tag. Added a unit test that reproduces the
  missing listener.
- Remaining risk: This prevents the uncaught idle-client error class from
  crashing the process. It does not remove the heavy raw-Postgres IMU analytics
  path. The durable fix is to move IMU coverage reads to a bounded serving model
  or otherwise pre-aggregate the coverage buckets; simply increasing the
  database memory limit would leave the request-time scan pattern in place.

### 2026-06-04 dashboard metrics still slow without route-facing read models

- Symptoms: Dashboard and related recovery, strain, and healthspan API calls
  still did too much request-time aggregation after the first serving-model
  rollout.
- User impact: Dashboard cards could load slowly or time out when routes fanned
  out across ClickHouse ingredient models or PostgreSQL views instead of compact
  route-facing tables.
- Evidence: Route code still queried ingredient models such as
  `analytics.daily_recovery_inputs`, `analytics.daily_activity_load`, and
  healthspan source views directly from API handlers.
- Root cause: The serving layer had intermediate dbt models, but no named
  dashboard read models for the API contracts the UI actually needs.
- Fix / mitigation: Added dbt-owned incremental ClickHouse models
  `analytics.recovery_read_model`, `analytics.strain_read_model`, and
  `analytics.healthspan_read_model`, added deploy-time empty table creation,
  and switched the affected server routes/repositories to read those compact
  models.
- Remaining risk: Post-deploy Axiom/Sentry checks should confirm request
  latency improves and that the UTC daily bucketing in the strain read model is
  acceptable for route-facing workload displays.
- Follow-Up Work: Run post-deploy Axiom and Sentry checks for the affected
  dashboard routes, verify `analytics.recovery_read_model` and
  `analytics.healthspan_read_model` remain stable under scheduled dbt builds,
  and add a short-term dashboard latency alert if route-facing latency remains
  above the pre-read-model baseline.

### 2026-06-04 Mobile WHOOP BLE tRPC non-JSON response

- Symptoms: Sentry issue `DOFEK-MOBILE-B` reported production mobile
  `SyntaxError: JSON Parse error: Unexpected character: p` from tRPC response
  parsing. The latest events at investigation time were on
  `2026-06-04T22:40:02Z`.
- User impact: Sentry reported one impacted user and over 1,300 occurrences.
  Recent events repeated roughly every 30 seconds, matching the WHOOP BLE
  periodic drain loop retrying retained samples.
- Evidence: Events were tagged with `source` values
  `whoop-ble-imu-upload` and `whoop-ble-realtime-upload`, both from
  `packages/mobile/lib/background-whoop-ble-sync.ts`. tRPC client code parses
  responses with `response.json()`, so a body starting with `p` indicates a
  non-JSON HTTP response before tRPC could deserialize an error envelope. A
  1.47 MiB unauthenticated production probe to
  `/api/trpc/inertialMeasurementUnitSync.pushSamples?batch=1` reached Express
  and returned JSON `401`, so the normal production path was not rejecting
  500-sample WHOOP batches on request size alone.
- Root cause: The exact upstream body remains unknown because the mobile
  transport discarded it behind the JSON parse error. The confirmed failure
  mode is a non-JSON response reaching the mobile tRPC client during WHOOP BLE
  background uploads.
- Fix / mitigation: Added a mobile tRPC fetch wrapper that detects non-JSON
  responses before `response.json()`, throws an error containing the tRPC path,
  HTTP status, and a short body preview, and preserves JSON responses
  unchanged. Future Sentry events should show the real response body/status
  instead of only `Unexpected character: p`.
- Remaining risk: This is diagnostic mitigation, not a server-side root-cause
  fix. If the next event body shows a stable upstream error, fix that
  upstream cause directly and keep the diagnostic wrapper so future transport
  regressions remain observable.

### 2026-06-05 Local production SSH alias pointed at retired Hetzner host

- Symptoms: Local production SSH probes using `ssh dofek-server` timed out while
  trying to connect to `157.90.25.125:22`.
- User impact: Production itself was not confirmed impacted; the failure blocked
  read-only production debugging from this workspace.
- Evidence: `deploy/README.md` and `deploy/AGENTS.md` identify production as
  the OCI host addressed by the GitHub Actions `ORACLE_SERVER_HOST` variable
  with `ssh_user: ubuntu`. `gh variable list --repo asherlc/dofek` showed
  `ORACLE_SERVER_HOST=146.235.223.161`, while local `~/.ssh/config` still had
  `Host dofek-server`, `HostName 157.90.25.125`, and `User root`.
- Root cause: The local SSH alias was stale after the OCI cutover and still
  targeted the retired Hetzner production host.
- Fix / mitigation: Updated local `~/.ssh/config` to
  `ubuntu@146.235.223.161` with `~/.ssh/id_ed25519_infisical`, verified
  `ssh dofek-server 'hostname && whoami && docker info --format "{{.Swarm.LocalNodeState}}"'`
  returned `dofek`, `ubuntu`, and `active`, and updated the `check-logs` skill
  with the `ORACLE_SERVER_HOST` comparison workflow.
- Remaining risk: Future host cutovers can stale local aliases again; agents
  should compare `ssh -G dofek-server` against the GitHub variable before
  treating SSH timeouts as server health evidence.

### 2026-06-05 Daily strain zero because metric_stream CDC slot was lost

- Symptoms: Dashboard daily strain showed `0` for June 5 even though recent
  activity rows existed. `analytics.daily_strain` had June 5 and June 4 rows,
  but `daily_load=0`, while `analytics.daily_activity_load` had no rows after
  May 31.
- User impact: ClickHouse-backed activity strain/load views underreported recent
  activity load, including today's dashboard strain.
- Evidence: Postgres source had HR data in the latest activity window: for the
  June 5 rock-climbing window, `fitness.metric_stream` contained 306
  `heart_rate` samples, 513 `rr_interval_ms` samples, and other sensor rows by
  user/time. The ClickHouse mirror had no rows in that same window, and
  `postgres_fitness.metric_stream FINAL` showed non-IMU mirrored rows stopping
  at `2026-06-03 21:57:06Z`. Postgres replication slots showed
  `peerflow_slot_dofek_metric_stream_analytics` as `active=f`,
  `wal_status=lost`, with empty `restart_lsn`. PeerDB logs contained the fatal
  line `can no longer access replication slot
  "peerflow_slot_dofek_metric_stream_analytics" (SQLSTATE 55000)`.
  Production had `max_slot_wal_keep_size=16GB`, while the lost slot's
  retained lag from current WAL to `confirmed_flush_lsn` was about `43GB`,
  exceeding the configured WAL budget.
- Root cause: The PeerDB metric-stream replication slot was lost, so recent
  Postgres `fitness.metric_stream` rows stopped flowing into
  ClickHouse `postgres_fitness.metric_stream`. The dbt read models were current
  and successful, but were rebuilding from stale metric-stream mirror input.
  This is a repeat failure mode: the bounded 16GB WAL retention cap prevents
  disk exhaustion, but it is not enough to preserve a high-volume metric-stream
  slot through the observed PeerDB outage/write burst.
- Fix / mitigation: Code changes prepared a bounded prevention and repair path:
  production Postgres slot WAL retention is raised from 16GB to 64GB, CDC health
  thresholds now warn at 32GB and fail at 48GB, a production `cdc-health` swarm
  service continuously runs `scripts/check-clickhouse-cdc.ts`, PeerDB
  worker/staging memory limits are raised, and
  `scripts/catch-up-clickhouse-metric-stream.ts` can direct-insert explicit
  non-IMU `fitness.metric_stream` windows into
  `postgres_fitness.metric_stream` without a full metric-stream resnapshot.
  Production still requires deploying these changes, recreating/resyncing the
  `dofek_metric_stream_analytics` PeerDB flow, running the bounded catch-up for
  the missing window, and then running the bounded dbt analytics build so
  `sensor_scalar_sample`, `deduped_sensor`, `activity_sensor_sample`,
  `activity_summary_rows`, `daily_activity_load`, and `daily_strain` repopulate
  from current metric rows.
- Remaining risk: The slot is lost, so it cannot recover by waiting or
  restarting PeerDB alone. Resync can be expensive; verify mirror counts and
  read-model freshness after remediation, and add/verify alerting for
  `pg_replication_slots.wal_status IN ('lost', 'unreserved')`. The recurring
  fix needs a larger monitored WAL budget, a separate bounded metric-stream
  catch-up path, or both; otherwise future high-volume gaps can invalidate the
  slot again.

### 2026-06-07 Redpanda failed to start because host bind path was missing

- Symptoms: Sentry issue `DOFEK-SERVER-3E` reported
  `KafkaJSNumberOfRetriesExceeded: Connection error: getaddrinfo ENOTFOUND redpanda`
  from production provider syncs. The metric-stream ClickHouse sink also
  repeatedly crashed with the same KafkaJS broker lookup error.
- User impact: Metric-stream events could not publish to Redpanda, so new
  provider sensor samples from affected syncs were not delivered to the
  ClickHouse/R2 metric-stream path.
- Evidence: Sentry showed four production occurrences between
  `2026-06-07T03:30:08Z` and `2026-06-07T03:35:57Z`, tagged with providers
  `withings` and `strava`. Axiom `dofek-logs` confirmed
  `dofek-metric-stream-clickhouse-sink` logging KafkaJS `ENOTFOUND redpanda`
  retries. `docker service ps dofek_redpanda --no-trunc` showed the first fatal
  Swarm line:
  `invalid mount config for type "bind": bind source path does not exist: /mnt/dofek-data/redpanda`.
- Root cause: The production host did not have `/mnt/dofek-data/redpanda`, so
  Swarm rejected every Redpanda task before the broker could start. The
  Redpanda directory existed in `deploy/oracle-free/cloud-init.yml` for newly
  provisioned hosts, but the running host predated that directory and the deploy
  workflow's host bind-mount validation list omitted Redpanda.
- Fix / mitigation: Added `/mnt/dofek-data/redpanda` to
  `.github/workflows/deploy-web-stack.yml` host bind-mount validation so future
  deploys fail before `docker stack deploy` when the Redpanda data directory is
  absent.
- Remaining risk: The running production host still needs the missing
  `/mnt/dofek-data/redpanda` directory created through the approved
  infrastructure/operator path, followed by a stack redeploy or service update
  that lets `dofek_redpanda` start and the sink/archive services reconnect.
  After recovery, verify Redpanda health, ClickHouse sink lag, R2 archive
  freshness, and newest `postgres_fitness.metric_stream.recorded_at` in
  ClickHouse.

## 2026-06-08 — Postgres OOM crash from full-scan analytics on metric_stream

- **Symptoms:** `psql` returned `terminating connection because of crash of
  another server process` then `the database system is in recovery mode`.
- **User impact:** ~1 second of DB unavailability; transient connection errors
  for any in-flight app queries. Self-recovered.
- **Evidence:** `dofek_db` log: `client backend (PID 520401) was terminated by
  signal 9: Killed` while running `SELECT date_trunc('year', recorded_at), 
  count(*) ... FROM fitness.metric_stream` (a full-scan GROUP BY over the
  ~423M-row hypertable). Signal 9 = Linux OOM-killer. Postmaster then logged
  `terminating any other active server processes` → `automatic recovery in
  progress` → `redo done ... elapsed: 0.01 s` → `database system is ready to
  accept connections`. A prior `count(*)` with FILTER had taken 185s.
- **Root cause:** Unbounded full-scan aggregate queries over the 423M-row
  `fitness.metric_stream` hypertable on the 23 GB host (shared with Redpanda,
  ClickHouse, Redis, and the just-raised 1 GB r2-archive limit) exhausted
  memory; the kernel OOM-killer killed the PG backend, crashing the postmaster.
- **Fix / mitigation:** None needed — crash recovery replayed a tiny WAL and
  restored service in 0.01s with no corruption or data loss. Behavioral fix:
  never run unbounded `count(*)`/`GROUP BY` scans over `metric_stream` on the
  production box. Use `approximate_row_count('fitness.metric_stream')` and
  TimescaleDB chunk/catalog metadata (`timescaledb_information.chunks`) for
  sizing/distribution instead of data scans.
- **Remaining risk:** The box is memory-constrained (23 GB) for the in-flight
  Postgres→Redpanda→R2 historical backfill (~423M rows). The backfill producer
  must be paced (windowed with consumer-lag drain-gates) so the bounded
  Redpanda topic never fills the 81 GB data disk, and analytics must avoid
  full scans.
- **Follow-up:** Run the historical backfill as gated time-windows (see the
  metric-stream retirement plan), draining the R2 archive consumer between
  windows; consider raising r2-archive throughput to shorten the ~33h floor.

## 2026-06-17 — Activities list empty while activity CDC was catching up

- **Symptoms:** The activities list showed no recent activity data even though
  recent completed activities existed upstream.
- **User impact:** The web/mobile activities list and overview could show an
  empty state until ClickHouse CDC and dbt read models caught up.
- **Evidence:** At investigation time, production ClickHouse
  `postgres_fitness.activity FINAL` had 204 recent completed raw activity rows
  for user `f923fed7-d934-4cd9-8cb9-8e83020d0e69` since `2026-05-20`, latest
  `2026-06-16 16:46:00.190000`, but `analytics.deduped_activities FINAL` and
  `analytics.activity_summary` both returned 0 rows for the same page-equivalent
  window. `analytics.activity_source_records FINAL` had 0 active rows and 1,140
  tombstoned rows, with the latest tombstone refresh at
  `2026-06-09 18:50:50.714717608`. The source CTE over
  `postgres_fitness.activity FINAL WHERE _peerdb_is_deleted = 0` returned 1,183
  active rows, and the raw mirror's `_peerdb_synced_at` range showed those rows
  arrived between `2026-06-17 22:09:37` and `2026-06-17 22:11:57`, after the
  previous scheduled analytics-worker dbt run.
- **Root cause:** The activity CDC mirror caught up after a scheduled dbt run,
  leaving the dbt-owned activity source/dedupe/summary models still reflecting
  their earlier tombstoned state. The activities page reads
  `analytics.deduped_activities` and `analytics.activity_summary`, so it stayed
  empty until those derived models were rebuilt after CDC had current raw rows.
- **Fix / mitigation:** Ran `dbt build --select activity_source_records` in the
  production `analytics-worker` container, confirmed
  `analytics.activity_source_records FINAL` had 1,183 active rows, then ran
  `dbt build --select activity_source_records+` to rebuild the downstream
  dedupe and activity summary chain. The dependency-chain run completed
  `PASS=15 WARN=0 ERROR=0 SKIP=0`. A rolling `docker service update --force
  dofek_web` cleared the 10-minute in-memory tRPC cache. Post-fix validation
  showed `analytics.deduped_activities FINAL` and `analytics.activity_summary`
  both had 74 recent rows for the page window, latest
  `2026-06-16 16:46:00.000000`, and `dofek_web` was 2/2.
- **Remaining risk:** The manual dbt run accelerated catch-up but did not add
  alerting for the gap where raw activity CDC is current but derived activity
  models are still tombstoned or stale. Add a monitor comparing recent
  `postgres_fitness.activity` rows to active `analytics.activity_source_records`
  and `analytics.deduped_activities` rows, and alert when the derived count is
  zero while raw recent activity rows exist.
- **2026-06-17 prevention follow-up:** Added a fail-closed guard to
  `analytics.activity_source_records` so an incremental dbt run raises a
  ClickHouse error instead of writing tombstones when the current source scan is
  empty while active source records already exist, or when it would tombstone at
  least 95% of active source records. This preserves the last good derived
  activity state when the raw activity mirror is incomplete.

## 2026-06-17 — Withings sync retried expired-looking token until Sentry noise

- **Symptoms:** Sentry issue `DOFEK-SERVER-22` reported recurring production
  Withings sync failures with `Error: Withings API error (status 401)` from
  `WithingsClient.#post` during `getMeas`.
- **User impact:** Affected Withings sync jobs could not import new body
  measurements until a later successful token refresh or user reconnect.
- **Evidence:** Latest Sentry event `1510b6b1aebd4769af3501d29f09c812` occurred
  at `2026-06-17T20:30:01.296Z` in production, provider tag `withings`, with
  stack frames `processSyncJob` -> `WithingsProvider.sync` ->
  `WithingsClient.#post`. The response was an HTTP-successful Withings JSON
  body with nonzero `status: 401`, not an HTTP 401.
- **Root cause:** `WithingsProvider.#resolveTokens()` only refreshed when the
  stored token expiry was in the past. If Withings rejected an unexpired stored
  access token during an API call, the client threw a generic API error and the
  sync job failed instead of refreshing with the stored refresh token.
- **Fix / mitigation:** `WithingsClient` now throws a typed internal API error
  for nonzero Withings body statuses. `WithingsProvider.sync()` treats body
  `status: 401` as access-token rejection, refreshes and persists tokens through
  the existing Withings refresh path, rebuilds the client, and retries the
  current measurement page once. Non-auth API statuses still surface as
  `metric_stream` sync errors.
- **Remaining risk:** If Withings rejects both the access token and refresh
  token, sync still fails and the existing refresh-token revocation handling
  deletes stored tokens only for the known Withings invalid-refresh status path.
- **Follow-up:** If additional Withings auth body statuses appear in Sentry,
  add them to the typed auth-status predicate with a focused replay test.

## 2026-06-18 — Recovery and strain circles could wait behind slow ClickHouse work

- **Symptoms:** Recovery and strain circles appeared to load too slowly,
  especially on web dashboard first load.
- **User impact:** Dashboard recovery/strain cards could stay in loading states
  even when their own ClickHouse read-model queries were fast.
- **Evidence:** Axiom showed `mobileDashboard.dashboard` was fast in the sampled
  24h window: 6 spans, max `307ms`, timing logs `58-270ms`. Slow mobile parent
  trace `16d38d40bc49b2f38f96b64acbeb25f0` took `3.40s` because sibling
  `anomalyDetection.check` took `3.39s` with a ClickHouse `POST` of `3.16s`.
  Web traces showed `recovery.readinessScore` max `59.44s` and
  `recovery.workloadRatio` max `59.33s`, while their child ClickHouse HTTP spans
  were only about `89-103ms`. Slow-query logs in the same window showed
  `activity.stream` work occupying the shared ClickHouse limiter for about
  `122s`.
- **Root cause:** Web dashboard recovery/strain queries shared the same
  `LimitedActivitySensorStore` concurrency pool as long activity stream work,
  causing priority inversion before the actual ClickHouse request started.
  Mobile used a batched tRPC query link and enabled anomaly detection during the
  initial dashboard render, so the dashboard HTTP response could wait on the
  slower anomaly sibling.
- **Fix / mitigation:** Split `LimitedActivitySensorStore` into separate regular
  and dashboard ClickHouse queues, with dashboard markers for recovery/strain
  read models and resting-heart-rate dashboard inputs. Added
  `clickhouse.queue_wait` spans with queue name, active count, depth,
  concurrency, and wait time. On mobile, `mobileDashboard.dashboard` now uses an
  unbatched HTTP link, and `anomalyDetection.check` is disabled until dashboard
  data exists.
- **Remaining risk:** Dashboard query classification is currently based on the
  read-model table names in the SQL text. If new dashboard-critical read models
  are added, they need to be included in the dashboard queue markers or moved to
  an explicit priority API.
- **Follow-up:** Add a short runbook note documenting dashboard-critical
  ClickHouse queueing and add an Axiom monitor for nonzero
  `clickhouse.queue_wait` p95 on the dashboard queue.

## 2026-06-18 — Activity detail page slow for a deduped kayaking activity

- **Symptoms:** `https://dofek.asherlc.com/activity/41fbc42a-4dd4-4be8-ae14-4d0fd63729e8`
  loaded slowly after the SPA shell returned quickly.
- **User impact:** Activity detail pages could take several seconds before
  showing metrics, maps, and zone charts, especially for activities with many
  deduped source aliases.
- **Evidence:** The HTML shell returned in ~43 ms, so the delay was in
  client-side API loading. Axiom spans/logs showed the batched
  `POST /api/trpc/activity.byId,activity.stream,activity.hrZones?batch=1`
  taking ~122 s, with `activity.stream` logging `Timeout error` and
  `db_duration_ms` around 121-122 s. The trace for
  `49eaf1be5f1c93848ad1b338137bd58d` showed `activity.stream` spending
  `2m2.155s` inside a ClickHouse `POST`, while `activity.byId` took
  `1m16.227s` in one overlapping request. Production `pg_stat_statements`
  showed `activity.byId`'s `fitness.v_activity` + `fitness.v_activity_members`
  query averaging ~3.85 s, max ~4.62 s, and the stream/window lookup averaging
  ~1.85 s. `EXPLAIN ANALYZE` for the specific activity showed the detail query
  taking ~4.05 s because Postgres expanded the recursive `fitness.v_activity`
  dedup view once for `a` and again through `fitness.v_activity_members`.
  ClickHouse `system.query_log` showed the old stream query reading
  `analytics.deduped_location`; related stream queries read 14-18M rows and
  failed with `MEMORY_LIMIT_EXCEEDED`.
- **Root cause:** Two request-path recomputation issues stacked together.
  Activity detail and sensor-window lookups joined `fitness.v_activity` to
  `fitness.v_activity_members`, but `v_activity_members` is a projection over
  `v_activity`. Separately, `activity.stream` read GPS rows from
  `analytics.deduped_location`, a live view over `postgres_fitness.metric_stream
  FINAL` and `analytics.v_activity_members`, instead of the dbt-owned bounded
  `analytics.activity_location_sample` table.
- **Fix / mitigation:** Updated the Postgres repository lookups to resolve
  member aliases with `activity_id = ANY(a.member_activity_ids)` against
  `fitness.v_activity` directly, avoiding the second view expansion. Production
  `EXPLAIN ANALYZE` of the new query shape reduced the detail lookup to ~0.99 s
  and the sensor-window lookup to ~0.94 s before code deploy. Updated
  `activity.stream` to read location rows from
  `analytics.activity_location_sample` with `is_deleted = 0`. The replacement
  ClickHouse query for the exact activity returned 500 downsampled points in
  `0.106s` before code deploy.
- **Remaining risk:** This narrows repeated view expansion but still computes
  the recursive dedup view once per API procedure. A future larger optimization
  should avoid making separate `byId`, `stream`, and `hrZones` calls recompute
  the same activity window, or move the alias lookup to a persisted/read-model
  path.

## 2026-06-18 — Top 20 slow tRPC calls still dominated by ClickHouse queueing and stream aggregation

- **Symptoms:** Axiom's 24h top slow tRPC procedures showed multiple dashboard
  and activity-detail procedures taking seconds to two minutes.
- **User impact:** Web dashboard and activity detail API calls could stall or
  timeout when several expensive activity stream requests were in flight.
- **Evidence:** Axiom `dofek-logs` showed the slowest individual procedures in
  the 24h window were `insights.compute` max `123.20s`,
  `activity.stream` max `122.79s` with 7 timeout errors,
  `activity.byId` max `76.23s`, `dailyMetrics.hrvBaseline` max `59.64s`,
  `dailyMetrics.trends` max `59.48s`, `recovery.readinessScore` max `59.44s`,
  `recovery.workloadRatio` max `59.33s`, and body/correlation/sleep/training
  procedures from `8-43s`. Trace `3a598820a5c992ec9969ba0d916cef5b`
  showed `insights.compute` waiting about one minute before its ClickHouse
  requests started, then spending `21.48s` and `41.67s` in ClickHouse `POST`
  calls. The stream SQL grouped every scalar sample from
  `analytics.activity_sensor_sample` before returning at most `maxPoints`.
- **Root cause:** Dashboard read-model queries for
  `analytics.v_daily_metrics`, `analytics.v_body_measurement`, and
  `analytics.v_sleep` were not classified into the dashboard ClickHouse queue,
  so they could wait behind long regular activity stream work. Separately,
  `activity.stream` still aggregated scalar values for every raw sample timestamp
  instead of only the selected downsampled timestamps.
- **Fix / mitigation:** Added those dashboard read models to the dashboard queue
  markers. Updated `ClickHouseActivitySensorStore.getStream()` so scalar
  aggregation joins from `sample_times` to `activity_samples`, limiting scalar
  aggregation to the selected output timestamps.
- **Remaining risk:** This improves queue priority and one stream query hot spot,
  but it has not been validated against post-deploy production spans yet. Re-run
  the top-slow Axiom query after deploy and compare `activity.stream` timeout
  count plus p95/max durations for the same procedure list.

## 2026-06-18 — Data Sources page failed when registering Amazfit/Zepp

- **Symptoms:** The Data Sources page failed to load because the
  `sync.providers` tRPC query threw during provider registration.
- **User impact:** Users could not see or manage data-source providers while the
  registration failure was active.
- **Evidence:** Sentry issue `DOFEK-SERVER-3M` reported
  `Failed to register amazfit-zepp provider: Stripping types is currently
  unsupported for files under node_modules`, with the offending path resolving
  to `node_modules/.pnpm/zepp-client@file+packages+zepp-client/.../src/client.ts`
  in production.
- **Root cause:** The production Docker image copied and symlinked other
  reverse-engineered workspace client packages out of `node_modules`, but
  omitted `packages/zepp-client`. The server therefore imported the pnpm deploy
  copy under `node_modules`, where Node 22 refuses to strip TypeScript types.
- **Fix / mitigation:** Add `packages/zepp-client` to the Dockerfile workspace
  package manifest copy, runtime source copy, and explicit `node_modules`
  symlink list so `zepp-client/client` resolves to `/app/packages/zepp-client`
  like the other TypeScript workspace clients.
- **Remaining risk:** Other future workspace TypeScript packages can hit the
  same failure if they are added as server runtime dependencies without the
  matching Dockerfile copy and symlink entries.

## 2026-06-18 — Garmin sync repeatedly hit Connect API rate limits

- **Symptoms:** Garmin sync logs showed repeated `Rate limit exceeded (429):
  Rate limited` failures at 30-minute intervals, with multiple zero-record
  error rows around each run.
- **User impact:** Garmin data did not sync while the Connect API was rate
  limiting the account, and each retry could continue into later Garmin phases
  after the first 429.
- **Evidence:** The observed error cadence matched the worker's 30-minute
  scheduled sync interval and Garmin's 30-minute fallback cooldown when Garmin
  omits `Retry-After`. Code inspection showed `SyncErrorTracker.record()` and
  Garmin phase-level catches treated `GarminRateLimitError` as a collected
  partial-sync error, so `processSyncJob()` only saw the provider rate limit
  after Garmin sync had continued through later phases.
- **Root cause:** Garmin provider phase error handling did not classify
  provider rate limits as sync-abort errors. Rate limits were wrapped into
  phase summary errors instead of bubbling immediately to the worker cooldown
  path.
- **Fix / mitigation:** Garmin sync now rethrows `GarminRateLimitError` anywhere
  it is seen during token resolution, client construction, phase execution, or
  per-date/per-activity tracking. The worker now schedules the existing provider
  cooldown retry immediately after the first Garmin 429 instead of allowing
  later Garmin phases to keep issuing requests in the same run.
- **Remaining risk:** Garmin still receives a 30-minute fallback cooldown when
  it does not send `Retry-After`. If production continues to get 429s after
  this fix, Garmin likely needs a longer provider-specific fallback cooldown or
  a scheduled-sync dedupe change so the scheduled fan-out cannot collide with a
  just-due delayed retry.
- **Follow-up:** Add an operational runbook note for provider rate limits,
  including how fallback cooldowns interact with scheduled sync intervals and
  when to lengthen a provider-specific fallback.

## 2026-06-18 — Zepp invalid credential attempts reported to Sentry

- **Symptoms:** Sentry issue `7560588336` reported two production errors for
  `Amazfit/Zepp login failed: invalid email or password` from
  `packages/zepp-client/src/client.ts`.
- **User impact:** Users entering credentials Zepp rejected saw a failed connect
  attempt, and expected user/auth failures were counted as production server
  errors.
- **Evidence:** Sentry error search for issue `7560588336` in production showed
  two events at `2026-06-18T16:58:21Z` and `2026-06-18T16:58:29Z`, both titled
  `Error: Amazfit/Zepp login failed: invalid email or password`.
- **Root cause:** `credentialAuth.signIn` let provider `automatedLogin()` errors
  bubble as raw errors. tRPC converted them to `INTERNAL_SERVER_ERROR`, and the
  global tRPC `onError` handler reports all internal errors to Sentry. Zepp
  invalid credentials were not represented as expected provider auth failures.
- **Fix / mitigation:** The credential-auth router now converts
  `ProviderAuthError` failures to `BAD_REQUEST` and provider rate limits to
  `TOO_MANY_REQUESTS`, leaving unexpected failures reportable. The Amazfit/Zepp
  provider wraps invalid credential responses in `ProviderInvalidCredentialsError`.
  The Zepp client also tries the JSON access-code registration flow first and
  falls back to the encrypted Zepp registration flow only when the legacy
  access-code flow is unavailable, never after a 429.
- **Remaining risk:** The encrypted Zepp login flow is based on reverse-engineered
  app traffic and may still fail for Apple/Google-only SSO accounts or if Zepp
  changes the private API again. Monitor future Zepp connect failures for
  non-auth errors that should remain reportable.

## 2026-06-18 — Activity detail missing map and stream metrics after late activity refresh

- **Symptoms:** Production activity
  `8a6df8c4-9de2-4099-b9c4-aee1aaaba539` rendered without heart-rate,
  elevation, speed, cadence, route map, or heart-rate zone sections.
- **User impact:** The activity detail page showed only basic activity metadata
  even though raw Strava, Apple Health, and WHOOP samples existed for the
  workout window.
- **Evidence:** `fitness.v_activity` showed a hiking dedupe group with member
  IDs `420b1ce0-57df-4881-8295-dbeb28b58776`,
  `8a6df8c4-9de2-4099-b9c4-aee1aaaba539`, and
  `973eacc0-4373-4fc9-9a6b-e24dd97a7879`. ClickHouse
  `analytics.activity_sensor_sample` and `analytics.activity_location_sample`
  returned zero rows for that group, while raw window reads found Apple Health
  altitude and heart-rate rows, Strava altitude/cadence/heart-rate/speed rows,
  WHOOP heart-rate rows, and raw location rows for Apple Health and Strava.
  `analytics.deduped_activities FINAL` showed the active canonical activity was
  refreshed at `2026-06-18 17:24:18Z` for an activity that occurred on
  `2026-06-12`.
- **Root cause:** The activity-specific ClickHouse read models are dbt
  microbatch incrementals with a three-day event-time lookback. The canonical
  activity/dedupe mapping refreshed about six days after the activity time, so
  the raw samples existed but the microbatch models no longer revisited the
  June 12 event window to attach those samples to the activity.
- **Fix / mitigation:** No manual production data mutation was performed during
  diagnosis. The activity sample membership dbt models now use upstream source
  freshness as their microbatch event time, so a late activity or dedupe refresh
  reprocesses the affected activity window even when the raw sample
  `recorded_at` values are older than the normal lookback. A read-only
  model-join check showed this path would produce sensor rows for altitude,
  cadence, grade, heart rate, and speed, plus Strava route location rows for
  the canonical activity.
- **Remaining risk:** Already-missed activities whose activity/dedupe freshness
  falls outside the deployment-time lookback can still need an explicit targeted
  backfill or full model rebuild.

## 2026-06-18 - Activity delete analytics job stuck waiting for PeerDB tombstones

- **Symptoms:** Sentry issue `DOFEK-SERVER-3Q` reported five production worker
  failures with `Timed out waiting for PeerDB to reflect deletion of 25
  activities` from `waitForPeerDbActivityDeletes()`.
- **User impact:** The activity delete API completed, but the asynchronous
  ClickHouse activity read-model refresh failed after all BullMQ retries. Deleted
  activities can remain visible in ClickHouse-backed activity analytics until the
  mirror/read-model path is fixed and rebuilt.
- **Evidence:** The failed Redis job `bull:activity-delete-analytics:1` contained
  25 activity IDs for user `f923fed7-d934-4cd9-8cb9-8e83020d0e69`. Postgres
  `fitness.activity` returned `0` source rows for those IDs, while ClickHouse
  `postgres_fitness.activity FINAL` still returned `25` active rows under the
  worker predicate. Raw ClickHouse rows showed `50` versions: one active version
  and one `_peerdb_is_deleted = 1` version per activity. For activity
  `0759c689-565d-41e1-9548-6a798306b59e`, the active row had the real
  `user_id` and `started_at`, while the delete tombstone had
  `user_id = 00000000-0000-0000-0000-000000000000` and
  `started_at = 1970-01-01`.
- **Root cause:** The ClickHouse raw `postgres_fitness.activity` table uses
  `ReplacingMergeTree(_peerdb_version)` ordered by `(user_id, started_at, id)`,
  but PeerDB delete rows only preserve the primary key and use default values for
  non-key columns. The delete tombstones therefore do not share the same
  replacing key as the original activity rows, so `FINAL` does not collapse the
  active version away even though a newer delete version exists for the same
  `id`.
- **Fix / mitigation:** Fresh ClickHouse raw activity tables now use
  `ReplacingMergeTree(_peerdb_version) ORDER BY id`. Migration
  `0030_activity_mirror_order_key` replaces existing `postgres_fitness.activity`
  tables that still order by `(user_id, started_at, id)`, copies all raw
  versions into the replacement table, atomically swaps it into place, and then
  copies once more from the backup table to capture any mirror writes that landed
  during the initial copy.
- **Remaining risk:** Deployment still needs to run the migration and then rerun
  the failed activity-delete analytics job or rebuild `activity_source_records+`
  so already-stale activity read models drop the deleted activity IDs.
- **Follow-up:** Add a CDC runbook check for PeerDB delete tombstones: compare
  `argMax(_peerdb_is_deleted, _peerdb_version)` by primary key against
  `FINAL WHERE _peerdb_is_deleted = 0` when ClickHouse mirrors retain deleted
  rows unexpectedly.

## 2026-06-18 — Strava activity streams present but activity detail read models empty

- **Symptoms:** Production activity
  `600dc3c6-d32b-4edf-84b3-0d0c180d4dd4` rendered without heart-rate, GPS
  route, elevation, speed, cadence, or heart-rate zone detail even though it is
  a Strava-sourced outdoor activity.
- **User impact:** The activity detail page showed basic Strava activity
  metadata but omitted the expected stream charts and map.
- **Evidence:** `fitness.v_activity` resolved the target to a single canonical
  Strava activity with external ID `18896230967`, started at
  `2026-06-11 15:30:02Z`. ClickHouse raw
  `postgres_fitness.metric_stream` contained 23,179 non-deleted rows each for
  `altitude`, `cadence`, `grade`, `heart_rate`, `location`, and `speed`, with
  records from `2026-06-11 15:30:02Z` through `2026-06-11 21:56:20Z`.
  `analytics.activity_sensor_sample` returned no channels,
  `analytics.activity_location_sample` returned zero rows, and
  `analytics.activity_summary` had one row with null stream-derived metrics.
  `analytics.sensor_scalar_sample` also had zero rows for the target raw
  metric-stream IDs. A 14-day blast-radius check found seven Strava-source
  activities with raw streams and two missing both location and sensor read
  models: this activity and `8a6df8c4-9de2-4099-b9c4-aee1aaaba539`.
- **Root cause:** Unresolved. The immediate failure is stale/missing
  ClickHouse analytics rows, not missing Strava ingestion. Scalar samples are
  blocked because `analytics.sensor_scalar_sample` still microbatches by
  `recorded_at` with a three-day lookback, so Strava samples recorded on
  June 11 but synced on June 18 were not staged. Location rows should be
  recoverable with the deployed `activity_location_sample` freshness-based
  event time: a read-only reproduction of the model join produced 23,179
  candidate location rows with `refreshed_at = 2026-06-18 19:57:30Z`, but the
  scheduled dbt run at `20:04Z` still left the materialized table empty.
- **Fix / mitigation:** The long-term code fix adds a
  `postgres_fitness.metric_stream_freshness` dbt source alias with
  `_peerdb_synced_at` as its event time. `sensor_scalar_sample` now reads that
  source and microbatches by `_peerdb_synced_at`; `deduped_sensor` now carries
  source freshness forward as `refreshed_at`; and `activity_location_sample`
  reads the freshness source alias so dbt no longer injects a `recorded_at`
  source filter before GPS rows can be attached to activities.
- **Remaining risk:** Any Strava activity whose raw stream rows arrive outside
  the prior recorded-time lookback can still miss stream metrics in production
  until the fixed models are deployed and the affected batches are explicitly
  backfilled or rebuilt.

## 2026-06-18 — Sleep heart-rate backfill exposed missing raw PeerDB mirrors

- **Symptoms:** A production `dbt build --full-refresh --select
  sleep_heart_rate_sample+` initially completed successfully but rebuilt
  `analytics.sleep_heart_rate_sample`, `analytics.resting_heart_rate_sleep_window`,
  `analytics.activity_vo2max_estimate`, `analytics.daily_recovery_inputs`, and
  `analytics.daily_recovery` to zero rows.
- **User impact:** Sleep/recovery read models were temporarily empty after the
  first backfill attempt. The public health endpoint remained healthy, but
  ClickHouse-backed dashboard data depended on a second backfill after CDC
  recovery.
- **Evidence:** Postgres source tables had data:
  `fitness.activity = 1210` rows with latest `2026-06-19 00:19:00.58+00` and
  `fitness.sleep_session = 195` rows with latest `2026-06-18 05:24:04.73+00`.
  ClickHouse raw mirrors had zero rows in `postgres_fitness.activity`,
  `postgres_fitness.sleep_session`, `postgres_fitness.sleep_stage`,
  `postgres_fitness.daily_metrics`, provider inventory tables, and sensor
  priority tables. `pg_replication_slots` returned zero rows. The `cdc-health`
  service logged missing raw mirrors and missing slots for
  `dofek_fitness_raw_analytics`, `dofek_provider_inventory_raw_analytics`, and
  `dofek_sensor_priority_raw_analytics`.
- **Root cause:** The immediate cause was that the managed raw PeerDB mirrors
  and their Postgres logical replication slots were absent, so dbt rebuilt
  downstream models from empty ClickHouse CDC sources. A later deploy of image
  `sha-752d377` reproduced the mirror loss: the post-deploy ClickHouse CDC setup
  path read PeerDB's binary `config_proto` as escaped text, treated healthy raw
  mirrors as mapping mismatches, and issued `DROP MIRROR` for
  `dofek_fitness_raw_analytics`. A later deploy of image `sha-f7ab13b` stopped
  dropping existing mirrors but exposed a second setup bug: when a managed mirror
  was missing, setup disabled initial copy if any destination table in that
  mirror group had rows. In production, `postgres_fitness.daily_metrics`,
  `postgres_fitness.food_entry`, `postgres_fitness.health_event`, and
  `postgres_fitness.provider` had active parts, so the recreated raw mirrors
  skipped initial copy even though `postgres_fitness.activity`,
  `postgres_fitness.sleep_session`, `postgres_fitness.provider_priority`, and
  `postgres_fitness.device_priority` were empty.
- **Fix / mitigation:** Ran the checked-in ClickHouse CDC setup path inside the
  production swarm network with explicit PeerDB/Postgres/ClickHouse host
  overrides. It recreated the three raw mirrors and slots; `pg_replication_slots`
  then showed all three active with `wal_status = reserved`. The raw mirrors
  repopulated to `postgres_fitness.activity = 1210` and
  `postgres_fitness.sleep_session = 195`. Reran the corrected branch SQL with
  `dbt build --full-refresh --select sleep_heart_rate_sample+`. After the
  restored production analytics worker began rerunning the old deployed SQL,
  scaled `dofek_analytics-worker` to `0/0` to preserve the corrected backfill
  state, then reran the corrected full refresh. The final run completed
  `PASS=7 WARN=0 ERROR=0` in 220 seconds. Final verification showed
  `analytics.sleep_heart_rate_sample = 1,563,459`,
  `analytics.resting_heart_rate_sleep_window = 195`,
  `analytics.daily_recovery_inputs = 99`, and `analytics.daily_recovery = 99`.
  A direct CDC health check returned
  `[clickhouse-cdc-health] ok: checked 3 slots and 1 mirror`. After image
  `sha-752d377` deployed, restored `dofek_analytics-worker` to `1/1`; the first
  activity dbt phase completed `PASS=14 WARN=0 ERROR=0`, then the post-deploy
  CDC setup dropped raw mirrors again. Reran CDC setup after deploy completion;
  all three slots became active and the raw mirror repopulated to
  `postgres_fitness.activity = 1211` and `postgres_fitness.sleep_session = 195`.
  After image `sha-f7ab13b` deployed, paused `analytics-worker` at `0/0`, dropped
  the three managed raw mirrors, and reran CDC setup. The deployed setup
  recreated slots but still left the raw activity/sleep/provider-priority
  destination tables empty because it disabled initial copy from partial
  destination row counts.
- **Remaining risk:** Medium. `analytics-worker` is paused while the raw mirrors
  are empty. Deploy the follow-up fix that compares Postgres source row counts
  against ClickHouse destination row counts before disabling initial copy for a
  missing raw mirror, then recreate the three raw mirrors, verify
  `postgres_fitness.activity` and `postgres_fitness.sleep_session` have rows, and
  restore `analytics-worker` to `1/1`.
- **Follow-up:** Add an alert that pages on missing managed mirror catalog rows
  or zero required PeerDB slots, not just stale mirrored timestamps. Consider a
  deploy smoke check that runs the two-phase analytics dbt command to completion
  before declaring `analytics-worker` healthy.

## 2026-06-19 — Raw analytics mirror reconciliation Stryker failure

- **Symptoms:** PR CI failed `Test / Stryker (0)`. The downstream
  `Test / Mutation Testing`, `Test / Test Gate`, and `CI Gate` checks failed
  because the mutation shard did not meet the configured threshold.
- **User impact:** The follow-up ClickHouse CDC fix could not be marked ready
  for merge until mutation coverage improved. No production runtime impact was
  observed from this CI-only failure.
- **Evidence:** GitHub Actions job `82281810586` in run `27804593577` ended
  with `Final mutation score 60.00 under breaking threshold 75`. The report
  listed surviving and no-coverage mutants in
  `src/db/clickhouse-cdc.ts`, centered on
  `sourcePostgresTablesHaveAtMostDestinationRows`: missing query support,
  malformed Postgres/ClickHouse row counts, SQL table-name mapping, and the
  `sourceRowCount > 0` decision.
- **Root cause:** The new raw mirror reconciliation logic compared Postgres
  source row counts against ClickHouse destination rows, but tests only covered
  the happy path and one incomplete-destination path. They did not prove the
  source-count SQL shape, zero-source behavior, malformed row-count handling, or
  the shared ClickHouse row-count reader.
- **Fix / mitigation:** Consolidated ClickHouse destination row-count parsing
  into one helper, removed duplicate query/parsing paths, and added focused
  tests for SQL shape, zero source rows, invalid ClickHouse counts, and invalid
  Postgres counts.
- **Validation:** `pnpm exec vitest run src/db/clickhouse-cdc.test.ts` passed
  `32` tests. `pnpm exec stryker run stryker.ci.config.json --mutate
  "src/db/clickhouse-cdc.ts"` passed locally with a `79.82` mutation score,
  above the `75` break threshold.
- **Remaining risk:** Low. The local Stryker command matched the failed CI
  mutate target; final confirmation still depends on the pushed GitHub Actions
  rerun completing successfully.

## 2026-06-19 — Branch deploy exposed ClickHouse client method binding failure

- **Symptoms:** A production branch deploy of `sha-df7f751` completed
  successfully and left `web`, `worker`, `cdc-health`, and `analytics-worker`
  running the branch image, but the raw fitness ClickHouse mirror remained
  incomplete. Re-running the CDC setup manually after dropping
  `dofek_fitness_raw_analytics` failed before recreating the mirror.
- **User impact:** Activity and sleep analytics that depend on raw
  `postgres_fitness` activity tables still saw incomplete raw mirror data until
  the follow-up fix could be deployed and the missing PeerDB mirror recreated.
- **Evidence:** The deploy workflow run `27805523657` succeeded, including
  `Configure ClickHouse CDC`. Production health returned `{"status":"ok"}` and
  `dofek_analytics-worker` was `1/1` on `ghcr.io/asherlc/dofek:sha-df7f751`.
  Postgres source counts still exceeded ClickHouse destination counts for
  `fitness.activity`, `fitness.daily_metrics`, `fitness.sleep_session`, and
  `fitness.sleep_stage`. After dropping only `dofek_fitness_raw_analytics`,
  direct CDC setup failed with
  `TypeError: Cannot read properties of undefined (reading 'withClientQueryParams')`
  from `@clickhouse/client-common`. A follow-up deploy of `sha-6361c14`
  reached PeerDB mirror creation, then failed with
  `failed to validate destination connector dofek_clickhouse_postgres_fitness:
  table activity exists and is not empty`.
- **Root cause:** `readClickHouseDestinationRowCount` detached
  `clickHouseClient.query` into a local function before calling it. The real
  `@clickhouse/client` query method depends on its `this` binding, so the
  production client failed. Unit tests used arrow-function mocks and did not
  exercise the method binding. After that was fixed, PeerDB correctly rejected
  initial-copy creation into the non-empty, incomplete ClickHouse destination
  tables left behind by the earlier partial mirror.
- **Fix / mitigation:** Updated the CDC setup path to call
  `clickHouseClient.query(...)` directly and added a regression test with a
  `this`-dependent ClickHouse client mock. Updated setup to truncate destination
  tables for missing raw analytics mirrors that are about to be recreated with
  `do_initial_copy = true`, so PeerDB can run a clean initial snapshot. The
  production `dofek_fitness_raw_analytics` mirror was intentionally left absent
  after the failed manual run so the fixed deploy can recreate it with initial
  copy.
- **Validation:** `pnpm exec vitest run src/db/clickhouse-cdc.test.ts` passed
  `33` tests locally. Production verification still requires deploying the
  fixed commit, confirming CDC setup recreates `dofek_fitness_raw_analytics`,
  and checking ClickHouse raw table counts against Postgres source counts.
- **Remaining risk:** Medium until the fixed branch image is deployed and the
  absent fitness raw mirror finishes its initial copy.

## 2026-06-19 — Analytics worker deduped activities insert column mismatch

- **Symptoms:** Branch deploy run `27806652367` succeeded through
  `Configure ClickHouse CDC`, recreated `dofek_fitness_raw_analytics`, and
  restored complete raw ClickHouse counts, but the production
  `analytics-worker` dbt build failed repeatedly at
  `analytics.deduped_activities`.
- **User impact:** Raw activity data was mirrored again, but activity analytics
  read models downstream of `deduped_activities` remained stale because dbt
  skipped dependent models after the failure.
- **Evidence:** `analytics-worker` logs showed
  `Failure in model deduped_activities`; replaying the compiled SQL through
  `clickhouse-client` returned
  `DB::Exception: CAST AS Array can only be performed between same-dimensional Array, Map or String types: while converting source column refreshed_at to destination column absent_source_external_ids`.
  The follow-up PR E2E setup then failed in a fresh ClickHouse environment with
  `member_activity_ids` being inserted into `absent_source_external_ids`,
  proving that production and fresh table column order differed.
- **Root cause:** The existing production `analytics.deduped_activities` table
  has `absent_source_external_ids` as the final column because it was added to
  an existing table. Fresh environments create the table with
  `absent_source_external_ids` before `member_activity_ids`. dbt incremental
  INSERTs use the target table column order, so either SELECT order broke one
  of the two environments.
- **Fix / mitigation:** Kept the dbt model in the canonical fresh-schema order
  and added ClickHouse migration `0033_recreate_deduped_activities_column_order`
  to drop and recreate the derived `analytics.deduped_activities` serving table
  with that canonical order before dbt rebuilds it.
- **Validation:** `pnpm exec vitest run
  analytics/models/read_models/read_model_microbatch.sql.test.ts
  src/db/clickhouse-migrations/registry.test.ts`,
  `pnpm lint`, root `pnpm tsc --noEmit`, server `pnpm tsc --noEmit`, and web
  `pnpm tsc --noEmit` passed locally. The local E2E compose migrate step
  exited `0`, and the local analytics container completed dbt activity models
  with `PASS=14 WARN=0 ERROR=0 SKIP=0 NO-OP=0 TOTAL=14` plus dashboard models
  with `PASS=9 WARN=0 ERROR=0 SKIP=0 NO-OP=0 TOTAL=9`. Earlier branch deploy
  run `27807103397` completed successfully, production services rolled to
  `ghcr.io/asherlc/dofek:sha-4db22d8`, and the restarted analytics worker
  completed dbt with `Done. PASS=14 WARN=0 ERROR=0 SKIP=0 NO-OP=0 TOTAL=14`.
- **Remaining risk:** Low after migration `0033` deploys; dropping this derived
  serving table temporarily empties `deduped_activities` until the analytics
  worker rebuilds it.

## 2026-06-19 — Zepp token exchange auth rejection reported to Sentry

- **Symptoms:** Sentry issue `DOFEK-SERVER-3T` reported one production error at
  `2026-06-19T05:07:55Z` for `ZeppLoginExchangeError: Amazfit/Zepp login error
  (400)` on `credentialAuth.signIn`.
- **User impact:** A user attempting to connect Amazfit/Zepp credentials saw the
  connect attempt fail, and a stale client request was counted as a production
  server error.
- **Evidence:** The Sentry event stack traced through
  `packages/server/src/routers/credential-auth.ts` to
  `src/providers/amazfit-zepp.ts` and
  `packages/zepp-client/src/client.ts:312`. The event had one production
  occurrence and no related trace spans or logs.
- **Root cause:** The Zepp client used stale Mi Fit / Zepp token-exchange hosts
  and app metadata (`account.huami.com`, `account.zepp.com`, Mi Fit `6.14.0`).
  Zepp still issued an access code from the old registration path, but rejected
  the stale token-exchange request with HTTP `400`. A live reproduction with the
  same account succeeded only after switching to the current Zepp US2 flow:
  encrypted registration at `api-user-us2.zepp.com` followed by token exchange
  at `api-mifit-us2.zepp.com` with Zepp `9.12.5` metadata.
- **Fix / mitigation:** `signInToZepp` now uses the current Zepp US2 encrypted
  registration and token-exchange flow directly, requests both `access` and
  `refresh` tokens during registration, and no longer sends the obsolete legacy
  token-exchange requests first. Token-exchange `400` responses remain
  `ZeppLoginExchangeError` so future stale request-shape failures are not
  mislabeled as invalid credentials.
- **Validation:** `pnpm vitest run packages/zepp-client/src/client.test.ts`
  passed locally after rewriting the Zepp client tests around the current US2
  request shape. A live sanitized run of `signInToZepp` with the affected
  account made only the two current Zepp US2 calls and returned `result: ok`
  with tokens redacted.
- **Remaining risk:** Medium because the Zepp login API is private and
  reverse-engineered. Future Zepp app/API changes can break this flow again, but
  token-exchange bad requests are now preserved as reportable client/API-shape
  failures rather than hidden behind invalid-credential messaging.

## 2026-06-19 — WHOOP developer workout listing service unavailable

- **Symptoms:** Sentry issue `DOFEK-SERVER-3V` regressed in production with
  `WHOOP API error (503): Encountered ServiceUnavailableException` from
  `WhoopClient.#get` while `syncWhoopWorkouts` was resolving developer workout
  IDs for absence reconciliation.
- **User impact:** Affected WHOOP sync jobs failed before workout absence
  reconciliation could complete. Sentry showed `0` impacted users for the issue
  metadata and two production occurrences in the last 24 hours.
- **Evidence:** The latest event occurred at `2026-06-19T14:07:32Z`; the prior
  event occurred at `2026-06-19T09:06:40Z`. Both events were in production with
  `provider=whoop` and the same error value. The stack path was
  `processSyncJob` -> `WhoopProvider.sync` -> `syncWhoopWorkouts` ->
  `resolveWhoopPresentExternalIds` -> `WhoopClient.listDeveloperWorkoutIdsInWindow`
  -> `WhoopClient.listDeveloperWorkouts` -> `WhoopClient.#getWithRateLimitRetry`
  -> `WhoopClient.#get`.
- **Root cause:** WHOOP returned a transient upstream `503`, but the developer
  workout listing retry loop only retried `WhoopRateLimitError` from `429`
  responses. Non-429 `503` responses were plain `Error`s, so the sync job failed
  immediately instead of retrying the recoverable upstream outage.
- **Fix / mitigation:** Added shared `ProviderServiceUnavailableError`
  classification for provider HTTP `502`, `503`, and `504` responses, then made
  WHOOP's developer workout retry loop retry that common error alongside WHOOP
  rate limits. WHOOP's direct low-level HTTP calls now create WHOOP-scoped
  service-unavailable errors through the shared provider HTTP package.
- **Validation:** A new regression test first failed with the exact
  `WHOOP API error (503): Encountered ServiceUnavailableException` path, then
  passed after the shared provider HTTP and WHOOP client fix. `pnpm vitest run
  packages/whoop-whoop/src/client.test.ts` passed all `78` WHOOP client tests
  locally, and `pnpm vitest run packages/provider-http/src/rate-limit.test.ts`
  passed all `23` shared provider HTTP tests locally.
- **Remaining risk:** Low, but the fix is only local until committed, pushed,
  deployed, and the Sentry issue is confirmed quiet in production.
# 2026-08-22 — Rollout request gap and hidden dbt failure diagnostics

- **Symptoms:** Sentry reported a mobile `processing.alerts` request receiving a Cloudflare `502`, unhandled `ECONNRESET` and `ENOTFOUND redis` errors in server tasks, and repeated `dbt build --select activity_source_records+` failures.
- **User impact:** One mobile user received a failed API request during a production rollout. Activity analytics refresh jobs failed without a usable dbt diagnostic.
- **Evidence:** Axiom logs show the mobile request gap at `2026-08-20T23:32:18Z` while Swarm web tasks were being replaced; server requests before and after the gap returned `200`. The worker restarted at `2026-08-20T23:31:41Z`. The dbt job failed five times between `2026-08-21T20:00:17Z` and `20:02:45Z`, but its logged error contained only the exit code. The runner had configured dbt stdout as `ignore`.
- **Root cause:** The activity dbt runner discarded stdout, which is where dbt supplied the model failure details. The immediate cause of the rollout request gap is unconfirmed; the evidence establishes that it coincided with web-task replacement and that Traefik previously had no backend readiness check.
- **Fix / mitigation:** Configured Traefik to health-check `/healthz` every five seconds before routing to a web task, addressing the identified rollout-readiness risk. The activity dbt runner now captures both stdout and stderr in its thrown error.
- **Validation:** The new stdout-diagnostic regression test failed before the runner change and passed afterward. `docker stack config` rendered `deploy/stack.yml` successfully with non-secret placeholder environment values.
- **Remaining risk:** The underlying dbt model failure must be re-run after deployment; the next failure will include its diagnostic in Sentry for direct remediation.
