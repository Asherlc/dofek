# Final switchover: Hetzner → Oracle Cloud

This runbook covers the **production cutover** — making the Oracle Cloud host
the canonical production server and retiring Hetzner. It assumes the Oracle host
is already provisioned and has been validated on its parallel domain
(`dofek-oracle.asherlc.com`).

Two related documents:

- [`deploy/oracle-free/README.md`](../deploy/oracle-free/README.md) — how the
  Oracle host is provisioned (Terraform, reserved IP, SSH keys, deploy wiring).
- [`oracle-migration.md`](./oracle-migration.md) — how to copy the database and
  object storage from Hetzner to Oracle. **Do the data migration first**; this
  document picks up once Oracle holds the real data.

The cutover is a config/DNS change only — no new infrastructure. It is
reversible until Hetzner is decommissioned (final section).

## Prerequisites (go / no-go)

Do not start until all of these hold:

- [ ] Oracle host has run the full stack cleanly on `dofek-oracle.asherlc.com`
      for long enough to trust it (web `2/2`, `db`, `clickhouse`, `redis`,
      `peerdb`, `collector` all healthy; CDC configured).
- [ ] The database and object storage have been migrated per
      [`oracle-migration.md`](./oracle-migration.md) and verified (row counts,
      a manual sync landing new data, dashboard renders).
- [ ] Hetzner's disk-pressure incident is resolved or irrelevant (the Oracle
      data volume is 150 GB; confirm it has headroom for the restored data).
- [ ] The Oracle reserved IP is stable and stored in the `ORACLE_SERVER_HOST`
      GitHub Actions variable.
- [ ] A recent, verified Hetzner backup exists (for rollback).

## Overview of the switch

Today, Oracle is already wired into the main IaC path:

- `deploy/oracle-free/` provisions the OCI host and reserved public IP.
- The reserved IP is stored in the `ORACLE_SERVER_HOST` GitHub Actions variable.
- `.github/workflows/deploy.yml` deploys the same image to both `web-stack`
  (Hetzner) and `web-stack-oracle` (OCI).
- The OCI job passes `server_host: ${{ vars.ORACLE_SERVER_HOST }}`,
  `ssh_user: ubuntu`, `stack_override: deploy/stack.oracle.yml`, and a
  validation-only host rule for `dofek-oracle.asherlc.com`.
- `deploy/variables.tf` exposes `var.oracle_server_host`, and `deploy/dns.tf`
  defines `local.dofek_primary_host = var.oracle_server_host != "" ?
  var.oracle_server_host : hcloud_server.dofek.ipv4_address`.

The current DNS IaC is partially cut over:

- `dofek.asherlc.com` points at `local.dofek_primary_host`.
- `*.dofek.asherlc.com` is a DNS-only CNAME to `dofek.asherlc.com`, so
  `dofek-oracle.asherlc.com` resolves through that wildcard rather than through
  a dedicated Terraform resource.
- `dofek.fit` points at `local.dofek_primary_host`; `www.dofek.fit` is a CNAME
  to `dofek.fit`.
- `dofek.live` still points directly at `hcloud_server.dofek.ipv4_address`;
  `www.dofek.live` is a CNAME to `dofek.live`.

The cutover repoints the production domains at Oracle and makes the Oracle
deploy serve them, then stops deploying to Hetzner.

## Step 1 — Make Oracle the deploy that serves the production domains

In `.github/workflows/deploy.yml`, the `web-stack-oracle` job currently passes
the validation domain:

```yaml
public_url: https://dofek-oracle.asherlc.com
web_host_rule: "Host(`dofek-oracle.asherlc.com`)"
```

Change it to claim the production hosts (mirror the defaults the Hetzner
`web-stack` job relies on in `stack.yml`):

```yaml
public_url: https://dofek.asherlc.com
web_host_rule: "Host(`dofek.asherlc.com`) || Host(`dofek.fit`) || Host(`www.dofek.fit`) || Host(`dofek.live`) || Host(`www.dofek.live`)"
```

Do **not** deploy this yet — it must land together with the DNS flip (Step 3),
or Cloudflare will route the production hostnames to a host whose Traefik does
not yet answer for them.

## Step 2 — Repoint DNS in Terraform

In `deploy/dns.tf`, use `local.dofek_primary_host` for every production root
record that should follow `ORACLE_SERVER_HOST`:

- `cloudflare_dns_record.dofek_fit_root` already uses `local.dofek_primary_host`.
- `cloudflare_dns_record.dofek_asherlc` already uses `local.dofek_primary_host`.
- Change `cloudflare_dns_record.dofek_live_root` from
  `hcloud_server.dofek.ipv4_address` to `local.dofek_primary_host`.

Keep the CNAME records as CNAMEs:

- `www.dofek.fit` should continue to point at `dofek.fit`.
- `www.dofek.live` should continue to point at `dofek.live`.
- `*.dofek.asherlc.com` should continue to point at `dofek.asherlc.com` unless
  the review-app routing model changes separately.

Do not add a duplicate `dofek-oracle.asherlc.com` Terraform record in this
cutover. Under the current IaC, that hostname is covered by the wildcard CNAME.

Keep TLS working: the production records are proxied (orange-cloud) exactly as
today, so no Traefik/cert change is needed — the Oracle Traefik already issues
Let's Encrypt certs for whatever hosts its router claims (verified during
validation).

## Step 3 — Execute the flip

1. Merge Steps 1–2 to `main`.
2. Run the `Deploy Web Stack (OCI)` path (the `Build + Deploy` workflow,
   target `web`) so Oracle deploys with the production host rule **and**
   Terraform applies the new DNS records in the same release.
3. Watch Cloudflare propagation (seconds to a couple of minutes) and confirm:

   ```bash
   curl -sS -o /dev/null -w "%{http_code}\n" https://dofek.asherlc.com/healthz
   curl -sS -o /dev/null -w "%{http_code}\n" https://dofek.fit/
   curl -sS -o /dev/null -w "%{http_code}\n" https://dofek.live/
   ```

4. Confirm the dashboard renders and a manual sync lands new data on Oracle.

## Step 4 — Stop deploying to Hetzner

Once Oracle is serving production:

1. Remove the Hetzner `web-stack` job from `.github/workflows/deploy.yml` (or gate it off),
   leaving only the Oracle deploy. Rename `web-stack-oracle` → `web-stack` and
   drop the now-redundant OCI-specific naming once it is the only web deploy.
2. Decide whether `var.oracle_server_host` remains the canonical production IP
   input. If it does, keep `local.dofek_primary_host`; if not, fold the Oracle
   IP directly into the production DNS records and remove the indirection.
3. Keep the wildcard `*.dofek.asherlc.com` only if review apps still need the
   shared front door. Do not remove it as part of the Oracle cleanup unless the
   review-app routing model has changed.

## Rollback

Until Hetzner is decommissioned, rollback is a DNS revert:

1. Revert `cloudflare_dns_record.dofek_live_root` back to
   `hcloud_server.dofek.ipv4_address`.
2. If the rollback also needs `dofek.fit` and `dofek.asherlc.com` to leave
   Oracle, either unset `ORACLE_SERVER_HOST` for the Terraform apply or change
   those records back to `hcloud_server.dofek.ipv4_address`.
3. Revert the Oracle job's production `public_url` / `web_host_rule` back to
   the validation domain:

   ```yaml
   public_url: https://dofek-oracle.asherlc.com
   web_host_rule: "Host(`dofek-oracle.asherlc.com`)"
   ```

4. Re-run the deploy. Hetzner still has its data and stack, so it resumes
   serving within DNS propagation time.

Because Oracle has been taking live writes since the flip, a rollback to
Hetzner means Hetzner is now behind. Either re-sync Hetzner from Oracle before
rolling back, or accept the gap. Prefer fixing forward on Oracle unless it is
unrecoverable.

## Step 5 — Decommission Hetzner

Only after Oracle has run cleanly as production long enough to trust it (and you
no longer need the rollback path):

1. Take a final Hetzner database dump and archive it to R2.
2. Scale down the Hetzner stack and destroy the Hetzner server + volume in
   Terraform (`hcloud_server.dofek`, `hcloud_volume.dofek_data`, the staging
   resources if also retiring staging).
3. Remove the Hetzner-specific Terraform, secrets (`SERVER_HOST`,
   `HCLOUD_TOKEN`), and any remaining `web-stack` (Hetzner) wiring.
4. Update [`deploy/README.md`](../deploy/README.md) and
   [`deploy/AGENTS.md`](../deploy/AGENTS.md) so they describe Oracle as the sole
   production host.
