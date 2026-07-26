# OCI Host Agent Guide

Read [README.md](./README.md) first, then read
[`../README.md`](../README.md) for the production release flow.

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

Oracle documents volume resizing separately from guest partition/filesystem
extension:
<https://docs.oracle.com/en-us/iaas/Content/Block/Tasks/resizingavolume.htm>.
