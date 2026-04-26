# Storage Alerting And Volume Upgrade Plan

This document covers two near-term mitigations for production storage risk:

1. alert before the Hetzner data volume enters a danger zone;
2. safely add DB storage capacity without taking the site down.

The current production model is a single-node Docker Swarm stack. Postgres data
lives on the Hetzner Cloud Volume mounted through the stable host path
`/mnt/dofek-data/postgres`.

## Current Constraint

The data volume is Terraform-managed:

- `deploy/variables.tf`: `data_volume_size_gb`, default `100`.
- `deploy/server.tf`: `hcloud_volume.dofek_data`.
- host mount alias: `/mnt/dofek-data` points at `/mnt/HC_Volume_<id>`.
- Postgres bind mount: `/mnt/dofek-data/postgres:/var/lib/postgresql/data`.

Hetzner Volumes can be enlarged online, but not shrunk. After increasing the
volume size, the filesystem must be grown manually. For ext4, Hetzner documents:

```bash
resize2fs /dev/sdb
```

Sources:

- Hetzner volume overview:
  <https://docs.hetzner.com/cloud/volumes/overview/>
- Hetzner volume resize FAQ:
  <https://docs.hetzner.com/cloud/volumes/faq/>

## Alerting Targets

Alert on the host filesystem that backs `/mnt/dofek-data`, not only on Postgres
table size. The filesystem is the hard production failure boundary.

Recommended thresholds:

| Level | Condition | Expected action |
|-------|-----------|-----------------|
| Warning | `/mnt/dofek-data` >= 70% used | Review growth trend and table/chunk sizes. |
| High | `/mnt/dofek-data` >= 85% used | Plan volume expansion or storage cleanup within 24 hours. |
| Critical | `/mnt/dofek-data` >= 95% used | Stop nonessential DB-heavy work and expand storage immediately. |

Also alert on storage-specific early warning signals:

- uncompressed `metric_stream` chunks older than 7 days;
- future-dated `metric_stream` chunks;
- `metric_stream` table/index growth above expected trend;
- latest Databasus backup older than 24 hours;
- active materialized-view refresh or compression work running longer than the
  documented maintenance window.

## Alerting Implementation Plan

### Phase 1: Use Netdata For Host Disk Alerts

Netdata already runs in `deploy/stack.yml` and has host `/proc`, `/sys`, and
Docker socket access. The quickest alert path is to use Netdata's filesystem
collector for `/mnt/dofek-data`.

Implementation checklist:

1. Open `https://netdata.dofek.asherlc.com`.
2. Confirm `/mnt/dofek-data` or the underlying `/mnt/HC_Volume_<id>` mount is
   visible in the disk space charts.
3. Configure notifications through Netdata Cloud or the existing notification
   channel.
4. Set warning/critical thresholds at 70% / 85% initially, with 95% treated as
   operational emergency.
5. Trigger a dry-run notification if Netdata supports it.
6. Record the alert destination and exact chart/metric name in this document.

This phase does not require app deploys and does not touch production services.

### Phase 2: Add Repo-Owned Storage Report

Add a TypeScript script that can be run locally or in CI against production with
Infisical secrets. It should print:

- filesystem usage for `/mnt/dofek-data`;
- Postgres database size;
- top table and index sizes;
- `metric_stream` hypertable size;
- compressed and uncompressed chunk counts;
- uncompressed chunks older than 7 days;
- future-dated chunks;
- latest Databasus/R2 backup age if available.

The report should exit nonzero when thresholds are exceeded so it can become a
scheduled GitHub Action or deploy preflight later.

Proposed file:

```text
scripts/check-production-storage.ts
```

Proposed command:

```bash
infisical run --env=prod -- pnpm tsx scripts/check-production-storage.ts
```

Default thresholds:

```text
STORAGE_WARN_PERCENT=70
STORAGE_HIGH_PERCENT=85
STORAGE_CRITICAL_PERCENT=95
```

### Phase 3: Scheduled Alert Job

Once the storage report exists, run it on a schedule. Two reasonable options:

- GitHub Actions scheduled workflow using Infisical OIDC;
- a Swarm service/cron-like worker that emits structured logs to Axiom/Sentry.

Prefer GitHub Actions first because it is repo-owned, cheap, and easy to inspect.
If GitHub scheduled workflows prove unreliable enough for production alerting,
move the check into the running production stack.

## Zero-Downtime Capacity Expansion

### Recommended Path: Resize The Existing Volume In Place

This is the zero-downtime path for the current architecture. It keeps the same
volume ID, mount path, symlink, and Postgres bind mount. Postgres keeps running
while the block device and ext4 filesystem grow.

Use this for routine expansion from 100 GB to 250 GB, 500 GB, or similar.

#### Prechecks

Confirm the DB and app are healthy:

```bash
curl -fsS https://dofek.fit/healthz
ssh dofek-server 'df -h /mnt/dofek-data && findmnt /mnt/dofek-data && lsblk -f'
```

Confirm Postgres is not already under incident pressure:

```bash
ssh dofek-server 'container=$(docker ps --filter label=com.docker.swarm.service.name=dofek_db --format "{{.ID}}" | head -n 1); \
  printf "%s\n" "select pg_is_in_recovery();" \
  | docker exec -i "$container" sh -lc '\''PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U health -d health -P pager=off -f -'\'''
```

Confirm there is a recent backup:

```bash
# Use Databasus UI or R2 object listing. The latest dofek-db-backups object
# should be less than 24 hours old before changing storage.
```

#### Terraform Change

Edit the desired size in Terraform configuration or variable input:

```hcl
data_volume_size_gb = 250
```

Run from `deploy/` with Infisical-managed secrets:

```bash
terraform plan
terraform apply
```

Expected result:

- `hcloud_volume.dofek_data` size increases in place;
- `hcloud_server.dofek` is not replaced;
- the volume ID remains the same;
- `/mnt/dofek-data` symlink remains valid.

Do not proceed if Terraform plans to replace the server or volume.

#### Grow Filesystem Online

Find the block device backing `/mnt/dofek-data`:

```bash
ssh dofek-server 'findmnt -no SOURCE /mnt/dofek-data && lsblk -f'
```

For the current ext4 Hetzner volume, run `resize2fs` on the mounted block
device. Example:

```bash
ssh dofek-server 'device=$(findmnt -no SOURCE /mnt/dofek-data); resize2fs "$device"'
```

If `findmnt` returns a symlink or path that is not the raw block device, inspect
`lsblk -f` and use the matching `/dev/disk/by-id/...` or `/dev/sdX` volume path.
Do not guess the device name.

#### Validation

```bash
ssh dofek-server 'df -h /mnt/dofek-data && findmnt /mnt/dofek-data && lsblk -f'
curl -fsS https://dofek.fit/healthz
```

Check Postgres can still write:

```bash
ssh dofek-server 'container=$(docker ps --filter label=com.docker.swarm.service.name=dofek_db --format "{{.ID}}" | head -n 1); \
  printf "%s\n" "create temporary table storage_resize_smoke_check(id int); insert into storage_resize_smoke_check values (1); select count(*) from storage_resize_smoke_check;" \
  | docker exec -i "$container" sh -lc '\''PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U health -d health -P pager=off -v ON_ERROR_STOP=1 -f -'\'''
```

Record the old size, new size, date, and validation output in `.context/`.

### Not Recommended For Zero Downtime: Cut Over To A New Volume

Creating a new volume and moving `/mnt/dofek-data/postgres` to it is not
zero-downtime with the current single Postgres instance. A file-level copy of a
running Postgres data directory is not safe, and switching the bind mount
requires stopping the DB container.

A true new-volume zero-downtime migration would require a more complex plan:

1. create a second Postgres instance on the new volume;
2. replicate from old DB to new DB using physical or logical replication;
3. wait for replication lag to reach zero;
4. briefly stop writes;
5. promote/switch the app to the new DB;
6. keep the old volume until rollback is no longer needed.

That is not the right first mitigation for this repo. Resize the existing volume
in place unless there is a specific reason the current volume cannot be resized.

## Emergency Runbook

If `/mnt/dofek-data` is already at or above 95%:

1. Stop nonessential write-heavy work:

   ```bash
   docker service scale dofek_worker=0 dofek_training-export-worker=0
   ```

2. Confirm web health and DB state.
3. Resize the existing volume in place using the plan above.
4. Validate DB writes.
5. Restore workers:

   ```bash
   docker service scale dofek_worker=1 dofek_training-export-worker=1
   ```

Do not delete raw data as the first response. The product principle is that raw
data must be retained, even if future roadmap work moves old raw data into cold
object storage.
