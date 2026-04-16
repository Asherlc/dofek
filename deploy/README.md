# Deployment

Production runs on a single Hetzner Cloud CAX11 (ARM) server at `dofek.asherlc.com`. Infrastructure is provisioned with Terraform (HCP Terraform backend, organization `dofek`, workspace `dofek`). The application stack runs as a single Docker Compose project on the server, with [docker-rollout](https://github.com/Wowu/docker-rollout) for zero-downtime updates and Traefik for TLS + reverse proxy.

## Layout

```
deploy/
├── README.md                           # this file
├── AGENTS.md                           # agent guidelines (CLAUDE.md is a symlink)
├── main.tf                             # Terraform settings (HCP Terraform cloud block, providers)
├── variables.tf                        # input variables
├── outputs.tf                          # outputs (server IP, etc.)
├── server.tf                           # Hetzner server, firewall, SSH key, deploy_compose resource
├── storage.tf                          # Hetzner volume(s) for persistent data
├── dns.tf                              # Cloudflare DNS records
├── imports.tf                          # `terraform import` blocks for resources brought into state
├── docker-compose.deploy.yml           # full production stack (web, worker, db, redis, traefik, etc.)
├── otel-collector-config.yaml          # OTel Collector config (logs/traces → Axiom, metrics → Axiom)
├── server/
│   ├── cloud-init.yml                  # server bootstrap (Docker CE, docker-rollout, Infisical CLI)
│   └── run-compose-with-infisical.sh   # helper that exports Infisical secrets and runs compose/rollout
├── cloudflare/                         # separate Terraform module for Cloudflare R2 + Storybook DNS
└── terraform.tfvars.example            # template for local var overrides
```

## Production architecture

```
Internet → Traefik (auto-HTTPS :443, serves dofek.asherlc.com + dofek.fit + dofek.live)
             └── dofek-web (Express :3000)
                   ├── /assets/*    → static files (1yr immutable cache)
                   ├── /api/*       → tRPC + REST API
                   ├── /auth/*      → OAuth flows
                   ├── /callback    → OAuth callback
                   ├── /admin/*     → BullMQ dashboard
                   ├── /metrics     → Prometheus metrics
                   └── /*           → index.html (SPA fallback)
```

## Services

All services run in a single Docker Compose stack (`docker-compose.deploy.yml`):

| Service | Image | Purpose |
|---------|-------|---------|
| `traefik` | traefik:3.4 | Reverse proxy, auto-HTTPS via Cloudflare DNS challenge |
| `web` | ghcr.io/asherlc/dofek | Express + tRPC API + static file serving (port 3000) |
| `worker` | ghcr.io/asherlc/dofek | BullMQ job worker (processes sync jobs, file imports) |
| `training-export-worker` | ghcr.io/asherlc/dofek-ml | ML/training export worker (separate image) |
| `db` | timescale/timescaledb:2.26.2-pg18 | TimescaleDB (persistent volume) |
| `redis` | redis:7-alpine | Job queue backend for BullMQ + OTA cache |
| `ota` | ghcr.io/axelmarciano/expo-open-ota | Self-hosted Expo OTA server (ota.dofek.asherlc.com) |
| `collector` | otel/opentelemetry-collector-contrib | OTel Collector — logs/traces → Axiom |
| `databasus` | databasus/databasus | DB backups to Cloudflare R2 (databasus.dofek.asherlc.com) |
| `pgadmin` | dpage/pgadmin4 | PostgreSQL management UI (pgadmin.dofek.asherlc.com) |
| `portainer` | portainer/portainer-ce | Docker management UI (portainer.dofek.asherlc.com) |
| `netdata` | netdata/netdata | Server health monitoring (netdata.dofek.asherlc.com) |

> **Post-deploy setup required for backups:** After the first `docker compose up`, open `databasus.dofek.asherlc.com` and configure the PostgreSQL connection (host: `db`, database: `health`, user: `health`) and the R2 storage destination (`dofek-db-backups` bucket, credentials from Infisical). Backups will not run until this is done.

Portainer, Netdata, Databasus, and pgAdmin are behind Authentik forward auth.

## CI/CD pipeline

```
git push → GHA builds ARM Docker images + exports Expo OTA bundle → signs manifest → uploads to R2
→ Docker image pushed to GHCR (sha-tagged) → CI SSHs to server → docker rollout (zero-downtime)
```

Deploy automation runs through reusable GitHub workflows (`.github/workflows/deploy-*.yml`):

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `deploy-terraform.yml` | push to `main` touching `deploy/**`, manual dispatch | `terraform init && apply` against HCP Terraform |
| `deploy-app.yml` | called by `deploy.yml` / `deploy-web.yml` | SSH to server, pull `dofek` image, rollout `web` and `worker` |
| `deploy-ml.yml` | called by `deploy.yml` / `deploy-web.yml` | SSH to server, pull `dofek-ml` image, recreate `training-export-worker` |
| `deploy-web.yml` | `workflow_run` on CI success, manual dispatch | Auto-deploy after CI green: calls `deploy-app.yml` + `deploy-ml.yml` |
| `deploy.yml` | manual dispatch only | One-shot deploy across `infra` / `app` / `ml` / `ios` / `ota` / `all` |
| `deploy-ios.yml` | called by `deploy.yml`, manual dispatch | iOS build + TestFlight |
| `deploy-ota.yml` | called by `deploy.yml`, manual dispatch | Expo OTA bundle export → signed → uploaded to R2 |

Migrations run at two levels for reliability: a dedicated one-shot `migrate` container runs first during `docker compose up` (via `depends_on: { condition: service_completed_successfully }`), and each service's entrypoint also runs migrations before starting. A Postgres advisory lock serializes concurrent runs so only one container applies migrations at a time. With replicated `web` instances and rolling restarts, at least one healthy API instance remains available while another instance migrates and boots. In local dev, run `pnpm migrate` manually.

## Deploying from scratch

1. Set required Terraform variables — see "Production secrets" below for sources:
   - `TF_VAR_hcloud_token`
   - `TF_VAR_ssh_public_key`
   - `TF_VAR_ssh_private_key`
   - `TF_VAR_cloudflare_api_token`
   - `TF_VAR_cloudflare_account_id`
   - `TF_VAR_infisical_token`
2. Provision infra + compose stack: `cd deploy && terraform init && terraform apply`
3. Deploy the app image: `gh workflow run deploy-web.yml -f image_tag=latest`

## Updating server config

**Never SSH into the server to edit config files directly.** All changes go through the deploy compose file (committed to git) or Terraform. SSH is allowed for **debugging** only — the fix must be a code/infrastructure change that handles the failure automatically.

## Validating infrastructure changes locally

CLAUDE.md requires that any change to `deploy/*.tf`, `deploy/server/cloud-init.yml`, `deploy/docker-compose.deploy.yml`, or `deploy/otel-collector-config.yaml` is verified locally with `terraform plan` and `terraform apply` (using Infisical-supplied secrets) **before** opening a PR. CI running `terraform apply` is not a substitute for local validation — when CI fails after merge, production is in an unknown state and the next deploy can stack new failures on top of old ones.

```bash
cd deploy
TOKEN=$(op signin --account my.1password.com --raw)
export TF_VAR_hcloud_token=$(OP_SESSION_my_1password_com="$TOKEN" \
  op item get "Hetzner Cloud API Token" --field password)
export TF_VAR_infisical_token=$(OP_SESSION_my_1password_com="$TOKEN" \
  op item get "Infisical Machine Identity Token" --field password)
# ... export the rest from Infisical / 1Password ...
terraform init
terraform plan
terraform apply
```

## Production secrets

**All secrets are managed in [Infisical](https://infisical.com/).** Infisical is the single source of truth for credentials — if a secret isn't in Infisical, it's untracked.

Production containers receive environment variables from two places:

1. **Committed `.env` (repo root)** — non-secret config: client IDs, redirect URIs, endpoints, DSNs. Baked into the Docker image. Loaded by the entrypoint on startup.
2. **Infisical export at deploy time** — deploy workflows and Terraform call `deploy/server/run-compose-with-infisical.sh`, which exports secrets to a short-lived temp file and injects them into Docker Compose. No long-lived `/opt/dofek/.env.prod` file is stored on the server.

**Adding or updating secrets:**

```bash
infisical secrets set --env prod KEY=value
# Then redeploy app/worker to pick up the new values:
gh workflow run deploy-web.yml -f image_tag=latest
```

No SSH to the server needed. No image rebuild needed.

**Adding or updating non-secret config:** Edit `.env` at the repo root, commit, push. CI builds a new image and deploys via docker-rollout.

**Important:** Compose `environment:` block values override `env_file` values. Never put `DATABASE_URL` in Infisical — it must come from the compose file.

### Required GitHub Actions secrets

- `INFISICAL_TOKEN` (used by deploy workflows + Terraform apply)
- `DEPLOY_SSH_KEY`
- `SERVER_HOST`
- `HCLOUD_TOKEN`
- `SSH_PUBLIC_KEY`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `GHCR_TOKEN` (for the deploy host to pull from ghcr.io)

### Required Infisical `prod` keys

These keys are validated by `run-compose-with-infisical.sh` (via `REQUIRED_INFISICAL_VARS`) and the Terraform `deploy_compose` provisioner before compose runs. Missing any of them causes deploy to fail fast with a clear error:

- `CLOUDFLARE_API_TOKEN`
- `POSTGRES_PASSWORD`
- `PGADMIN_DEFAULT_EMAIL`
- `PGADMIN_DEFAULT_PASSWORD`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `OTA_JWT_SECRET`
- `OTA_PRIVATE_KEY_B64`
- `OTA_PUBLIC_KEY_B64`

`CLOUDFLARE_API_TOKEN` is used by both Traefik (DNS challenge certificates) and Terraform deploy automation, so one Cloudflare token covers DNS challenges plus Terraform-managed DNS/R2 changes.

### Production machine identity

Production containers authenticate to Infisical using a machine identity token stored in 1Password. To create or rotate:

1. Infisical dashboard → Project Settings → Machine Identities
2. Create a Universal Auth identity with read access to the `prod` environment
3. Copy the access token
4. Store it in 1Password as `Infisical Machine Identity Token` (password field)
5. The token is passed to deploy jobs via GitHub Actions secret `INFISICAL_TOKEN` and to Terraform via `TF_VAR_infisical_token`

### 1Password deploy notes

| 1Password Item | Use |
|---|---|
| `Hetzner Cloud API Token` | Terraform `hcloud_token` for server provisioning |
| `Infisical Machine Identity Token` | `INFISICAL_TOKEN` for the host deploy script to export production secrets |

The 1Password item titled `Hetzner` stores Hetzner account login credentials, **not** a Cloud API token. Use `Hetzner Cloud API Token` for Terraform.

When running from automation/agent shells, `op signin` may not persist a global session. Use an inline session token:

```bash
TOKEN=$(op signin --account my.1password.com --raw)
OP_SESSION_my_1password_com="$TOKEN" op whoami --account my.1password.com
```

Example Terraform env export:

```bash
TOKEN=$(op signin --account my.1password.com --raw)
export TF_VAR_hcloud_token=$(OP_SESSION_my_1password_com="$TOKEN" \
  op item get "Hetzner Cloud API Token" --field password)
export TF_VAR_infisical_token=$(OP_SESSION_my_1password_com="$TOKEN" \
  op item get "Infisical Machine Identity Token" --field password)
```

## SSH access

The domain (`dofek.asherlc.com`) is behind Cloudflare, so you need the **direct Hetzner IP** to SSH. Find it via:

- Hetzner Cloud console → Servers → `dofek` → IP address
- `~/.ssh/known_hosts` (grep for Hetzner IP ranges like `159.69.*`, `116.203.*`, `49.12.*`)
- Terraform output: `cd deploy && terraform output server_ip`

```bash
ssh root@<SERVER_IP>
```

## Accessing logs

**In-browser (easiest):** Data Sources page → "System Logs" panel shows the most recent server log entries from the in-memory ring buffer (queried at `limit=100`). Fastest way to check OAuth errors, sync failures, and recent provider activity.

**Docker container logs (SSH):**

```bash
ssh root@<SERVER_IP>
docker ps                                         # container status
docker logs <container> --tail 100                # container logs
docker logs <container> -f                        # follow logs in real-time
```

Container management (restart, inspect, exec) can be done through Portainer at `portainer.dofek.asherlc.com` or via SSH. Server health monitoring is at `netdata.dofek.asherlc.com`.

**Axiom (centralized):** Application logs, traces, and Docker container logs ship to [Axiom](https://axiom.co) via the OpenTelemetry Collector sidecar. Logs and traces both land in `dofek-logs`; metrics land in `dofek-metrics`. Most complete log source — survives container restarts and preserves structured metadata. Use the `axiom` CLI (e.g. `axiom query 'dofek-logs' --filter '...'`) for production debugging.

## Operational notes & common failures

### "I can't see a provider" in production

Means the provider's `validate()` is failing and it is being filtered out. The fix is to debug **why** validation fails (missing Infisical key, bad config, etc.), not to surface disabled providers. Use the `/fix-provider` skill to diagnose.

### Misleading "Timed out waiting for db/redis" in deploy logs

If `deploy-app.yml` / `deploy-ml.yml` print this line, the **real** cause is in the lines above it — the helper script can also fail before compose even runs (e.g. `infisical` install fails, `infisical export` fails, image pull fails). The script intentionally now phrases its error as "compose up for db/redis failed" with the exit code, so future readers don't mistake an Infisical install failure for a healthcheck timeout.

### Pinning the Infisical CLI version

The Infisical CLI has its **own** version number on Cloudsmith — it does **not** match the Infisical app/server release version on GitHub. Check available versions before bumping:

```bash
curl -s "https://dl.cloudsmith.io/public/infisical/infisical-cli/deb/ubuntu/dists/noble/main/binary-arm64/Packages" \
  | awk '/^Version:/ {print $2}' | sort -V -r | head -5
```

The pin lives in two places — keep them in sync:

- `deploy/server/run-compose-with-infisical.sh` (`INFISICAL_VERSION`)
- `deploy/server/cloud-init.yml` (`apt-get install -y "infisical=<version>"`)

### HCP Terraform "workspace already locked"

The `Deploy Terraform` workflow runs `terraform init` followed by `terraform apply` against HCP Terraform. HCP can briefly hold the workspace lock during init/state ops; if `apply` runs immediately after, it can race the lock release (or collide with a stale lock from a prior failed run). The workflow uses `-lock-timeout=5m` so apply waits rather than failing immediately. If a lock truly stuck (e.g. a worker died mid-apply), force-unlock from the HCP Terraform UI (Workspace → Settings → Locking) using the lock ID from the error message.

### Terraform `remote-exec` failed during `terraform_data.deploy_compose`

The provisioner runs `run-compose-with-infisical.sh` on the server, which validates that all `REQUIRED_INFISICAL_VARS` are present before continuing. Common causes:

- A new key was added to `REQUIRED_INFISICAL_VARS` but not yet added to Infisical — set it with `infisical secrets set --env=prod KEY=value` and re-run.
- `INFISICAL_TOKEN` is missing or the machine identity lost access — rotate via the Infisical dashboard and update the GitHub Actions secret + 1Password entry.
- `infisical` CLI version pin is wrong (see above).

### Terraform-native first

When automating new server config / DNS / compose changes, prefer Terraform with `templatefile()`, providers, and `terraform apply` in CI over ad-hoc shell scripts or `curl`/`sed` pipelines. Terraform gives you plan/apply semantics, state tracking, and idempotency that scripts lack.

## Mobile OTA updates

The server hosts a self-hosted Expo Updates endpoint at `/api/updates/manifest`, following the **Expo Updates Protocol v1 (Modern Manifest)** with mandatory **RSA-SHA256 code signing**.

To check what OTA update is currently deployed on prod:

```bash
curl -s -v -H "expo-protocol-version: 1" -H "expo-platform: ios" -H "expo-runtime-version: 1.0" \
  https://dofek.asherlc.com/api/updates/manifest
```

- **Multipart response** with JSON manifest + `expo-signature` header → an update is published (includes `id`, `createdAt`, `runtimeVersion`, asset hashes)
- **204 No Content** → no update is published (the app uses its embedded bundle)

OTA artifacts (`expo-updates-manifest.json` and the standard Expo `dist/` structure) live in Cloudflare R2 under versioned prefixes:

- `mobile-ota/releases/<release-id>/...`
- `mobile-ota/current-release.json` (pointer file with `{ "releaseId": "..." }`)

The API serves `/api/updates/*` directly from R2. The runtime version must match `packages/mobile/app.json`.
