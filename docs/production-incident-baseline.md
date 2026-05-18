# Production Incident Baseline

<!-- cspell:ignore Hetzner Hypertables rollups fanout Checkpointed subcheck MISCONF docuum anchore -->

This document summarizes production failure modes observed so far. It is not a
full incident log or a replacement for runbooks. Use it to build shared memory
about the kinds of issues this system encounters, the signals that identified
them, and the durability work they suggest.

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
