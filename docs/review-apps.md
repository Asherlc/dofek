# Review Apps

Dofek review apps create one isolated Hetzner server per pull request and expose
it at `pr-<number>.dofek.asherlc.com`.

## Architecture

- Shared front door: the production Traefik instance on the OCI host addressed
  by `ORACLE_SERVER_HOST`, serving `dofek.asherlc.com`.
- DNS: `*.dofek.asherlc.com` points at the shared front door as a DNS-only
  Cloudflare record so Traefik can serve the wildcard TLS certificate directly.
- Routing: the review-app deploy workflow writes one Traefik dynamic-config
  file for the PR's exact host, forwarding traffic to that PR server's `:3000`.
- Review stack: `web`, `db`, `clickhouse`, and `redis` via Docker Compose on
  the PR server.

Exact DNS records still win over the wildcard. Management hosts such as
`portainer.dofek.asherlc.com` and `pgadmin.dofek.asherlc.com` keep using their
existing explicit records and Traefik routes.

## Lifecycle

### Open, Reopen, Synchronize

Review app creation is currently disabled. When `.github/workflows/review-app.yml`
is re-enabled for same-repo PRs that are ready for review, it does the following:

1. Build `ghcr.io/asherlc/dofek:pr-<number>`.
2. Create the tagged HCP Terraform workspace `dofek-review-pr-<number>` if it
   does not exist yet.
3. Apply the Terraform workspace `dofek-review-pr-<number>`.
4. Write the exact PR host route on the OCI shared front door.
5. Wait for Docker on the new Hetzner server.
6. Export review env vars from Infisical.
7. Reset Docker Compose services and volumes, start `db`, `clickhouse`, and
   `redis`, run migrations, seed the preview DB with the deterministic reviewer
   dataset, copy the seeded activity dependencies into ClickHouse, build the
   analytics read models, then start `web`.
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
The deploy also snapshots the seeded activity/profile/provider-priority rows
into ClickHouse and runs the analytics build so activity pages have recent
deduped activity summaries instead of waiting for PeerDB CDC.

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
  file provider enabled. DNS lives in the main `deploy/` Terraform root; the
  Traefik file provider is part of the production OCI swarm stack, not the PR
  workspace itself.
- The review database uses the TimescaleDB HA image's default PostgreSQL data
  parent (`/home/postgres/pgdata`). Do not mount the disposable Docker volume
  directly on `PGDATA`; the image must be able to create and own the nested
  `data` directory during first initialization.

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

If the same step fails after a long migration or seed run with:

```text
error waiting for container: command [ssh ... docker system dial-stdio] has exited with exit status 255
client_loop: send disconnect: Broken pipe
Process completed with exit code 125
```

the one-shot container may have finished successfully while the CI-side Docker
SSH transport lost its long-lived attached wait. The review-app workflow should
start migration and seed containers detached, poll container state with short
Docker API calls, and print container logs only when the one-shot exits
non-zero.

### Review Server Disk Exhaustion

If `Deploy Review App` reaches `Deploy review stack` and fails while pulling or
extracting images with:

```text
no space left on device
```

the PR review server's root disk ran out of Docker storage before the app image
could be extracted. The deploy workflow prunes stopped containers, unused
images, and build cache before image pulls, then fails loudly if less than
8 GiB is still free. If the check still fails after cleanup, destroy the stale
review app or move review apps to a larger server type.
