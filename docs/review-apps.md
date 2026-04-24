# Review Apps

Dofek review apps create one isolated Hetzner server per pull request and expose
it at `pr-<number>.dofek.asherlc.com`.

## Architecture

- Shared front door: the existing production Traefik instance on
  `dofek.asherlc.com`.
- DNS: `*.dofek.asherlc.com` points at the shared front door.
- Routing: each PR Terraform workspace writes one Traefik dynamic-config file
  for its exact host, forwarding traffic to that PR server's `:3000`.
- Review stack: `web`, `db`, and `redis` via Docker Compose on the PR server.

Exact DNS records still win over the wildcard. Management hosts such as
`portainer.dofek.asherlc.com` and `pgadmin.dofek.asherlc.com` keep using their
existing explicit records and Traefik routes.

## Lifecycle

### Open, Reopen, Synchronize

`.github/workflows/review-app.yml` does the following for same-repo PRs:

1. Build `ghcr.io/asherlc/dofek:pr-<number>`.
2. Apply the Terraform workspace `dofek-review-pr-<number>`.
3. Wait for Docker on the new Hetzner server.
4. Export review env vars from Infisical.
5. Start `db` and `redis`, run migrations, seed the preview DB, then start
   `web`.
6. Wait for `https://pr-<number>.dofek.asherlc.com/healthz`.
7. Post the preview URL and `/auth/dev-login` helper link back onto the PR.

### Close

`.github/workflows/review-app-destroy.yml` selects the matching Terraform
workspace and runs `terraform destroy`. That removes:

- the review Hetzner server
- the review firewall
- the SSH key resource for that PR workspace
- the Traefik dynamic route file on the shared front door

## Reviewer Access

Review apps seed the database and enable `/auth/dev-login`, so reviewers can
use the preview without wiring provider OAuth callbacks to the PR domain.

Use:

- App shell: `https://pr-<number>.dofek.asherlc.com`
- Seeded login: `https://pr-<number>.dofek.asherlc.com/auth/dev-login`

## Operational Notes

- Review apps are skipped for fork PRs because package push and deploy secrets
  are not safe to expose to untrusted code.
- Review app port `3000` only accepts traffic from the shared front door IP.
- The shared front door must already have the wildcard DNS record and Traefik
  file provider enabled. Those changes live in the main `deploy/` Terraform and
  swarm stack, not in the PR workspace itself.
