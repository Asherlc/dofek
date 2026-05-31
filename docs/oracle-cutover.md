# Oracle Production Cutover

The production cutover from Hetzner to Oracle Cloud is complete.

## Current State

- Production deploys target the OCI host in the `ORACLE_SERVER_HOST` GitHub
  Actions variable.
- Production deploys use `ssh_user: ubuntu` and apply
  `deploy/stack.oracle.yml` over `deploy/stack.yml`.
- Production DNS records in `deploy/dns.tf` point at `var.oracle_server_host`.
- The main `deploy/` Terraform root no longer manages a production Hetzner
  server or production Hetzner volume.
- Hetzner remains in use for staging (`hcloud_server.dofek_staging`) and
  per-PR review app servers (`deploy/review-apps/`).

## Rollback

There is no automatic Terraform rollback path to the retired production
Hetzner server. If production must move again, provision or choose a replacement
host, restore the canonical Postgres data, update `ORACLE_SERVER_HOST` (or
rename the variable in a separate cleanup), and redeploy the production web
stack.
