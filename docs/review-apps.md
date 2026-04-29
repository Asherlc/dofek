# Review Apps

Dofek review apps create one isolated Hetzner server per pull request and expose
it at `pr-<number>.dofek.asherlc.com`.

## Architecture

- Shared front door: the existing production Traefik instance on
  `dofek.asherlc.com`.
- DNS: `*.dofek.asherlc.com` points at the shared front door as a DNS-only
  Cloudflare record so Traefik can serve the wildcard TLS certificate directly.
- Routing: the review-app deploy workflow writes one Traefik dynamic-config
  file for the PR's exact host, forwarding traffic to that PR server's `:3000`.
- Review stack: `web`, `db`, and `redis` via Docker Compose on the PR server.

Exact DNS records still win over the wildcard. Management hosts such as
`portainer.dofek.asherlc.com` and `pgadmin.dofek.asherlc.com` keep using their
existing explicit records and Traefik routes.

## Lifecycle

### Open, Reopen, Synchronize

For same-repo PRs that are ready for review, `.github/workflows/review-app.yml`
does the following:

1. Build `ghcr.io/asherlc/dofek:pr-<number>`.
2. Create the tagged HCP Terraform workspace `dofek-review-pr-<number>` if it
   does not exist yet.
3. Apply the Terraform workspace `dofek-review-pr-<number>`.
4. Write the exact PR host route on the shared front door.
5. Wait for Docker on the new Hetzner server.
6. Export review env vars from Infisical.
7. Start `db` and `redis`, run migrations, seed the preview DB with the
   deterministic reviewer dataset, then start `web`.
8. Wait for `https://pr-<number>.dofek.asherlc.com/healthz`.
9. Post the preview URL and `/auth/dev-login` helper link back onto the PR.

### Close

`.github/workflows/review-app-destroy.yml` removes the front door route file,
selects the matching Terraform workspace, and runs `terraform destroy`. That
removes:

- the review Hetzner server
- the review firewall
- the SSH key resource for that PR workspace
- the HCP Terraform workspace after destroy completes

## Reviewer Access

Review apps seed the database and enable `/auth/dev-login`, so reviewers can
use the preview without wiring provider OAuth callbacks to the PR domain.
The seed creates the `Review User` account with connected providers, recovery,
training, nutrition, body, labs, cycle, journal, breathwork, and provider sync
history so the main web and mobile screens are populated immediately.

Use:

- App shell: `https://pr-<number>.dofek.asherlc.com`
- Seeded login: `https://pr-<number>.dofek.asherlc.com/auth/dev-login`

## Operational Notes

- Review apps are skipped for fork PRs because package push and deploy secrets
  are not safe to expose to untrusted code.
- Review apps are skipped for draft PRs to avoid consuming scarce Hetzner server
  quota before human review is requested. Marking a draft PR ready for review
  starts the workflow.
- Review app port `3000` only accepts traffic from the shared front door IP.
- The shared front door must already have the wildcard DNS record and Traefik
  file provider enabled. Those changes live in the main `deploy/` Terraform and
  swarm stack, not in the PR workspace itself.

## Troubleshooting

### Hetzner Capacity Failures

If `Deploy Review App` fails while applying Terraform, first inspect the failed
job log:

```bash
gh run view <RUN_ID> --job <JOB_ID> --log-failed
```

Account quota exhaustion looks like this:

```text
Error: server limit reached (resource_limit_exceeded, ...)
  with hcloud_server.review,
  on server.tf line 27, in resource "hcloud_server" "review":
```

Placement capacity failure looks like this:

```text
Error: error during placement (resource_unavailable, ...)
  with hcloud_server.review,
  on server.tf line 27, in resource "hcloud_server" "review":
```

In both cases, the review app image built successfully, but Hetzner refused to
create the temporary review server. `resource_limit_exceeded` means the account
server quota is exhausted. `resource_unavailable` means Hetzner could not place
the configured review-app server type in the configured location at that time,
even if the account still has free server quota. These are not code failures in
the PR.

To resolve it:

1. Close or destroy stale review apps for old PRs so their Hetzner servers are
   removed.
2. For quota errors, raise the Hetzner server limit for the account if there are
   no stale review apps.
3. For placement errors, choose an available review-app location/server type or
   wait for Hetzner capacity to return.
4. Re-run the failed `Deploy Review App` job after capacity is available.

Do not change Terraform timeouts, add retries, or rerun repeatedly until the
capacity issue is fixed. The first fatal log line above is the root cause.

### Docker SSH Transport Failures

If `Deploy Review App` reaches `Deploy review stack` and fails with:

```text
Connection timed out during banner exchange
```

the server was provisioned, but Docker could not open its `ssh://` transport to
the new host. The bootstrap gate verifies normal SSH, Docker, Docker Compose,
and Docker's SSH transport before running `docker compose` so this fails during
readiness instead of after the deploy begins.
