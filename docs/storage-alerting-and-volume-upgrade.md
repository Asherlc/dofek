# Storage Alerting And Volume Upgrade Plan

Production no longer uses the Terraform-managed Hetzner data volume described
by the original version of this plan. Production storage now lives on the OCI
host provisioned by `deploy/oracle-free/`, mounted at `/mnt/dofek-data`.

## Current Scope

- Production: monitor and expand the OCI data volume managed in
  `deploy/oracle-free/`.
- Staging: disabled; the main `deploy/` Terraform root no longer manages a
  staging server or volume.

## Alerting Targets

Alert on the host filesystem that backs `/mnt/dofek-data`, not only on Postgres
table size. The filesystem is the hard failure boundary.

Recommended thresholds:

| Level | Condition | Expected action |
|-------|-----------|-----------------|
| Warning | `/mnt/dofek-data` >= 70% used | Review growth trend and table/chunk sizes. |
| High | `/mnt/dofek-data` >= 85% used | Plan volume expansion or storage cleanup within 24 hours. |
| Critical | `/mnt/dofek-data` >= 95% used | Stop nonessential DB-heavy work and expand storage immediately. |

Also alert on storage-specific early warning signals:

- unexpected growth under `/mnt/dofek-data/postgres`, including WAL retained by
  inactive or lagging PeerDB slots;
- unexpected growth under `/mnt/dofek-data/clickhouse`, especially temporary
  data or mutation work;
- unexpected growth under `/mnt/dofek-data/redpanda`; the local log is a hot
  buffer, not the long-term metric-stream archive;
- unexpected growth under `/mnt/dofek-data/peerdb-catalog` or
  `/mnt/dofek-data/peerdb-minio`;
- stale `dofek-metric-stream-archive` R2 objects or lagging Redpanda archive
  consumption;
- long-running ClickHouse analytics builds, mutations, or backfills.

The Oracle production override scales Databasus to zero. Although Terraform
still provisions `dofek-db-backups`, no checked-in production service currently
writes relational Postgres backups to it. Treat the missing active Postgres
backup owner as an operational gap, not as a passing alert state. The
metric-stream R2 archive protects metric-stream events only.

## Upgrade Notes

For production, resize the OCI data volume in `deploy/oracle-free/` and grow
the filesystem on the mounted device. Do not proceed if Terraform plans to
replace the active host instead of resizing the intended volume.

OCI can expand an existing volume, but the guest partition and filesystem must
also be extended before the new capacity is usable. Follow Oracle's
[volume-resize](https://docs.oracle.com/en-us/iaas/Content/Block/Tasks/resizingavolume.htm)
and
[Linux partition/filesystem extension](https://docs.oracle.com/en-us/iaas/Content/Block/Tasks/extendingblockpartition.htm)
procedures for the actual device and filesystem discovered on the host; do not
copy device names from an example.
