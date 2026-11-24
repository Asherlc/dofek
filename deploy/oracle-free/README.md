# Oracle Cloud Ampere A1 — Terraform root

Provisions a single-node Docker Swarm host for Dofek on Oracle Cloud
Infrastructure (OCI) using the Ampere A1 flexible shape. The checked-in defaults
request 4 OCPUs and 24 GB RAM; they are deployment configuration, not a promise
that the tenancy will incur no charges. Check the tenancy's current limits,
usage, and payment model before applying. Oracle publishes the current free
allowances and payment-model caveats in
[Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

This is the production host topology for the main `deploy/docker-compose.yml` stack.

This root uses the `oracle/oci` provider and the native OCI backend. Its state
is stored at `host/terraform.tfstate` in the private, versioned
`dofek-terraform-state` bucket. The backend locks state during Terraform
operations. The primary `deploy/` root manages Cloudflare resources in a
separate backend. See [OCI access and state storage](../oci-bootstrap/README.md)
and the [Terraform OCI backend reference](https://developer.hashicorp.com/terraform/language/backend/oci).

## What it provisions

- VCN, public subnet, internet gateway, route table, security list (22/80/443)
- A `VM.Standard.A1.Flex` instance at 4 OCPU / 24 GB on ARM64 Ubuntu 24.04
- A 50 GB boot volume plus a 150 GB data volume mounted at
  `/mnt/dofek-data`. Oracle currently documents a 200 GB combined Always Free
  boot/block-volume allowance in the tenancy's home region; verify eligibility
  before relying on it.
- cloud-init that installs Docker CE, opens the host firewall for 80/443
  (required on OCI — the image ships restrictive iptables), formats/mounts the
  data volume, and initializes a single-node swarm

## Usage

Start with a plan on `main` and inspect the workflow result. An explicit
`apply` dispatch runs a fresh plan and applies that saved plan on the runner.
The workflow retrieves its inputs and signing key from Infisical using its
GitHub OIDC identity. See [GitHub workflow dispatch](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

```bash
gh workflow run oci-terraform.yml --ref main -f operation=plan
gh run list --workflow oci-terraform.yml --limit 1
```

The workflow identity can read the OCI host resources and update existing
security lists. Other OCI changes require an authorized administrator. Use the
[OCI bootstrap runbook](../oci-bootstrap/README.md) for access maintenance and
state recovery.

The public IP is printed as an output; copy it into the `ORACLE_SERVER_HOST`
GitHub Actions variable so Cloudflare DNS and production deploys target this
host. All deploy logic lives in CI and talks to the remote Docker API over SSH
(never a local `docker stack deploy`). The [Deploy workflow](../../.github/workflows/deploy.yml)
(`deploy.yml`, target `web`) runs the production `Deploy Web Stack` job,
which applies the Oracle override (`-c deploy/docker-compose.yml -c deploy/stack.oracle.yml`)
over SSH to this host. See the "Stable address + DNS + CI" section below.

OCI's Ubuntu image disables root SSH, so the remote Docker context connects as
the `ubuntu` user. cloud-init adds `ubuntu` to the `docker` group so it can
reach the daemon socket without sudo. When invoking the `Deploy Web Stack`
workflow against this host, pass `ssh_user: ubuntu` (the production deploy
default is also `ubuntu`).

The instance trusts two SSH keys: the personal 1Password key for manual access
and the CI deploy key (pair of the `DEPLOY_SSH_KEY` GitHub secret) so GitHub
Actions can deploy. Set both via the multiline `ssh_public_key` tfvar.

### Stable address + DNS + CI

The instance uses a **reserved public IP** (`oci_core_public_ip`, see
`reserved-ip.tf`) so the address survives instance recreates. After
`terraform apply`, copy the `public_ip` output into the `ORACLE_SERVER_HOST`
GitHub Actions **variable** (a repo variable, not a secret — it is a public
address, and secrets are scrubbed from job outputs and can't be used in a
reusable-workflow `with:`). The primary `deploy/` root reads it as
`TF_VAR_oracle_server_host` for production DNS records, and production deploys
pass it as `server_host` with `ssh_user: ubuntu` and
`stack_override: deploy/stack.oracle.yml`.

`deploy/stack.oracle.yml` disables the operator/admin UIs that perform no
background work (pgAdmin, CloudBeaver, Portainer, Netdata, and PeerDB UI).
Databasus remains enabled because it owns the production PostgreSQL backup
schedule. Follow the
[database backup recovery runbook](../../docs/database-backup-recovery-runbook.md)
for freshness and isolated restore verification.

The historical Hetzner-to-Oracle migration notes live in
[`docs/oracle-migration.md`](../../docs/oracle-migration.md).

## "Out of host capacity"

If `apply` fails with `Out of host capacity`, Oracle recommends changing the
shape or availability/fault domain, omitting a fixed fault domain, or retrying
after capacity changes. See
[Resolving Out of Host Capacity](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/troubleshooting-out-of-host-capacity.htm).

- Check which availability-domain indexes exist in the selected region.
- Set `availability_domain_index` to another valid index and review a new plan.
- If the region exposes only one availability domain, wait and retry or choose
  another supported shape deliberately.
- Do not assume an account upgrade guarantees capacity or zero cost.

## Storage layout

The defaults split 200 GB into a 50 GB boot volume and 150 GB data volume.
Oracle documents that boot and block volumes share the current Always Free
allowance, but eligibility depends on tenancy and home region; review the
Terraform plan and OCI usage before applying. The historical boot-only option
`data_volume_size_gb = 0` skips the volume mount. This is incompatible with the
Kafka stack: bootstrap and deployment require `/mnt/dofek-data` to be a mounted
data filesystem before creating Kafka's UID/GID 1000 data directory. The
[checked-in bootstrap](cloud-init.yml) and
[deployment preflight](../../.github/workflows/deploy-web-stack.yml) enforce this
boundary. The cloud-init template supplies launch-time `user_data`. Terraform
preserves the running VM's launch metadata and prevents accidental replacement.
The normal application release applies the separate Cloudflare root. See the
[release workflow](../../.github/workflows/deploy-web-environment.yml).
