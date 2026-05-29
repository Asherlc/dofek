# Migrating Dofek from Hetzner to Oracle Cloud Always Free

Runbook for moving a live Dofek deployment from the Hetzner production host to
an Oracle Cloud Infrastructure (OCI) Always Free Ampere A1 instance
(4 OCPU / 24 GB), provisioned by `deploy/oracle-free/`.

## What actually needs migrating

Only PostgreSQL holds canonical state. Everything else is either derived from
it or provider-independent, which keeps the migration small.

| Data store | Action | Why |
|---|---|---|
| **PostgreSQL** (TimescaleDB + PostGIS) | **Dump and restore** | Single source of truth — all raw fitness/health data. |
| **ClickHouse** | **Rebuild, don't copy** | Derived read model. PeerDB CDC + dbt regenerate it from Postgres. |
| **Redis** | Skip | BullMQ job queue only; repeatable jobs re-register on worker boot. |
| **PeerDB catalog + MinIO** | Skip | Internal CDC state; recreated fresh against the new Postgres. |
| **R2 buckets** (exports, OTA, backups, training data) | No migration | Live in Cloudflare, not Hetzner. Point the new host's env at the same buckets. |
| Docker volumes (pgadmin, portainer, netdata, job_files) | Skip | Recreatable / transient. |

Two properties make the Postgres move clean:

1. **Version-matched** — both hosts run `timescale/timescaledb-ha:pg18.3-ts2.26.4-all`
   (same Postgres major, TimescaleDB, and PostGIS), so there are no
   cross-version dump/restore hazards.
2. **Same CPU architecture** — Hetzner `cax21` and Oracle A1 are both ARM64, so
   the same container image runs unchanged.

This is a **short maintenance window**, not a zero-downtime cutover.

## Prerequisites

- Oracle host provisioned and reachable (`deploy/oracle-free/`, `terraform apply`).
- SSH access to both hosts. The Hetzner alias `dofek-server` is in
  `deploy/README.md`; reach the Oracle host as `ubuntu@<public_ip>` (printed by
  the Terraform `ssh_command` output).
- Production secrets available in Infisical for the new environment, with R2
  bucket keys reused as-is.
- A recent verified backup exists before you start (see `docs/storage-alerting-and-volume-upgrade.md`).

## Step 1 — Bring up the Oracle stack, DB only

Deploy the trimmed Oracle stack but let only the database settle first. From CI
or a remote Docker context pointed at the Oracle host:

```bash
docker stack deploy -c deploy/stack.yml -c deploy/stack.oracle.yml dofek
```

Confirm the `db` service is healthy before restoring:

```bash
docker ps --filter name=dofek_db
docker exec $(docker ps -qf name=dofek_db) pg_isready -U health -d health
```

## Step 2 — Quiesce writes on Hetzner

Stop new sync data from landing so the dump is a consistent point-in-time copy:

```bash
ssh dofek-server 'docker service scale dofek_worker=0 dofek_analytics-worker=0'
```

Leave `web` running if you want the dashboard read-only during the window, or
scale it to 0 as well for a hard freeze.

## Step 3 — Dump PostgreSQL on Hetzner

Custom-format dump streamed over SSH to your workstation:

```bash
ssh dofek-server \
  'docker exec $(docker ps -qf name=dofek_db) pg_dump -U health -Fc -d health' \
  > dofek-$(date +%F).dump
```

For a large `metric_stream` history this can be sizable; check the file size
before transferring. (Alternatively, use the latest object already in the
`dofek-db-backups` R2 bucket if it is recent enough — but a fresh dump after
quiescing writes is the safest source.)

## Step 4 — Restore on Oracle

TimescaleDB needs its restore guard around `pg_restore`. The
`timescaledb_pre_restore()` call sets the database-level `timescaledb.restoring`
flag, so the separate `pg_restore` connection picks it up; `post_restore`
re-enables background jobs and policies afterward.

Copy the dump to the Oracle host, then:

```bash
DB=$(docker ps -qf name=dofek_db)

# Ensure the extension exists at the matching version (the image bundles it).
docker exec -i $DB psql -U health -d health \
  -c "CREATE EXTENSION IF NOT EXISTS timescaledb VERSION '2.26.4';"

# Restore guard ON
docker exec -i $DB psql -U health -d health \
  -c "SELECT timescaledb_pre_restore();"

# Restore the dump
docker exec -i $DB pg_restore -U health -d health --no-owner < dofek-YYYY-MM-DD.dump

# Restore guard OFF (re-enables policies/background jobs)
docker exec -i $DB psql -U health -d health \
  -c "SELECT timescaledb_post_restore();"
```

Notes:
- Restore into the **empty** `health` database before the app connects, so no
  other sessions interfere with the restore flag.
- `--no-owner` avoids role-ownership mismatches; both hosts use the `health`
  role, so ownership maps cleanly anyway.
- `pg_restore` will print some **non-fatal errors** — typically that
  `timescaledb`/`postgis` already exist (the dump re-issues `CREATE EXTENSION`
  against a database where you just created it). These are expected; do not
  abort. Only a non-zero exit with missing tables/rows afterward is a real
  failure, which Step 5 catches.
- After restoring, optionally run `pnpm setup-db` against the Oracle Postgres to
  apply any migrations newer than the dump (idempotent).

## Step 5 — Verify the Postgres restore

Compare row counts and latest timestamps on the busiest tables between the two
hosts before trusting the cutover. For example:

```sql
SELECT count(*), max(recorded_at) FROM fitness.metric_stream;
SELECT count(*) FROM fitness.activity;
SELECT count(*) FROM fitness.food_entry;
```

Run the same queries on Hetzner (`ssh dofek-server 'docker exec ... psql ...'`)
and confirm they match. Spot-check a recent activity and its sensor samples.

## Step 6 — Rebuild ClickHouse from the migrated Postgres

ClickHouse stores nothing canonical, so recreate it rather than copying:

1. Bring up the `clickhouse` and `peerdb*` services (they are in the stack).
2. Apply ClickHouse migrations: `pnpm setup-db` runs the ClickHouse-side
   migrations after the Postgres ones (see `docs/clickhouse-metric-stream.md`).
3. Recreate the PeerDB peers and mirror as documented in
   `docs/clickhouse-metric-stream.md`. The initial snapshot replicates
   `metric_stream` and the raw fitness tables into `postgres_fitness.*`.
4. Let the `analytics-worker` (dbt) rebuild the derived read models
   (`analytics.deduped_sensor`, `analytics.activity_summary_rows`, etc.).

Run this **before** DNS cutover so the dashboard's activity analytics are
populated when traffic arrives. For a large sensor history the initial snapshot
plus dbt backfill is CPU-heavy and can take a while; watch the
`analytics-worker` logs until read models are current.

> Optimization (optional): if the initial snapshot is too slow, copy the
> ClickHouse read models directly with `clickhouse-backup` (or native
> `BACKUP`/`RESTORE` to R2) instead of regenerating. This is an optimization,
> not the default path.

## Step 7 — DNS cutover

Point the public hostnames at the Oracle public IP:

- Update the Cloudflare DNS records (or the Terraform `dns.tf` equivalent for
  the Oracle host) to the new IP.
- Traefik on the Oracle host re-issues Let's Encrypt certificates via the
  DNS-01 challenge automatically using the same `CF_DNS_API_TOKEN`.
- Because root domains are Cloudflare-proxied, propagation is effectively
  immediate once the origin IP changes.

## Step 8 — Verify the app, then resume syncs

1. Load the dashboard over HTTPS; confirm the cert is valid and data renders.
2. Hit `/healthz` — expect `{"status":"ok"}`.
3. Re-enable background work on Oracle:
   ```bash
   docker service scale dofek_worker=1 dofek_analytics-worker=1
   ```
4. Trigger a manual sync and confirm new data lands.

## Step 9 — Decommission Hetzner

Only after the Oracle host has run cleanly for long enough to trust it:

1. Take a final Hetzner dump and archive it to R2.
2. Scale down the Hetzner stack.
3. Destroy the Hetzner resources via its Terraform root when you are confident.

## Rollback

If the cutover misbehaves before you decommission Hetzner, rollback is just a
**DNS revert** to the Hetzner IP plus re-scaling the Hetzner `worker` /
`analytics-worker` back up. Hetzner Postgres still holds all data written up to
the freeze in Step 2; any data written to Oracle after cutover would need to be
reconciled manually, so decide early whether you are committing to the move.

## Known risks / things to validate on first run

- **A1 capacity**: provisioning the host may hit `Out of host capacity`; see
  `deploy/oracle-free/README.md` for retry and Pay-As-You-Go mitigation.
- **PeerDB re-setup**: the mirror configuration is not part of the Postgres
  dump and must be recreated per `docs/clickhouse-metric-stream.md`.
- **Dump size**: a large `metric_stream` hypertable dominates dump time and
  size; size it before transferring and budget the maintenance window
  accordingly.
