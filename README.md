# Dofek (דופק)

[![CI](https://github.com/Asherlc/dofek/actions/workflows/ci.yml/badge.svg)](https://github.com/Asherlc/dofek/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Asherlc/dofek/graph/badge.svg)](https://codecov.io/gh/Asherlc/dofek)
[![Knip](https://knip.dev/shields/badge.svg)](https://knip.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Biome](https://img.shields.io/badge/Biome-60a5fa?logo=biome&logoColor=white)](https://biomejs.dev/)
[![pnpm](https://img.shields.io/badge/pnpm-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![Drizzle ORM](https://img.shields.io/badge/Drizzle_ORM-C5F74F?logo=drizzle&logoColor=black)](https://orm.drizzle.team/)
[![Expo](https://img.shields.io/badge/Expo-000020?logo=expo&logoColor=white)](https://expo.dev/)

Provider-agnostic fitness and health data pipeline. Pulls data from various APIs (strength training, cardio, body composition, sleep, nutrition, journals) into a TimescaleDB database with a built-in web dashboard.

## Architecture

```
┌─────────────┐
│ Apple Health │──┐
├─────────────┤  │
│  Wahoo API  │──┤
├─────────────┤  │     ┌──────────────┐     ┌──────────────┐     ┌───────────┐
│  WHOOP API  │──┼────▶│  Sync Runner │────▶│ TimescaleDB  │────▶│ Web UI    │
├─────────────┤  │     └──────────────┘     └──────────────┘     │ (Vite +   │
│  Peloton    │──┤        (provider           (fitness schema)   │  React +  │
├─────────────┤  │         plugins)                               │  tRPC)    │
│  FatSecret  │──┤                                                └───────────┘
├─────────────┤  │
│  Withings   │──┤
├─────────────┤  │
│ RideWithGPS │──┤
├─────────────┤  │
│  Polar      │──┤
├─────────────┤  │
│  Garmin     │──┘
└─────────────┘
```

Each data source is a **provider plugin** that implements a simple interface. The sync runner orchestrates all enabled providers. Data lands in a `fitness` Postgres schema. The web dashboard provides sync controls, provider health monitoring, insights, and data exploration. A companion iOS app (Expo + React Native) provides native HealthKit integration and on-the-go access. Long-running sync jobs are processed by BullMQ workers backed by Redis. In production, the `worker` container registers repeatable scheduled sync jobs in BullMQ; the `sync` mode remains available for manual one-shot runs.

## Quick Start

```bash
# Start local infrastructure
docker compose up -d db redis

# Install dependencies
pnpm install

# Log in to Infisical (see "Secrets" section below), then run with secrets:
infisical run --env=prod -- pnpm migrate
infisical run --env=prod -- pnpm sync
```

## Adding a Provider

See [docs/adding-a-provider.md](docs/adding-a-provider.md).

## Schema

See [docs/schema.md](docs/schema.md) for the full data model.

## Project Structure

pnpm workspace monorepo:

```
dofek/
├── src/                           # Root package — sync runner, providers, DB schema
│   └── providers/                 # Provider plugin implementations (30 providers)
├── packages/
│   ├── server/                    # dofek-server — Express + tRPC API + BullMQ jobs
│   ├── web/                       # dofek-web — Vite + React SPA (browser)
│   ├── mobile/                    # dofek-mobile — Expo + React Native app (iOS)
│   ├── format/                    # @dofek/format — date, duration, number, unit formatting
│   ├── scoring/                   # @dofek/scoring — score colors, labels, workload helpers
│   ├── nutrition/                 # @dofek/nutrition — meal types, auto-meal detection
│   ├── training/                  # @dofek/training — activity types, weekly volume
│   ├── stats/                     # @dofek/stats — correlation, regression analysis
│   ├── recovery/                  # @dofek/recovery — recovery metrics and scoring
│   ├── onboarding/                # @dofek/onboarding — onboarding flow logic
│   ├── providers-meta/            # @dofek/providers — provider display labels
│   ├── zones/                     # @dofek/zones — HR/power zone calculations
│   ├── auth/                      # @dofek/auth — shared authentication logic
│   ├── heart-rate-variability/    # @dofek/heart-rate-variability — HRV analysis
│   ├── whoop-whoop/               # RE'd WHOOP internal API client
│   ├── eight-sleep/               # RE'd Eight Sleep internal API client
│   ├── zwift-client/              # RE'd Zwift internal API client
│   ├── trainerroad-client/        # RE'd TrainerRoad internal API client
│   ├── velohero-client/           # RE'd VeloHero API client
│   ├── garmin-connect/            # RE'd Garmin Connect SSO + API client
│   └── trainingpeaks-connect/     # RE'd TrainingPeaks internal API client
├── cypress/                       # E2E tests (Cypress)
├── drizzle/                       # SQL migrations
├── deploy/                        # Terraform + Docker Compose + Caddy
└── Dockerfile                     # Multi-stage: server image with built web assets
```

The server imports shared code from the root package via `dofek` workspace dependency (e.g. `import { createDatabaseFromEnv } from "dofek/db"`). The web client imports the `AppRouter` type from the server via `dofek-server/router`. Shared domain logic lives in dedicated packages (`@dofek/format`, `@dofek/scoring`, etc.) imported by both web and mobile.

## Development

```bash
pnpm test          # run tests
pnpm test:watch    # run tests in watch mode
pnpm dev           # run sync in dev mode

# Web dashboard — starts Vite dev server (proxies /api to Express)
cd packages/web && pnpm dev

# API server
cd packages/server && pnpm dev

# Storybook
pnpm storybook:web
pnpm storybook:mobile
```

Pull requests can publish a web Storybook preview automatically on every PR event. The preview is uploaded to R2 and served from `https://storybook.dofek.fit/storybook/pr-<PR number>/`. Configure `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET` in GitHub Actions secrets, then apply `deploy/cloudflare` Terraform to provision the public R2 custom domain.

Tests use [Vitest](https://vitest.dev/). TDD is the standard workflow — write tests first, then implement. Test files are colocated with source files (e.g. `index.test.ts` next to `index.ts`). E2E tests use [Cypress](https://www.cypress.io/) and run against a Docker Compose stack in CI. [Stryker](https://stryker-mutator.io/) mutation testing runs on PRs to verify test quality.

## Docker

A single image is built from a multi-stage Dockerfile:

| Image | Base | Contents |
|-------|------|----------|
| `ghcr.io/asherlc/dofek:latest` | node:22-alpine | Express API + built web assets + migrations + sync/worker entrypoints |

### How it works

```
Dockerfile (multi-stage)
├── prod-deps      — production-only hoisted workspace install
├── client-build   — full install + Vite build
└── server target  — Node 22 runtime with TypeScript sources + built web assets + entrypoint
```

The server image copies the workspace source tree plus a production-only hoisted `node_modules`, then creates explicit symlinks for workspace packages so bare imports resolve at runtime. Built web assets from `packages/web/dist` are included in the server image — Express serves them directly with SPA fallback. BuildKit cache mounts keep the pnpm store warm across builds. Production runs TypeScript directly on Node 22 with `--experimental-transform-types`; there is no separate server transpile step inside the container.

### Building locally

```bash
# Build and test
docker build --target server -t dofek-server:local .

# Verify server can resolve its dependencies
docker run --rm --entrypoint node dofek-server:local \
  --experimental-transform-types -e "console.log('OK')"
```

Always test Docker builds locally before deploying. The CI build runs on Linux and may behave differently than local dev.

### Entrypoint modes

The server image runs in multiple modes via `entrypoint.sh`:

```bash
# Run pending database migrations (runs once, then exits)
docker run dofek:latest migrate

# API server (Express + tRPC)
docker run dofek:latest web

# BullMQ job worker (processes sync jobs, file imports)
docker run dofek:latest worker

# Sync runner (provider data sync, one-shot)
docker run dofek:latest sync
```

All modes use Node 22 `--experimental-transform-types` to run TypeScript source directly — no build step. All modes run migrations before starting. In production, the `web` mode now waits for migrations to finish before accepting traffic (no background migration while serving).

## Deployment

Deployed on a Hetzner Cloud CAX11 (ARM) server at `dofek.asherlc.com`.

### Infrastructure

The `deploy/` directory contains everything needed to provision and run the production stack:

```
deploy/
├── main.tf                       # Terraform — Hetzner server, firewall, SSH key
├── cloud-init.yml                # First-boot bootstrap: Docker, GHCR login, base compose files
├── docker-compose.yml            # Production stack (all services)
├── otel-collector-config.yaml    # OTel Collector — receives app logs/traces + tails Docker logs → Axiom
├── Caddyfile                     # Auto-HTTPS via Let's Encrypt (multiple domains)
├── deploy.sh                     # Fetches secrets from Infisical + starts Docker Compose
├── deploy-config/main.tf         # Terraform — pushes config updates to server via SSH
├── dns/main.tf                   # Terraform — Cloudflare DNS for dofek.fit + dofek.live
├── terraform.tfvars.example      # Example config
└── .gitignore                    # Excludes secrets and state
```

### Production architecture

```
Internet → Caddy (auto-HTTPS :443, serves dofek.asherlc.com + dofek.fit + dofek.live)
             └── dofek-web (Express :3000, 2 replicas)
                   ├── /assets/*    → static files (1yr immutable cache)
                   ├── /api/*       → tRPC + REST API
                   ├── /auth/*      → OAuth flows
                   ├── /callback    → OAuth callback
                   ├── /admin/*     → BullMQ dashboard
                   ├── /metrics     → Prometheus metrics
                   └── /*           → index.html (SPA fallback)
```

### Services

| Container | Image | Purpose |
|-----------|-------|---------|
| `caddy` | caddy:2-alpine | TLS termination + reverse proxy to Express |
| `migrate` | ghcr.io/asherlc/dofek | Runs pending DB migrations (one-shot, exits on completion) |
| `web` | ghcr.io/asherlc/dofek | Express + tRPC API + static file serving (port 3000, 2 replicas) |
| `worker` | ghcr.io/asherlc/dofek | BullMQ job worker (processes sync jobs, file imports) |
| `sync` | ghcr.io/asherlc/dofek | Sync runner (provider data sync, one-shot) |
| `redis` | redis:7-alpine | Job queue backend for BullMQ |
| `db` | timescale/timescaledb:latest-pg16 | TimescaleDB (persistent volume) |
| `db-backup` | prodrigestivill/postgres-backup-local | Daily pg_dump (7 daily, 4 weekly, 6 monthly) |
| `collector` | otel/opentelemetry-collector-contrib | OTel Collector — receives app logs/traces + tails Docker container logs → Axiom |
| `portainer` | portainer/portainer-ce:lts | Container management UI (portainer.dofek.asherlc.com) |
| `watchtower` | containrrr/watchtower | Auto-pulls new images from GHCR every 5min with rolling restart |

### Checking mobile OTA update status

The server hosts a self-hosted Expo Updates endpoint at `/api/updates/manifest`. This implementation follows the **Expo Updates Protocol v1 (Modern Manifest)** with mandatory **RSA-SHA256 code signing** for security.

To check what OTA update is currently deployed on prod:

```bash
curl -s -v -H "expo-protocol-version: 1" -H "expo-platform: ios" -H "expo-runtime-version: 1.0" \
  https://dofek.asherlc.com/api/updates/manifest
```

- **Multipart response** with JSON manifest and `expo-signature` header → an update is published (includes `id`, `createdAt`, `runtimeVersion`, and asset hashes)
- **204 No Content** → no update is published (the app uses its embedded bundle)

OTA artifacts (`expo-updates-manifest.json` and the standard Expo `dist/` structure) are stored in Cloudflare R2 under versioned prefixes:
- `mobile-ota/releases/<release-id>/...`
- `mobile-ota/current-release.json` (pointer file with `{ "releaseId": "..." }`)

The API serves `/api/updates/*` directly from R2. The runtime version must match what's in `packages/mobile/app.json`.

### CI/CD pipeline

```
git push → GHA builds ARM Docker images + exports Expo OTA bundle → signs manifest → uploads to R2
→ Docker image pushed to GHCR → Watchtower polls (5min) → rolling-restarts replicated `web` containers
```

Migrations run at two levels for reliability: a dedicated one-shot `migrate` container runs first during `docker compose up` (via `depends_on: { condition: service_completed_successfully }`), and each service's entrypoint also runs migrations before starting. A Postgres advisory lock serializes concurrent runs so only one container applies migrations at a time. With replicated `web` instances and rolling restarts, at least one healthy API instance remains available while another instance migrates and boots. In local dev, run `pnpm migrate` manually.

### Preview environments (ephemeral per-PR)

Every pull request gets its own isolated preview environment — a dedicated Hetzner CAX11 server with its own database, Redis, and full application stack.

**How it works:**

```
PR opened/updated → GHA builds PR-tagged Docker images (ghcr.io/asherlc/dofek:pr-{N})
  → Terraform provisions a Hetzner server + Cloudflare DNS record (pr-{N}.preview.dofek.fit)
  → Cloud-init installs Docker, pulls images, starts the preview stack
  → PR comment posted with preview URL

PR closed/merged → Terraform destroys server + DNS record
  → Docker images cleaned up from GHCR
  → Daily cron deletes any stale previews older than 72h once their PR is no longer open
```

**Preview stack** (`deploy/preview/docker-compose.yml`): Caddy, client (nginx), web (API), migrate, seed, Redis, TimescaleDB. No worker, sync, watchtower, OTel collector, backups, or portainer.

**Login:** The preview database is seeded with a dev user and session via `scripts/seed-dev-db.ts`. Visit `https://pr-{N}.preview.dofek.fit/auth/dev-login` to mint the seeded `dev-session` cookie, then you'll be redirected to the dashboard. OAuth callbacks don't work on preview subdomains — email+password auth is planned (see [Authentication Follow-ups](#authentication-follow-ups)).

**Required GitHub secrets:**

| Secret | Purpose |
|--------|---------|
| `HCLOUD_TOKEN` | Hetzner Cloud API token for provisioning preview servers |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with DNS:Edit on dofek.fit zone |
| `CLOUDFLARE_ZONE_ID` | Cloudflare zone ID for dofek.fit |
| `GHCR_TOKEN` | GitHub PAT with `read:packages` for pulling images on preview servers |
| `SSH_PUBLIC_KEY` | SSH public key for accessing preview servers |
| `R2_ACCESS_KEY_ID` | R2 credentials for Terraform state backend |
| `R2_SECRET_ACCESS_KEY` | R2 credentials for Terraform state backend |
| `R2_ENDPOINT` | R2 S3-compatible endpoint URL |
**Terraform state** is stored in the existing R2 bucket (`dofek-training-data`) under `terraform/preview/`, using one workspace per PR.

**Cost:** ~€0.006/hr per preview server (CAX11). A PR open for 24h costs ~€0.14.

### Deploying from scratch

`deploy/main.tf` provisions the Hetzner server and uses cloud-init to install Docker, log into GHCR, write `/opt/dofek/docker-compose.yml`, `/opt/dofek/Caddyfile`, and a minimal `/opt/dofek/.env`, then start the stack.

```bash
cd deploy
# Fetch deploy secrets from 1Password and pass as TF_VAR_ env vars
TOKEN=$(op signin --account my.1password.com --raw)
export TF_VAR_hcloud_token=$(OP_SESSION_my_1password_com="$TOKEN" op item get "Hetzner Cloud API Token" --field password)
export TF_VAR_infisical_token=$(OP_SESSION_my_1password_com="$TOKEN" op item get "Infisical Machine Identity Token" --field password)
# Set remaining non-secret vars
export TF_VAR_ssh_public_key="ssh-ed25519 AAAA..."
export TF_VAR_domain="dofek.asherlc.com"
export TF_VAR_ghcr_username="asherlc"
export TF_VAR_ghcr_token="ghp_..."
terraform init
terraform apply
```

After the server exists:

1. Add host-specific vars to `/opt/dofek/.env`: `INFISICAL_TOKEN`, `POSTGRES_PASSWORD`, `CADDY_DOMAIN`, and optionally `DOCKER_GID` and storage paths. `deploy.sh` uses `INFISICAL_TOKEN` to export the production secrets into `/opt/dofek/secrets.env` before `docker compose up`.
2. Run the deploy-config module once to push `otel-collector-config.yaml` and the current base config.
3. Point DNS at the Hetzner IP (`terraform output -raw server_ip`). Caddy will provision TLS automatically.

```bash
cd deploy/deploy-config
terraform init
terraform apply -var="server_ip=$(cd .. && terraform output -raw server_ip)"
```

### Updating server config files

**Never SSH into the server to edit compose or proxy config directly.** All config-file changes go through the `deploy/deploy-config` module.

`deploy-config` currently syncs:
- `deploy/docker-compose.yml`
- `deploy/Caddyfile`
- `deploy/otel-collector-config.yaml`
- `deploy/deploy.sh`

After copying those files, it runs:

```bash
cd /opt/dofek && ./deploy.sh
```

```bash
cd deploy/deploy-config
terraform init                              # first time only
terraform apply -var="server_ip=<SERVER_IP>" # copies changed files and restarts containers
```

`deploy-config` uses Terraform's default local backend (`deploy/deploy-config/terraform.tfstate`), so no Terraform Cloud account or `terraform login` is required.

The `deploy-config` module is intentionally separate from the main `deploy/main.tf` (which provisions the Hetzner server). This lets you push config updates without needing the Hetzner API token or other provisioning secrets. The main module uses `user_data` (cloud-init) to place files at provisioning time, but changing `user_data` forces a server rebuild — `deploy-config` avoids that by using SSH provisioners instead.

**SSH agent requirement:** Terraform's Go SSH client does **not** read `~/.ssh/config` — it only uses the standard `SSH_AUTH_SOCK` agent. If your SSH keys are in 1Password, you must point `SSH_AUTH_SOCK` at the 1Password agent socket:

```bash
export SSH_AUTH_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
cd deploy/deploy-config
terraform apply -var="server_ip=159.69.3.40"
```

Note: Terraform's SSH client also cannot use passphrase-protected keys from `~/.ssh/` without the agent, and `private_key` in the connection block doesn't work with keys stored in 1Password. The `agent = true` approach is the only reliable option.

`deploy-config` no longer writes secrets into `/opt/dofek/.env`. The host keeps only deploy-time configuration there (`INFISICAL_TOKEN`, `POSTGRES_PASSWORD`, `CADDY_DOMAIN`, optional storage paths). `deploy.sh` bootstraps the Infisical CLI if needed, exports the production secrets to `/opt/dofek/secrets.env`, and then runs Docker Compose with both env files.

**Finding the server IP:** The domain is behind Cloudflare so you need the direct Hetzner IP:
- `~/.ssh/known_hosts` — grep for Hetzner ranges (`159.69.*`, `116.203.*`, `49.12.*`)
- Hetzner Cloud console → Servers → `dofek`

Cloud-init handles the initial provisioning; `deploy-config` handles all subsequent config updates.

### Updating the domain

Edit `deploy/Caddyfile` with the new domain, then run `terraform apply` to push the change.

### SSH access

The domain (`dofek.asherlc.com`) is behind Cloudflare, so you need the **direct Hetzner IP** to SSH. Find it via:
- Hetzner Cloud console → Servers → `dofek` → IP address
- `~/.ssh/known_hosts` (grep for Hetzner IP ranges like `159.69.*`, `116.203.*`, `49.12.*`)
- Terraform state if available: `cd deploy && terraform output server_ip`

```bash
ssh root@<SERVER_IP>
```

### Accessing logs

**In-browser (easiest):** The Data Sources page has a "System Logs" panel that shows the most recent server log entries from the in-memory ring buffer (currently queried at `limit=100`). This is the fastest way to check OAuth errors, sync failures, and recent provider activity.

**Docker container logs (SSH):** The compose project is at `/opt/dofek`. Container names are prefixed with `dofek-`:

```bash
ssh root@<SERVER_IP>

docker ps                                         # container status
docker logs dofek-web-1 --tail 100                # API server logs (OAuth, tRPC, sync)
docker logs dofek-web-1 --tail 100 | grep error   # filter for errors
docker logs dofek-sync-1 --tail 100               # sync runner logs (one-shot container)
docker logs dofek-caddy-1 --tail 50               # TLS/reverse proxy logs

# Follow logs in real-time
docker logs dofek-web-1 -f

# Recreate a container
cd /opt/dofek && docker compose up -d web
```

**Axiom (centralized):** Application logs, traces, and Docker container logs are shipped to [Axiom](https://axiom.co) via the OpenTelemetry Collector sidecar. In the current collector config, logs and traces both land in `dofek-logs`, and metrics land in `dofek-metrics`. This is the most complete log source because it survives container restarts and preserves structured metadata.

**Note:** The in-memory ring buffer and Docker container logs are still available for quick debugging, but Axiom is the primary log store.

### OpenTelemetry (Provider-Agnostic)

Frontend telemetry is initialized in `packages/web/src/lib/telemetry.ts` and only activates when `VITE_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (or `VITE_OTEL_EXPORTER_OTLP_ENDPOINT`) is set.

The browser instrumentation propagates trace headers on `/api`, `/auth`, and `/callback` so backend OpenTelemetry can continue frontend traces.

Backend telemetry is initialized in `src/instrumentation.ts` and uses the standard OTLP env vars:
- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
- `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`

Example OTLP endpoint for Sentry (as a backend destination):

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://o<ORG_ID>.ingest.sentry.io/api/<PROJECT_ID>/otlp/v1/traces
OTEL_EXPORTER_OTLP_TRACES_HEADERS=Authorization=Bearer <SENTRY_AUTH_TOKEN>
```

### Production secrets

**All secrets are managed in [Infisical](https://infisical.com/).** Infisical is the single source of truth for credentials — if a secret isn't in Infisical, it's untracked.

The production containers get environment variables from three places:

1. **Committed `.env` (this repo)** — non-secret config: client IDs, redirect URIs, endpoints, DSNs. Baked into the Docker image. Loaded by the entrypoint on startup.

2. **Infisical (prod environment)** — actual secrets: client secrets, API keys/tokens, private keys. Fetched by `/opt/dofek/deploy.sh` on the host and written to `/opt/dofek/secrets.env` before containers are started or updated.

3. **`.env` on server (`/opt/dofek/.env`)** — host-specific config for Docker Compose interpolation and secret export: `INFISICAL_TOKEN`, `CADDY_DOMAIN`, `POSTGRES_PASSWORD`, optional storage paths.

The container entrypoint now reads the committed repo `.env` for non-secret defaults only. Production secrets come from Docker Compose via `/opt/dofek/secrets.env`, which is refreshed by `deploy.sh` before each deploy.

**Adding or updating secrets:**

```bash
infisical secrets set --env prod KEY=value
# Containers pick up changes on next restart (Watchtower rolling restart)
```

No SSH to the server needed. No image rebuild needed — secrets are fetched at startup.

**Adding or updating non-secret config:** Edit `.env` in this repo, commit, push. CI builds a new image; Watchtower deploys it.

**Important:** Infisical-injected vars override Docker/compose env vars. Never put `DATABASE_URL` in Infisical — it must come from the compose file.

### Troubleshooting

**Login page says "No identity providers configured"** — this can mean either there are truly no configured login providers, or the API server (`web`) is unreachable and the frontend fell back to an empty `/api/auth/providers` result. Check `docker ps`, then inspect `docker logs dofek-web-1`.

**If a provider is missing from the Data Sources page** it usually means `validate()` is failing, so the provider is being filtered out entirely rather than shown disabled. Check:
1. Are the vars in Infisical? → `infisical secrets get <VAR_NAME> --env=prod`
2. Is the Infisical token set on the server? → check `/opt/dofek/.env`
3. Is the container running the latest image? → `docker logs dofek-web-1` to check for Infisical errors

## Supplements

Supplements are fundamentally **nutrition data**, not a separate concept. The `auto-supplements` provider automates repetitive daily entry by reading a supplement stack config and inserting one `food_entry` row per supplement per day, with `category = 'supplement'`. This means:

- Supplement start/stop dates are **implicit** — they're visible from when consumption records begin and end in the `food_entry` table. No separate tracking needed.
- Supplement data participates in all nutrition analysis (calorie totals, micro/macronutrient breakdowns, insights engine) automatically.
- The web UI provides a supplement stack editor to define what you take daily. Changes to the stack config are reflected in future sync runs.

See `src/providers/auto-supplements.ts` for the provider implementation.

## Life Events

Life events are arbitrary time markers (point-in-time, bounded date range, or ongoing) that let you annotate your health timeline and compare metrics before/during/after. Examples: starting a diet, an injury, a training change. The web dashboard provides a UI to create events and view before/after analysis across heart rate, HRV, sleep, body composition, and activity metrics.

See `packages/server/src/routers/life-events.ts` for the API and `packages/web/src/components/LifeEventsPanel.tsx` for the UI.

## Roadmap

### Data Ingestion
- [x] Apple Health XML parser (HR streams, HRV, sleep stages, workouts, body measurements, blood glucose, nutrition, walking stats, mindful sessions)
- [x] Apple Health HTTP upload with chunked transfer and progress indicator
- [x] Apple Health workout routes (GPS data from WorkoutRoute elements → metric_stream)
- [x] Clinical/lab data ingestion (Apple Health FHIR clinical records — 1,173 lab results)
- [x] Nutrition data ingestion (FatSecret provider — per-food-item granularity with full micro/macronutrients)
- [x] Supplement tracking (auto-supplements provider reads config, inserts daily; `category` enum distinguishes supplements from food)
- [x] Peloton direct provider (automated Auth0 login, workouts + performance metrics)
- [x] Wahoo provider (OAuth + FIT file parsing → GPS/power/HR/cadence/running dynamics)
- [x] WHOOP provider (sleep, recovery, workouts, 6s HR streams, journal entries via internal API)
- [x] WHOOP strength trainer sync (exercise-level sets/reps/weight from `weightlifting-service` internal API)
- [x] Withings provider (OAuth + sync for scale, BP, thermometer — awaiting credentials)
- [x] Cross-provider deduplication via materialized views (recursive CTE overlap clustering, per-field merge by provider priority)
- [x] Strong CSV import (strength training history — CSV upload with unit conversion)
- [x] RideWithGPS provider (trip sync with GPS track points, activity type mapping)
- [x] WHOOP raw IMU/accelerometer data investigation — **not feasible**: data is in a private S3 bucket with no download API; app only uploads, never reads back. Load-velocity profiles (derived from accelerometer) may be accessible once enough training data is collected. See `docs/whoop.md`.

### Dashboard & Insights
- [x] Web dashboard (Vite + React + tRPC + ECharts + shadcn/ui)
- [x] Providers page with sync controls, health status, record counts, and log history
- [x] Life events timeline (annotate health data with arbitrary date markers, before/after analysis)
- [x] Insights engine (training volume, HR zone distribution, 80/20 polarization analysis)
- [x] Additional insight categories (ACWR, TRIMP, critical power curves, training monotony/strain, ramp rate, readiness score)
- [x] Continuous aggregates for long-range trends (daily + weekly caggs on metric_stream with auto-refresh policies)

### Infrastructure
- [x] Winston structured logging with ring buffer transport for UI system logs
- [x] OTel Collector sidecar shipping app logs + Docker container logs to Axiom
- [x] Infisical secrets management (migrated from SOPS + Age)
- [x] GHA CI with Docker build + push to GHCR
- [x] Watchtower auto-deploy with Slack notifications
- [x] CLI for authenticating, pulling, and managing providers (`sync`, `auth`, `import` commands)
- [x] Ephemeral preview environments per PR (Hetzner server + Cloudflare DNS + seeded DB)

### Authentication Follow-ups
- [ ] When a user signs up with any provider that does not give us an email, require them to enter their email manually before completing signup/account linking
- [ ] Email + password authentication: add `auth_credential` table (email + argon2 hash), registration and login routes (`POST /auth/register`, `POST /auth/login/email`), login forms on web and mobile, account linking with existing OAuth users by email. Needed for ephemeral preview environments where OAuth callbacks don't work on preview subdomains. Password reset flow (requires email sender like Resend/SES) can be added separately.

## Authentication

The web UI requires sign-in via an identity provider (OIDC). Supported providers:

| Provider | Required `.env` Variables |
|----------|--------------------------|
| Authentik | `AUTHENTIK_BASE_URL`, `AUTHENTIK_CLIENT_ID`, `AUTHENTIK_CLIENT_SECRET`, `AUTHENTIK_REDIRECT_URI` |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` |
| Apple | `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `APPLE_REDIRECT_URI` |

All credentials are stored in Infisical. The login page auto-discovers which providers are configured and shows buttons accordingly. If no provider env vars are set, the login page shows "No identity providers configured."

## Provider Configuration

Each provider is enabled by adding its credentials to Infisical. OAuth providers also require a one-time browser authorization via the Data Sources page.

### Implemented Providers (30)

| Provider | Auth Type | Data Types | Required `.env` Variables |
|----------|-----------|------------|--------------------------|
| Apple Health | File import | HR, HRV, sleep, workouts, body, glucose, nutrition, walking, labs | None (upload `.zip`/`.xml` via web UI or share to iOS app) |
| BodySpec | OAuth 2.0 | DEXA scans (body composition, bone density, visceral fat, RMR) | `BODYSPEC_CLIENT_ID`, `BODYSPEC_CLIENT_SECRET` |
| Wahoo | OAuth 2.0 | Activities with FIT file parsing (GPS, power, HR, cadence, running dynamics) | `WAHOO_CLIENT_ID`, `WAHOO_CLIENT_SECRET` |
| WHOOP | RE'd (Cognito) | Sleep, recovery, workouts, 6s HR streams, journal, strength sets | None (credentials entered in UI modal) |
| Peloton | Automated login | Workouts with performance metrics | None (credentials entered in UI modal) |
| FatSecret | OAuth 1.0 | Per-food-item nutrition with full micro/macronutrients | `FATSECRET_CONSUMER_KEY`, `FATSECRET_CONSUMER_SECRET` |
| Withings | OAuth 2.0 | Scale, BP, thermometer | `WITHINGS_CLIENT_ID`, `WITHINGS_CLIENT_SECRET` |
| RideWithGPS | Custom | Trips with GPS track points | None (entered in UI modal) |
| Polar | OAuth 2.0 | Exercises, sleep, HR, Nightly Recharge | `POLAR_CLIENT_ID`, `POLAR_CLIENT_SECRET` |
| Garmin | RE'd (SSO) | Activities, sleep, daily metrics, body battery, stress, HRV, training | `GARMIN_EMAIL`, `GARMIN_PASSWORD` |
| Strava | OAuth 2.0 | Activities | `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` |
| Fitbit | OAuth 2.0 | HR, sleep, SpO2, HRV, temperature, VO2 max, activity | `FITBIT_CLIENT_ID`, `FITBIT_CLIENT_SECRET` |
| Oura | OAuth 2.0 | Sleep, readiness, activity, SpO2, VO2 max, workouts, stress, resilience | `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET` |
| Eight Sleep | RE'd (hardcoded creds) | Sleep trends (HR, HRV, respiratory, temperature, stages) | `EIGHT_SLEEP_EMAIL`, `EIGHT_SLEEP_PASSWORD` |
| Zwift | RE'd (Keycloak) | Activities with power/HR/cadence, FTP | `ZWIFT_USERNAME`, `ZWIFT_PASSWORD` |
| TrainerRoad | RE'd (CSRF cookies) | Activities with power data, career stats | `TRAINERROAD_USERNAME`, `TRAINERROAD_PASSWORD` |
| Suunto | OAuth 2.0 | Workouts | `SUUNTO_CLIENT_ID`, `SUUNTO_CLIENT_SECRET`, `SUUNTO_SUBSCRIPTION_KEY` |
| COROS | OAuth 2.0 | Activities | `COROS_CLIENT_ID`, `COROS_CLIENT_SECRET` |
| Concept2 | OAuth 2.0 | Rowing results | `CONCEPT2_CLIENT_ID`, `CONCEPT2_CLIENT_SECRET` |
| Komoot | OAuth 2.0 | Tours | `KOMOOT_CLIENT_ID`, `KOMOOT_CLIENT_SECRET` |
| MapMyFitness | OAuth 2.0 | Workouts | `MAPMYFITNESS_CLIENT_ID`, `MAPMYFITNESS_CLIENT_SECRET` |
| Ultrahuman | RE'd | Sleep, activity, daily metrics | `ULTRAHUMAN_EMAIL`, `ULTRAHUMAN_PASSWORD` |
| VeloHero | RE'd (SSO) | Workouts with HR/power/cadence | `VELOHERO_SSO_KEY` |
| Xert | OAuth 2.0 | Activities | `XERT_CLIENT_ID`, `XERT_CLIENT_SECRET` |
| Cycling Analytics | OAuth 2.0 | Rides | `CYCLING_ANALYTICS_CLIENT_ID`, `CYCLING_ANALYTICS_CLIENT_SECRET` |
| Wger | OAuth 2.0 | Workouts | `WGER_CLIENT_ID`, `WGER_CLIENT_SECRET` |
| Decathlon | OAuth 2.0 | Activities | `DECATHLON_CLIENT_ID`, `DECATHLON_CLIENT_SECRET` |
| Strong | File import | Strength training history | None (upload `.csv` via web UI or share to iOS app) |
| Cronometer | File import | Nutrition | None (upload `.csv` via web UI or share to iOS app) |
| Auto-Supplements | Config-based | Daily supplement entries | None (configured in UI) |

OAuth providers also need a callback URL env var pointing at your deployment's `/callback` route (for example `https://dofek.asherlc.com/callback`). Set `OAUTH_REDIRECT_URI` in Infisical. After adding credentials, click the provider tile on the Data Sources page to complete the OAuth flow.

### Reverse-Engineered API Packages (7)

Standalone TypeScript packages for internal APIs that lack public developer access:

| Package | Auth Pattern | Source |
|---------|-------------|--------|
| `packages/whoop-whoop` | AWS Cognito | Internal API |
| `packages/eight-sleep` | Hardcoded OAuth creds (from APK) | Internal API |
| `packages/zwift-client` | Keycloak password grant | Internal API |
| `packages/trainerroad-client` | CSRF cookie form login | Internal API |
| `packages/velohero-client` | SSO token | Simple web API |
| `packages/garmin-connect` | Multi-step SSO (OAuth1 → OAuth2) | Based on python-garminconnect |
| `packages/trainingpeaks-connect` | Browser cookie → Bearer exchange | Based on tp2intervals |

### Not Implemented

| Provider | Reason | Workaround |
|----------|--------|------------|
| Rouvy | No public API, no RE work exists. Firebase + GraphQL behind Tyk gateway. | Sync to Strava/Garmin, pull from there |
| Hammerhead | No public API. Some RE work exists but SRAM account migration broke auth. | Sync to Strava/Intervals.icu, pull from there |
| Zepp (Amazfit) | Official API registration effectively closed. RE feasible via `hacking-mifit-api` (email+password auth) but not yet built. | Future candidate for RE'd package |
| Samsung Health | No web API, no RE work. Would need dedicated Android companion app. | Not feasible for server-side sync |

See [docs/provider-api-audit.md](docs/provider-api-audit.md) for detailed RE feasibility analysis of each provider.

## Secrets

Environment variables are split into two tiers:

| Tier | Where | Examples | Needs rebuild? |
|------|-------|----------|----------------|
| **Non-secret config** | Committed `.env` in this repo | Client IDs, redirect URIs, endpoints, DSNs | Yes (baked into image) |
| **Secrets** | [Infisical](https://infisical.com/) (prod environment) | Client secrets, API keys, tokens, private keys | No (fetched at startup) |

### Setup (new machine)

```bash
# Install the CLI
brew install infisical/get-cli/infisical

# Log in (opens browser)
infisical login

# Link this project (already done — .infisical.json is committed)
# infisical init
```

### Local development

Non-secret config is loaded automatically from `.env`. Secrets are injected by the Infisical CLI:

```bash
# Run any command with secrets injected
infisical run --env=prod -- pnpm dev

# Or use the helper script (sources .env + Infisical)
./scripts/with-env.sh pnpm dev

# Vite dev server (VITE_ vars come from packages/web/.env)
infisical run --env=prod -- sh -c 'cd packages/web && pnpm dev'
```

### Managing secrets

```bash
# List all secrets
infisical secrets --env=prod

# Add or update a secret
infisical secrets set --env=prod KEY=value

# Get a single secret
infisical secrets get KEY --env=prod

# Delete a secret
infisical secrets delete KEY --env=prod --type shared
```

### Adding a new env var

- **Is it a secret?** (API key, token, password, private key, client secret) → Add to Infisical: `infisical secrets set --env=prod KEY=value`
- **Is it non-secret config?** (client ID, redirect URI, endpoint, DSN) → Add to the committed `.env` at the repo root

### Production machine identity

Production containers authenticate to Infisical using a machine identity token stored in 1Password. To create or rotate:

1. In the [Infisical dashboard](https://app.infisical.com/) → Project Settings → Machine Identities
2. Create a Universal Auth identity with read access to the `prod` environment
3. Copy the access token
4. Store it in 1Password as `Infisical Machine Identity Token` (password field)
5. The token reaches the server via Terraform's `infisical_token` variable → cloud-init writes it to `/opt/dofek/.env` as `INFISICAL_TOKEN`

### 1Password deploy notes

Deploy secrets (Hetzner API token, Infisical machine identity token) are stored in 1Password — never in `terraform.tfvars` or any committed file.

| 1Password Item | Use |
|---|---|
| `Hetzner Cloud API Token` | Terraform `hcloud_token` for server provisioning |
| `Infisical Machine Identity Token` | `INFISICAL_TOKEN` for the host deploy script to export production secrets |

Important: the 1Password item titled `Hetzner` stores Hetzner account login credentials, not a Cloud API token. Use `Hetzner Cloud API Token` for Terraform.

When running from automation/agent shells, `op signin` may not persist a global session. Use an inline session token:

```bash
TOKEN=$(op signin --account my.1password.com --raw)
OP_SESSION_my_1password_com="$TOKEN" op whoami --account my.1password.com
```

Example Terraform env export flow:

```bash
TOKEN=$(op signin --account my.1password.com --raw)
export TF_VAR_hcloud_token=$(OP_SESSION_my_1password_com="$TOKEN" op item get "Hetzner Cloud API Token" --field password)
export TF_VAR_infisical_token=$(OP_SESSION_my_1password_com="$TOKEN" op item get "Infisical Machine Identity Token" --field password)
```

## Stack

- **TypeScript** — sync scripts, provider plugins, and web + mobile apps (Node 22 native type stripping at runtime — no tsx in production)
- **Drizzle ORM** — type-safe schema and migrations
- **TimescaleDB** — Postgres with time-series extensions (hypertables, continuous aggregates, compression)
- **Vite + React** — web dashboard frontend
- **Expo + React Native** — iOS mobile app with native HealthKit integration
- **tRPC + Express** — API layer
- **BullMQ + Redis** — job queue for async sync jobs and file imports
- **ECharts** — data visualization (web)
- **shadcn/ui + Tailwind** — UI components (web)
- **Winston** — structured logging
- **Sentry** — error tracking (via OpenTelemetry)
- **Vitest** — unit + integration testing
- **Cypress** — E2E testing
- **Stryker** — mutation testing
- **Biome** — linting and formatting
- **Infisical** — secrets management (client secrets, API keys, tokens)
- **Docker + GHCR** — deployment via GitHub Actions + Watchtower
