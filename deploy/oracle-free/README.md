# Oracle Cloud Ampere A1 — Terraform root

Provisions a single-node Docker Swarm host for Dofek on Oracle Cloud
Infrastructure (OCI) using the Ampere A1 flexible shape. The checked-in defaults
request 4 OCPUs and 24 GB RAM; they are deployment configuration, not a promise
that the tenancy will incur no charges. Check the tenancy's current limits,
usage, and payment model before applying. Oracle publishes the current free
allowances and payment-model caveats in
[Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

This is the production host topology for the main `deploy/stack.yml` stack.

This root is **isolated** from the primary `deploy/` root: it uses a local
backend and the `oracle/oci` provider. The primary `deploy/` root manages
Cloudflare resources.

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

## One-time manual bootstrap

Terraform needs credentials before it can run, so these steps are unavoidable
and done once:

1. Create or select the OCI tenancy and confirm its home region, payment model,
   service limits, quotas, and expected cost.
2. Generate an API signing key and register it on your user:
   `oci setup keys`, then add the public key in Console → Profile → API Keys.
3. Collect the OCIDs: `tenancy_ocid`, `user_ocid`, `compartment_ocid`, your
   `region`, and the key `fingerprint`.

## Usage

```bash
cd deploy/oracle-free
cp terraform.tfvars.example terraform.tfvars   # fill in OCIDs + SSH key
terraform init
terraform plan
terraform apply
```

The public IP is printed as an output; copy it into the `ORACLE_SERVER_HOST`
GitHub Actions variable so Cloudflare DNS and production deploys target this
host. All deploy logic lives in CI and talks to the remote Docker API over SSH
(never a local `docker stack deploy`). The `Build + Deploy` workflow
(`build-deploy.yml`, target `web`) runs the production `Deploy Web Stack` job,
which applies the Oracle override (`-c deploy/stack.yml -c deploy/stack.oracle.yml`)
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
Terraform plan and OCI usage before applying. To keep everything on the boot
disk instead, set
`data_volume_size_gb = 0`; cloud-init then skips the volume mount and
`/mnt/dofek-data` is just a directory on the boot volume.
