# Oracle Cloud Always Free — Terraform root

Provisions a single-node Docker Swarm host for Dofek on Oracle Cloud
Infrastructure (OCI) using the **Always Free** Ampere A1 shape
(4 OCPU / 24 GB RAM, $0). This mirrors the Hetzner production topology
(`deploy/server.tf` + `deploy/server/cloud-init.yml`) so the production
`deploy/stack.yml` can be deployed onto it with minimal changes.

This root is **isolated** from the primary `deploy/` root: it uses a local
backend and the `oracle/oci` provider, and does not touch the live Hetzner
infrastructure.

## What it provisions

- VCN, public subnet, internet gateway, route table, security list (22/80/443)
- A `VM.Standard.A1.Flex` instance at 4 OCPU / 24 GB on ARM64 Ubuntu 24.04
- A 50 GB boot volume + a 150 GB data volume mounted at `/mnt/dofek-data`
  (within the 200 GB Always Free block-storage pool)
- cloud-init that installs Docker CE, opens the host firewall for 80/443
  (required on OCI — the image ships restrictive iptables), formats/mounts the
  data volume, and initializes a single-node swarm

## One-time manual bootstrap

Terraform needs credentials before it can run, so these steps are unavoidable
and done once:

1. Sign up for Oracle Cloud and **upgrade to Pay As You Go** (stays $0 within
   Always Free limits, but gives A1 capacity priority — see below).
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

The public IP is printed as an output; point Cloudflare DNS / Traefik host
rules at it, then deploy the stack from CI via a remote Docker context exactly
as with Hetzner, applying the Oracle override on top of the base stack:

```bash
docker stack deploy -c deploy/stack.yml -c deploy/stack.oracle.yml dofek
```

Unlike Hetzner (which deploys over `ssh://root@`), OCI's Ubuntu image disables
root SSH, so the remote Docker context connects as the `ubuntu` user. cloud-init
adds `ubuntu` to the `docker` group so it can reach the daemon socket without
sudo. When invoking the `Deploy Web Stack` workflow against this host, pass
`ssh_user: ubuntu` (the input defaults to `root` for Hetzner).

The instance trusts two SSH keys (mirroring Hetzner): the personal 1Password key
for manual access and the CI deploy key (pair of the `DEPLOY_SSH_KEY` GitHub
secret) so GitHub Actions can deploy. Set both via the multiline `ssh_public_key`
tfvar.

### Stable address + DNS + CI

The instance uses a **reserved public IP** (`oci_core_public_ip`, see
`reserved-ip.tf`) so the address survives instance recreates. After
`terraform apply`, copy the `public_ip` output into the `ORACLE_SERVER_HOST`
GitHub Actions **variable** (a repo variable, not a secret — it is a public
address, and secrets are scrubbed from job outputs and can't be used in a
reusable-workflow `with:`). The primary `deploy/` root reads it as
`TF_VAR_oracle_server_host` to publish `dofek-oracle.asherlc.com` (in `dns.tf`),
and `deploy.yml` passes it as `server_host` to a second `Deploy Web Stack (OCI)`
job that runs alongside the Hetzner deploy with `ssh_user: ubuntu`,
`stack_override: deploy/stack.oracle.yml`, and the `dofek-oracle.asherlc.com`
host rule. This keeps OCI on its own validation domain while sharing the prod
image and Infisical secrets.

`deploy/stack.oracle.yml` disables the operator/admin UIs (pgAdmin,
CloudBeaver, Databasus, Portainer, Netdata, PeerDB UI, Authentik proxy) that a
single-user free-tier deployment does not need. The 24 GB node has ample room
for the core app + PeerDB CDC + ClickHouse + Postgres, so unlike staging it
does not tighten CPU.

To move an existing Hetzner deployment's data onto this host, follow
[`docs/oracle-migration.md`](../../docs/oracle-migration.md).

## "Out of host capacity"

Always Free A1 capacity is scarce. If `apply` fails with
`Out of host capacity`:

- Re-run `terraform apply` (capacity frees up intermittently).
- Try another availability domain: set `availability_domain_index` to `1` or
  `2` and re-apply.
- Upgrade the account to **Pay As You Go** — it stays free within Always Free
  limits but moves you into the priority capacity pool, which is the most
  reliable fix. PAYG accounts are also exempt from idle-instance reclamation.

## Storage layout

The 200 GB Always Free block pool is split as 50 GB boot + 150 GB data by
default. To keep everything on the boot disk instead, set
`data_volume_size_gb = 0`; cloud-init then skips the volume mount and
`/mnt/dofek-data` is just a directory on the boot volume.
