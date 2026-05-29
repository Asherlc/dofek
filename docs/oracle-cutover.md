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

Today, production domains (`dofek.asherlc.com`, `dofek.fit`, `dofek.live`) point
at Hetzner via `deploy/dns.tf`, and the `web` Traefik router claims those hosts.
Oracle runs on `dofek-oracle.asherlc.com` as a parallel validation deploy.

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

In `deploy/dns.tf`, the production A records currently use
`hcloud_server.dofek.ipv4_address`. Point them at the Oracle reserved IP
(`var.oracle_server_host`) instead — `dofek.fit`, `www.dofek.fit`,
`dofek.live`, `www.dofek.live`, `dofek.asherlc.com`, and the `*.dofek.asherlc.com`
wildcard. Once the production domains live on Oracle, the separate
`dofek-oracle.asherlc.com` record can be removed.

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
   ```

4. Confirm the dashboard renders and a manual sync lands new data on Oracle.

## Step 4 — Stop deploying to Hetzner

Once Oracle is serving production:

1. Remove the Hetzner `web-stack` job from `deploy/deploy.yml` (or gate it off),
   leaving only the Oracle deploy. Rename `web-stack-oracle` → `web-stack` and
   drop the now-redundant OCI-specific naming once it is the only web deploy.
2. Remove the `dofek-oracle.asherlc.com` record and `var.oracle_server_host`
   indirection if you fold the Oracle IP into the main records directly, or keep
   `oracle_server_host` as the canonical production IP variable.

## Rollback

Until Hetzner is decommissioned, rollback is a DNS revert:

1. Revert the `deploy/dns.tf` change (production records back to
   `hcloud_server.dofek.ipv4_address`) and revert the Oracle job's
   `public_url` / `web_host_rule`.
2. Re-run the deploy. Hetzner still has its data and stack, so it resumes
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
