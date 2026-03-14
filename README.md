# Dofek (דופק)

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

Each data source is a **provider plugin** that implements a simple interface. The sync runner orchestrates all enabled providers. Data lands in a `fitness` Postgres schema. The web dashboard provides sync controls, provider health monitoring, insights, and data exploration. Sync runs as a one-shot container triggered by a server cron job.

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

pnpm workspace monorepo with three packages:

```
dofek/
├── src/                    # Root package — sync runner, providers, DB schema
├── packages/
│   ├── server/             # dofek-server — Express + tRPC API (Node)
│   └── web/                # dofek-web — Vite + React SPA (browser)
├── drizzle/                # SQL migrations
└── Dockerfile              # Multi-stage: server + client targets
```

The server imports shared code from the root package via `dofek` workspace dependency (e.g. `import { createDatabaseFromEnv } from "dofek/db"`). The web client imports the `AppRouter` type from the server via `dofek-server/router`.

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

Tests use [Vitest](https://vitest.dev/). TDD is the standard workflow — write tests first, then implement. Test files are colocated with source files (e.g. `index.test.ts` next to `index.ts`).

## Docker

Two images built from a single multi-stage Dockerfile:

| Image | Base | Contents | Size |
|-------|------|----------|------|
| `ghcr.io/asherlc/dofek:latest` | node:22-slim | Express API + sync runner | ~350MB |
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

### Production architecture

```
Traefik (host routing + Authentik auth)
  └── dofek-client (Nginx :80)
        ├── /assets/*    → static files (1yr cache)
        ├── /api/*       → proxy_pass dofek-web:3000
        ├── /auth/*      → proxy_pass dofek-web:3000
        ├── /callback    → proxy_pass dofek-web:3000
        └── /*           → index.html (SPA fallback)
```

Traefik handles host-based routing and authentication. Nginx owns all path-based routing within the app — this keeps infrastructure config decoupled from application routing. The Express server (`dofek-web`) has no published port and is only reachable internally via Nginx.

### Entrypoint modes

The server image runs in two modes via `entrypoint.sh`:

```bash
# API server (Express + tRPC)
docker run dofek:latest web

# Sync runner (provider data sync)
docker run dofek:latest sync
```

Both use Node 22 `--experimental-transform-types` to run TypeScript source directly — no build step.

## Deployment

Deployed on a Hetzner Cloud CAX11 (ARM) server at `dofek.asherlc.com`.

### Infrastructure

The `deploy/` directory contains everything needed to provision and run the production stack:

```
deploy/
├── main.tf                  # Terraform — Hetzner server, firewall, SSH key
├── cloud-init.yml           # Auto-installs Docker on first boot
├── docker-compose.yml       # Production stack (all services)
├── Caddyfile                # Auto-HTTPS via Let's Encrypt
├── terraform.tfvars.example # Example config
└── .gitignore               # Excludes secrets and state
```

### Production architecture

```
Internet → Caddy (auto-HTTPS :443)
             └── dofek-client (Nginx :80)
                   ├── /assets/*    → static files (1yr cache)
                   ├── /api/*       → proxy_pass dofek-web:3000
                   ├── /auth/*      → proxy_pass dofek-web:3000
                   ├── /callback    → proxy_pass dofek-web:3000
                   └── /*           → index.html (SPA fallback)
```

### Services

| Container | Image | Purpose |
|-----------|-------|---------|
| `caddy` | caddy:2-alpine | TLS termination + reverse proxy to nginx |
| `client` | ghcr.io/asherlc/dofek-client | Nginx serving Vite bundle + proxying API routes |
| `web` | ghcr.io/asherlc/dofek | Express + tRPC API server (port 3000, internal only) |
| `sync` | ghcr.io/asherlc/dofek | Sync runner (provider data sync) |
| `db` | timescale/timescaledb | TimescaleDB (persistent volume) |
| `db-backup` | postgres-backup-local | Daily pg_dump (7 daily, 4 weekly, 6 monthly) |
| `watchtower` | containrrr/watchtower | Auto-pulls new images from GHCR every 5min |

### CI/CD pipeline

```
sops .env → commit → push → GHA builds multi-arch Docker images (amd64 + arm64)
→ pushes to GHCR → Watchtower polls (5min) → pulls new image → restarts containers
```

Migrations run automatically on startup (both `web` and `sync` modes call `runMigrations()`). Upserts make re-runs safe and idempotent.

### Deploying from scratch

1. **Provision the server** (Terraform or manually via Hetzner Cloud console):

```bash
cd deploy
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your Hetzner API token and SSH key
terraform init
terraform apply
```

2. **SSH into the server** and set up the app directory:

```bash
ssh root@<SERVER_IP>
mkdir -p /opt/dofek && cd /opt/dofek
```

3. **Copy deployment files** to the server:

```bash
# From your local machine
scp deploy/docker-compose.yml deploy/Caddyfile root@<SERVER_IP>:/opt/dofek/
```

4. **Create the `.env` file** on the server with the SOPS age key and deployment vars:

```bash
# On the server
cat > /opt/dofek/.env << 'EOF'
SOPS_AGE_KEY=AGE-SECRET-KEY-...
EOF
chmod 600 /opt/dofek/.env
```

5. **Start everything:**

```bash
cd /opt/dofek
docker compose up -d
```

6. **Point DNS** — create an A record for `dofek.asherlc.com` → `<SERVER_IP>`. Caddy will auto-provision the TLS certificate.

### Updating the domain

Edit `deploy/Caddyfile` with the new domain, copy it to the server, and restart Caddy:

```bash
scp deploy/Caddyfile root@<SERVER_IP>:/opt/dofek/
ssh root@<SERVER_IP> "cd /opt/dofek && docker compose restart caddy"
```

### SSH access

```bash
ssh root@<SERVER_IP>
```

```bash
# Common debugging commands
docker ps                                    # container status
docker logs web --tail 50                    # API server logs
docker logs sync --tail 50                   # sync runner logs
cd /opt/dofek && docker compose up -d web    # recreate container
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

**Login page says "No identity providers configured"** — this usually means the API server (`web`) is down, not that providers are misconfigured. The login page silently shows this message when it can't reach `/api/auth/providers`. Check `docker ps` and `docker logs web`.

**If a provider appears grayed out** on the Data Sources page, it means its required env vars are missing. Check:
1. Are the vars in the repo's `.env`? → `sops .env` to verify/add them
2. Is the age key set on the server? → check `/opt/dofek/.env`
3. Is the container running the latest image? → `docker logs web` to check for SOPS errors

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
- [ ] WHOOP raw IMU/accelerometer data from strength strap (protobuf download — see `docs/whoop.md`)

### Dashboard & Insights
- [x] Web dashboard (Vite + React + tRPC + ECharts + shadcn/ui)
- [x] Providers page with sync controls, health status, record counts, and log history
- [x] Life events timeline (annotate health data with arbitrary date markers, before/after analysis)
- [x] Insights engine (training volume, HR zone distribution, 80/20 polarization analysis)
- [x] Additional insight categories (ACWR, TRIMP, critical power curves, training monotony/strain, ramp rate, readiness score)
- [x] Continuous aggregates for long-range trends (daily + weekly caggs on metric_stream with auto-refresh policies)

### Infrastructure
- [x] Winston structured logging with ring buffer transport for UI system logs
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

### Current setup

Authentik is the primary identity provider, using the Dofek OIDC application configured in Terraform (`homelab` repo, `terraform/authentik.tf`). The redirect URI is `https://dofek.asherlc.com/auth/callback/authentik`.

## Provider Configuration

Each provider is enabled by adding its credentials to `.env` (SOPS-encrypted). OAuth providers also require a one-time browser authorization via the Data Sources page.

| Provider | Auth Type | Required `.env` Variables |
|----------|-----------|--------------------------|
| Apple Health | File import | None (upload `.zip`/`.xml` via UI) |
| Wahoo | OAuth 2.0 | `WAHOO_CLIENT_ID`, `WAHOO_CLIENT_SECRET` |
| WHOOP | Custom (email/password + MFA) | None (credentials entered in UI modal) |
| Peloton | Automated login | `PELOTON_USERNAME`, `PELOTON_PASSWORD` |
| FatSecret | OAuth 1.0 | `FATSECRET_CONSUMER_KEY`, `FATSECRET_CONSUMER_SECRET` |
| Withings | OAuth 2.0 | `WITHINGS_CLIENT_ID`, `WITHINGS_CLIENT_SECRET` |
| RideWithGPS | Custom (API key + credentials) | None (entered in UI modal) |
| Polar | OAuth 2.0 | `POLAR_CLIENT_ID`, `POLAR_CLIENT_SECRET` |
| Garmin | SSO login | `GARMIN_EMAIL`, `GARMIN_PASSWORD` |
| Strong | File import | None (upload `.csv` via UI) |
| Cronometer | File import | None (upload `.csv` via UI) |

OAuth providers (Wahoo, Withings, Polar, FatSecret) also need `OAUTH_REDIRECT_URI` set to your deployment's callback URL (e.g. `https://dofek.asherlc.com/callback`). After adding credentials, click the provider tile on the Data Sources page to complete the OAuth flow.

**Not supported:** Fitbit (requires a Fitbit device), standalone FIT file import (FIT parsing exists but is only used internally by the Wahoo provider).

## Secrets

`.env` is encrypted with [SOPS](https://github.com/getsops/sops) + [age](https://github.com/FiloSottile/age). To decrypt/edit secrets you need the age private key.

### Setup (new machine)

```bash
# Retrieve age key from 1Password ("Homelab SOPS Age Key" in Personal vault)
mkdir -p ~/Library/Application\ Support/sops/age
op item get "Homelab SOPS Age Key" --account my.1password.com --fields notesPlain \
  | grep -A2 "^# created" > ~/Library/Application\ Support/sops/age/keys.txt
chmod 600 ~/Library/Application\ Support/sops/age/keys.txt
```

### Editing secrets

```bash
sops .env   # opens decrypted file in $EDITOR; re-encrypts on save
```

## Stack

- **TypeScript** — sync scripts, provider plugins, and web dashboard (Node 22 native type stripping at runtime — no tsx in production)
- **Drizzle ORM** — type-safe schema and migrations
- **TimescaleDB** — Postgres with time-series extensions (hypertables, continuous aggregates, compression)
- **Vite + React** — web dashboard frontend
- **tRPC + Express** — API layer
- **ECharts** — data visualization
- **shadcn/ui + Tailwind** — UI components
- **Winston** — structured logging
- **Vitest** — testing
- **Biome** — linting and formatting
- **Docker + GHCR** — deployment via GitHub Actions + Watchtower
