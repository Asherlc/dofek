# Review Apps

PR review apps run on dedicated Hetzner servers and are reached through the
shared OCI production front door at `pr-<number>.dofek.asherlc.com`.

## How It Works

- Terraform workspace: one workspace per PR, named
  `dofek-review-pr-<number>` and tagged `review-app`.
- Review app server: one Hetzner `cax11` server per PR.
- App stack: `web`, `db`, and `redis` via Docker Compose on the review server.
- Routing: the deploy workflow writes a Traefik dynamic-config file onto the
  OCI front door host so only that PR hostname is forwarded to the PR server.
- DNS: the wildcard `*.dofek.asherlc.com` points at the shared front door as a
  DNS-only Cloudflare record so Traefik can serve TLS directly. Exact records
  like `portainer.dofek.asherlc.com` still take precedence.
- Workspace bootstrap: the GitHub workflow creates the tagged HCP Terraform
  workspace before `terraform init` so non-interactive CI never blocks on the
  first PR.

## Lifecycle

- `review-app.yml` handles PR `opened`, `synchronize`, and `reopened`.
- `review-app-destroy.yml` handles PR `closed`.
- The deploy workflow:
  - builds `ghcr.io/asherlc/dofek:pr-<number>`
  - applies the PR Terraform workspace
  - writes the exact PR host route on the OCI front door
  - exports review env vars from Infisical
  - resets Docker Compose services and volumes so each deploy starts from a
    clean seeded database
  - runs migrations and the deterministic comprehensive seed script
  - copies seeded activity dependencies into ClickHouse and builds analytics
    read models so activity pages show recent review data
  - starts the review stack
- The destroy workflow tears down the PR workspace, which removes the server and
  the front door route file, then deletes the HCP Terraform workspace itself.

## Reviewer Login

- Review apps enable `/auth/dev-login`.
- The seed step creates the `dev-session` and a comprehensive `Review User`
  dataset so reviewers can inspect dashboard, recovery, training, nutrition,
  body, provider, report, cycle, journal, and breathwork surfaces without
  provider OAuth setup.
- Review deploys also snapshot seeded activity/profile/provider-priority rows
  into ClickHouse and run the analytics build, so activity summary screens are
  populated without PeerDB CDC.

## Guardrails

- Review app port `3000` only accepts traffic from the shared front door IP.
- Exact management hosts are not matched by review routers because each route is
  a concrete `Host(pr-<number>.dofek.asherlc.com)` rule.
- Review apps are only created for same-repo PRs. Fork PRs do not receive
  review apps because the required package and secret permissions are not safe
  to grant to untrusted code.
