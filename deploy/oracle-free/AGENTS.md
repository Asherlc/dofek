# OCI Host Agent Guide

Read [README.md](./README.md) first, then read
[`../README.md`](../README.md) for the production release flow.

## Agent contract

- Limit this Terraform root to the OCI host, network, reserved IP, and attached
  data volume; Cloudflare and application-stack changes belong under `deploy/`.
- Run `terraform fmt -check` and `terraform validate` for changes in this root.
  Review `terraform plan` before proposing an apply, and never apply without an
  explicit user request.
- Preserve existing Terraform resource identity unless replacement is the
  intended, reviewed result.

## Boundaries

- This is a separate Terraform root for the OCI host. Do not mix its local
  state with the primary `deploy/` Terraform root.
- Review `terraform plan` for host replacement, volume replacement, public-IP
  changes, limits, and cost before applying.
- Production uses the reserved public IP and the
  `ORACLE_SERVER_HOST` GitHub Actions variable.
- Keep `/mnt/dofek-data` and every stack bind-mount directory aligned with
  `cloud-init.yml` and the deploy workflow.
- Infrastructure changes roll out through Terraform and the canonical
  production workflow; do not add host-side deploy scripts.
- OCI limits and free allowances change independently of this repository.
  Cite current Oracle documentation rather than asserting cost or capacity.

Increasing `data_volume_size_gb` expands the OCI block device only; the
first-boot `cloud-init.yml` formats the raw device as ext4, but does not grow an
existing filesystem. Back up the volume, review the Terraform plan, and plan a
separate verified guest-filesystem expansion. OCI documents that volumes can
only grow, recommends a backup first, and lists the required post-resize guest
steps in its
[volume-resizing guide](https://docs.oracle.com/en-us/iaas/Content/Block/Tasks/resizingavolume.htm)
and
[online-resize procedure](https://docs.oracle.com/en-us/iaas/Content/Block/Tasks/update-online-resize-block-boot-volume.htm).
