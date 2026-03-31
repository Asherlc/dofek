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

Each data source is a **provider plugin** that implements a simple interface. The sync runner orchestrates all enabled providers. Data lands in a `fitness` Postgres schema. The web dashboard provides sync controls, provider health monitoring, insights, and data exploration. A companion iOS app (Expo + React Native) provides native HealthKit integration and on-the-go access. Long-running sync jobs are processed by a BullMQ worker backed by Redis. Sync runs as a one-shot container triggered by a server cron job.

## Quick Start

```bash
# Start TimescaleDB
docker compose up -d db

# Install dependencies
pnpm install

# Generate and run migrations
pnpm generate
pnpm migrate

# Set up SOPS age key (see "Secrets" section below)
# Then edit secrets with: sops .env
pnpm sync
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
└── Dockerfile                     # Multi-stage: server + client targets
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
```

Tests use [Vitest](https://vitest.dev/). TDD is the standard workflow — write tests first, then implement. Test files are colocated with source files (e.g. `index.test.ts` next to `index.ts`). E2E tests use [Cypress](https://www.cypress.io/) and run against a Docker Compose stack in CI. [Stryker](https://stryker-mutator.io/) mutation testing runs on PRs to verify test quality.

## Docker

Two images built from a single multi-stage Dockerfile:

| Image | Base | Contents | Size |
|-------|------|----------|------|
| `ghcr.io/asherlc/dofek:latest` | node:22-slim | Express API + sync runner + BullMQ worker | ~350MB |
| `ghcr.io/asherlc/dofek-client:latest` | nginx:alpine | Vite static bundle | ~63MB |

### How it works

```
Dockerfile (multi-stage)
├── build stage    — pnpm install, vite build, pnpm deploy
├── server target  — self-contained Node app (API + sync)
└── client target  — Nginx serving static files + proxying API
```

Uses `pnpm deploy --legacy` to create isolated, self-contained directories for each package with all dependencies (including workspace deps) resolved and flattened — no symlinks, no pnpm store. BuildKit cache mounts keep the pnpm store across builds.

### Building locally

```bash
# Build and test both targets before pushing
docker build --target server -t dofek-server:local .
docker build --target client -t dofek-client:local .

# Verify server can resolve its dependencies
docker run --rm --entrypoint node dofek-server:local \
  --experimental-transform-types -e "console.log('OK')"

# Verify nginx config is valid
docker run --rm dofek-client:local nginx -t
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

All modes use Node 22 `--experimental-transform-types` to run TypeScript source directly — no build step. All modes run migrations before starting.

## Deployment

Deployed on a Hetzner Cloud CAX11 (ARM) server at `dofek.asherlc.com`.

### Infrastructure

The `deploy/` directory contains everything needed to provision and run the production stack:

```
deploy/
├── main.tf                       # Terraform — Hetzner server, firewall, SSH key
├── cloud-init.yml                # Auto-installs Docker on first boot
├── docker-compose.yml            # Production stack (all services)
├── otel-collector-config.yaml    # OTel Collector — receives app logs/traces + tails Docker logs → Axiom
├── Caddyfile                     # Auto-HTTPS via Let's Encrypt (multiple domains)
├── deploy-config/main.tf         # Terraform — pushes config updates to server via SSH
├── dns/main.tf                   # Terraform — Cloudflare DNS for dofek.fit + dofek.live
├── terraform.tfvars.example      # Example config
└── .gitignore                    # Excludes secrets and state
```

### Production architecture

```
Internet → Caddy (auto-HTTPS :443, serves dofek.asherlc.com + dofek.fit + dofek.live)
             └── dofek-client (Nginx :80)
                   ├── /assets/*    → static files (1yr cache)
                   ├── /api/*       → proxy_pass dofek-web:3000
                   ├── /auth/*      → proxy_pass dofek-web:3000
                   ├── /callback    → proxy_pass dofek-web:3000
                   ├── /admin/*     → proxy_pass dofek-web:3000 (BullMQ dashboard)
                   ├── /metrics     → proxy_pass dofek-web:3000 (Prometheus)
                   └── /*           → index.html (SPA fallback)
```

### Services

| Container | Image | Purpose |
|-----------|-------|---------|
| `caddy` | caddy:2-alpine | TLS termination + reverse proxy to nginx |
| `client` | ghcr.io/asherlc/dofek-client | Nginx serving Vite bundle + proxying API routes |
| `migrate` | ghcr.io/asherlc/dofek | Runs pending DB migrations (one-shot, exits on completion) |
| `web` | ghcr.io/asherlc/dofek | Express + tRPC API server (port 3000, internal only) |
| `worker` | ghcr.io/asherlc/dofek | BullMQ job worker (processes sync jobs, file imports) |
| `sync` | ghcr.io/asherlc/dofek | Sync runner (provider data sync, one-shot) |
| `redis` | redis:7-alpine | Job queue backend for BullMQ |
| `db` | timescale/timescaledb:latest-pg16 | TimescaleDB (persistent volume) |
| `db-backup` | postgres-backup-local | Daily pg_dump (7 daily, 4 weekly, 6 monthly) |
| `collector` | otel/opentelemetry-collector-contrib | OTel Collector — receives app logs/traces + tails Docker container logs → Axiom |
| `portainer` | portainer/portainer-ce:lts | Container management UI (portainer.dofek.asherlc.com) |
| `watchtower` | containrrr/watchtower | Auto-pulls new images from GHCR every 5min |

### Checking mobile OTA update status

The server hosts a self-hosted Expo Updates endpoint at `/api/updates/manifest`. To check what OTA update is currently deployed on prod:

```bash
curl -s -H "expo-protocol-version: 1" -H "expo-platform: ios" -H "expo-runtime-version: 1.0" \
  https://dofek.asherlc.com/api/updates/manifest
```

- **Multipart response** with JSON manifest → an update is published (includes `id`, `createdAt`, `runtimeVersion`, and asset hashes)
- **204 No Content** → no update is published (the app uses its embedded bundle)

OTA artifacts (`metadata.json`, bundles, assets) are stored in Cloudflare R2 under versioned prefixes:
- `mobile-ota/releases/<release-id>/...`
- `mobile-ota/current-release.json` (pointer file with `{ "releaseId": "..." }`)

The API serves `/api/updates/*` directly from R2 and reads `current-release.json` to pick the active release.

The runtime version must match what's in `packages/mobile/app.json` (`runtimeVersion`).

### CI/CD pipeline

```
sops .env → commit → push → GHA builds ARM Docker images
→ pushes to GHCR → Watchtower polls (5min) → pulls new image → restarts containers
```

Migrations run at two levels for reliability: a dedicated one-shot `migrate` container runs first during `docker compose up` (via `depends_on: { condition: service_completed_successfully }`), and each service's entrypoint also runs migrations before starting. This belt-and-suspenders approach ensures migrations apply both on initial deploy (Compose ordering) and on Watchtower-triggered restarts (which bypass `depends_on`). A Postgres advisory lock serializes concurrent runs so only one container applies migrations at a time. In local dev, run `pnpm migrate` manually.

### Deploying from scratch

Cloud-init handles everything — Docker install, GHCR login, compose file setup, and starting the stack.

```bash
cd deploy
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your Hetzner API token, SSH key, SOPS age key, and GHCR token
terraform init
terraform apply
```

Then point DNS — create an A record for `dofek.asherlc.com` → the output `server_ip`. Caddy will auto-provision the TLS certificate.

### Updating server config files

**Never SSH into the server to edit files directly.** All server config changes (`docker-compose.yml`, `Caddyfile`) go through Terraform via the `deploy/deploy-config` module:

1. Edit the file locally in `deploy/`
2. Run `terraform apply` from `deploy/deploy-config/` — it detects file changes (via md5 hash), copies the updated files to the server via SSH, and runs `docker compose up -d`

```bash
cd deploy/deploy-config
terraform init                              # first time only
terraform apply -var="server_ip=<SERVER_IP>" # copies changed files and restarts containers
```

The `deploy-config` module is intentionally separate from the main `deploy/main.tf` (which provisions the Hetzner server). This lets you push config updates without needing the Hetzner API token or other provisioning secrets. The main module uses `user_data` (cloud-init) to place files at provisioning time, but changing `user_data` forces a server rebuild — `deploy-config` avoids that by using SSH provisioners instead.

**SSH agent requirement:** Terraform's Go SSH client does **not** read `~/.ssh/config` — it only uses the standard `SSH_AUTH_SOCK` agent. If your SSH keys are in 1Password, you must point `SSH_AUTH_SOCK` at the 1Password agent socket:

```bash
export SSH_AUTH_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
cd deploy/deploy-config
terraform apply -var="server_ip=159.69.3.40"
```

Note: Terraform's SSH client also cannot use passphrase-protected keys from `~/.ssh/` without the agent, and `private_key` in the connection block doesn't work with keys stored in 1Password. The `agent = true` approach is the only reliable option.

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

**In-browser (easiest):** The Data Sources page has a "System Logs" panel that shows recent server logs from an in-memory ring buffer (last 500 entries). This is the fastest way to check OAuth errors, sync failures, etc.

**Docker container logs (SSH):** The compose project is at `/opt/dofek`. Container names are prefixed with `dofek-`:

```bash
ssh root@<SERVER_IP>

docker ps                                         # container status
docker logs dofek-web-1 --tail 100                # API server logs (OAuth, tRPC, sync)
docker logs dofek-web-1 --tail 100 | grep error   # filter for errors
docker logs dofek-sync-1 --tail 100               # sync runner logs (one-shot container)
docker logs dofek-client-1 --tail 50              # nginx access logs
docker logs dofek-caddy-1 --tail 50               # TLS/reverse proxy logs

# Follow logs in real-time
docker logs dofek-web-1 -f

# Recreate a container
cd /opt/dofek && docker compose up -d web
```

**Axiom (centralized):** All application logs and Docker container logs are shipped to [Axiom](https://axiom.co) via an OpenTelemetry Collector sidecar. The app uses Winston with an OTel SDK exporter; the collector also tails raw Docker JSON logs from the host filesystem. Two datasets: `dofek-app-logs` (Winston + Docker container logs) and `dofek-traces` (OTel HTTP spans). This is the most complete log source — it survives container restarts and includes structured metadata.

**Note:** The in-memory ring buffer and Docker container logs are still available for quick debugging, but Axiom is the primary log store.

### OpenTelemetry (Provider-Agnostic)

Frontend telemetry is initialized in `packages/web/src/lib/telemetry.ts` and only activates when `VITE_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (or `VITE_OTEL_EXPORTER_OTLP_ENDPOINT`) is set.

The browser instrumentation propagates trace headers on `/api`, `/auth`, and `/callback` so backend OpenTelemetry can continue frontend traces.

Backend telemetry is initialized in `src/instrumentation.ts` and supports both standard OTLP env vars and SOPS plaintext fallback keys with `_unencrypted` suffix for endpoints:
- `OTEL_EXPORTER_OTLP_ENDPOINT_unencrypted`
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT_unencrypted`
- `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT_unencrypted`

Example OTLP endpoint for Sentry (as a backend destination):

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://o<ORG_ID>.ingest.sentry.io/api/<PROJECT_ID>/otlp/v1/traces
OTEL_EXPORTER_OTLP_TRACES_HEADERS=Authorization=Bearer <SENTRY_AUTH_TOKEN>
```

### Production secrets

There are two sources of environment variables for the production containers:

1. **SOPS-encrypted `.env` (this repo)** — provider credentials (API keys, OAuth client IDs/secrets). Baked into the Docker image at build time. The entrypoint decrypts it at container startup using the age key.

2. **`.env` on server (`/opt/dofek/.env`)** — deployment-specific vars: `SOPS_AGE_KEY`, plus any overrides. Loaded via `env_file` in the compose.

The entrypoint merges both: compose `env_file` sets vars first, then `sops exec-env` adds decrypted provider credentials on top.

**Adding new provider credentials:**

```bash
sops .env          # add the new key=value pairs
git add .env && git commit && git push
# CI builds new image → Watchtower deploys automatically
```

No SSH to the server needed. The credentials flow through the Docker image.

**Important:** `sops exec-env` decrypted vars override Docker/compose env vars. Never put `DATABASE_URL` in the SOPS `.env` — it must come from the compose file.

### Troubleshooting

**Login page says "No identity providers configured"** — this usually means the API server (`web`) is down, not that providers are misconfigured. The login page silently shows this message when it can't reach `/api/auth/providers`. Check `docker ps` and `docker logs dofek-web-1`.

**If a provider appears grayed out** on the Data Sources page, it means its required env vars are missing. Check:
1. Are the vars in the repo's `.env`? → `sops .env` to verify/add them
2. Is the age key set on the server? → check `/opt/dofek/.env`
3. Is the container running the latest image? → `docker logs dofek-web-1` to check for SOPS errors

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
- [x] SOPS + Age encrypted secrets
- [x] GHA CI with Docker build + push to GHCR
- [x] Watchtower auto-deploy with Slack notifications
- [x] CLI for authenticating, pulling, and managing providers (`sync`, `auth`, `import` commands)

## Authentication

The web UI requires sign-in via an identity provider (OIDC). Supported providers:

| Provider | Required `.env` Variables |
|----------|--------------------------|
| Authentik | `AUTHENTIK_BASE_URL`, `AUTHENTIK_CLIENT_ID`, `AUTHENTIK_CLIENT_SECRET`, `AUTHENTIK_REDIRECT_URI` |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` |
| Apple | `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `APPLE_REDIRECT_URI` |

All credentials go in the SOPS-encrypted `.env`. The login page auto-discovers which providers are configured and shows buttons accordingly. If no provider env vars are set, the login page shows "No identity providers configured."

## Provider Configuration

Each provider is enabled by adding its credentials to `.env` (SOPS-encrypted). OAuth providers also require a one-time browser authorization via the Data Sources page.

### Implemented Providers (30)

| Provider | Auth Type | Data Types | Required `.env` Variables |
|----------|-----------|------------|--------------------------|
| Apple Health | File import | HR, HRV, sleep, workouts, body, glucose, nutrition, walking, labs | None (upload `.zip`/`.xml` via web UI or share to iOS app) |
| BodySpec | OAuth 2.0 | DEXA scans (body composition, bone density, visceral fat, RMR) | `BODYSPEC_CLIENT_ID`, `BODYSPEC_CLIENT_SECRET` |
| Wahoo | OAuth 2.0 | Activities with FIT file parsing (GPS, power, HR, cadence, running dynamics) | `WAHOO_CLIENT_ID`, `WAHOO_CLIENT_SECRET` |
| WHOOP | RE'd (Cognito) | Sleep, recovery, workouts, 6s HR streams, journal, strength sets | None (credentials entered in UI modal) |
| Peloton | Automated login | Workouts with performance metrics | `PELOTON_USERNAME`, `PELOTON_PASSWORD` |
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

OAuth providers also need `OAUTH_REDIRECT_URI` set to your deployment's callback URL (e.g. `https://dofek.asherlc.com/callback`). After adding credentials, click the provider tile on the Data Sources page to complete the OAuth flow.

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

`.env` is encrypted with [SOPS](https://github.com/getsops/sops) + [age](https://github.com/FiloSottile/age). To decrypt/edit secrets you need the age private key.

### Setup (new machine)

The age private key is stored in 1Password ("Homelab SOPS Age Key"). Either place it on disk or export it as an env var:

```bash
# Option A: Place your age private key where SOPS can find it
mkdir -p ~/Library/Application\ Support/sops/age
# Copy your age key into keys.txt (the private key starts with AGE-SECRET-KEY-)
chmod 600 ~/Library/Application\ Support/sops/age/keys.txt

# Option B: Export from 1Password (no file needed)
export SOPS_AGE_KEY=$(op item get "Homelab SOPS Age Key" --fields notesPlain | grep "^AGE-SECRET-KEY-")
```

### Editing secrets

```bash
# Interactive: opens decrypted file in $EDITOR; re-encrypts on save
sops .env

# Non-interactive: decrypt → edit → re-encrypt in place
sops decrypt --in-place .env    # now .env is plaintext
# ... edit .env with any tool ...
sops encrypt --in-place .env    # re-encrypts
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
- **Docker + GHCR** — deployment via GitHub Actions + Watchtower
