# Storage Alerting And Volume Upgrade Plan

Production no longer uses the Terraform-managed Hetzner data volume described
by the original version of this plan. Production storage now lives on the OCI
host provisioned by `deploy/oracle-free/`, mounted at `/mnt/dofek-data`.

## Current Scope

- Production: monitor and expand the OCI data volume managed in
  `deploy/oracle-free/`.
- Staging: monitor the Hetzner staging volume
  `hcloud_volume.dofek_staging_data`, mounted through `/mnt/dofek-data`.
- Review apps: disposable Hetzner servers; destroy stale review apps instead of
  expanding them unless a larger review-app server type is intentionally chosen.

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

- uncompressed `metric_stream` chunks older than 7 days;
- future-dated `metric_stream` chunks;
- `metric_stream` table/index growth above expected trend;
- latest Databasus backup older than 24 hours;
- active materialized-view refresh or compression work running longer than the
  documented maintenance window.

## Upgrade Notes

For production, resize the OCI data volume in `deploy/oracle-free/` and grow
the filesystem on the mounted device. For staging, adjust
`staging_data_volume_size_gb` in the main `deploy/` root and apply Terraform.
Do not proceed if Terraform plans to replace the active host instead of resizing
the intended volume.
