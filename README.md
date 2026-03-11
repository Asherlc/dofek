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
│  Withings   │──┘
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

## Development

```bash
pnpm test          # run tests
pnpm test:watch    # run tests in watch mode
pnpm dev           # run sync in dev mode

# Web dashboard (runs on port 3001)
cd web
PORT=3001 pnpm dev
```

Tests use [Vitest](https://vitest.dev/). TDD is the standard workflow — write tests first, then implement.

## Deployment

Deployed at `dofek.asherlc.com` (behind Authentik) and `dofek.home` (local). Docker image: `ghcr.io/asherlc/dofek:latest`.

GitHub Actions builds and pushes on merge to main. Watchtower auto-pulls the image on the server (5min poll). Homelab compose runs: `dofek-db` (TimescaleDB), `dofek-web`, `dofek-sync`, `dofek-db-backup`.

The sync container runs as a one-shot job triggered by cron on the server:

```bash
# Every 6 hours
0 */6 * * * docker compose -f /path/to/dofek/docker-compose.yml run --rm sync
```

The `--rm` flag removes the container after each run. Upserts make re-runs safe and idempotent.

Use `--since-days=N` to control the sync window:

```bash
# Sync last 30 days (backfill)
docker compose run --rm sync node dist/index.js sync --since-days=30
```

## Supplements

Supplements are fundamentally **nutrition data**, not a separate concept. The `auto-supplements` provider automates repetitive daily entry by reading a supplement stack config and inserting one `food_entry` row per supplement per day, with `category = 'supplement'`. This means:

- Supplement start/stop dates are **implicit** — they're visible from when consumption records begin and end in the `food_entry` table. No separate tracking needed.
- Supplement data participates in all nutrition analysis (calorie totals, micro/macronutrient breakdowns, insights engine) automatically.
- The web UI provides a supplement stack editor to define what you take daily. Changes to the stack config are reflected in future sync runs.

See `src/providers/auto-supplements.ts` for the provider implementation.

## Life Events

Life events are arbitrary time markers (point-in-time, bounded date range, or ongoing) that let you annotate your health timeline and compare metrics before/during/after. Examples: starting a diet, an injury, a training change. The web dashboard provides a UI to create events and view before/after analysis across heart rate, HRV, sleep, body composition, and activity metrics.

See `web/src/server/routers/life-events.ts` for the API and `web/src/client/components/LifeEventsPanel.tsx` for the UI.

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
- [x] Withings provider (OAuth + sync for scale, BP, thermometer — awaiting credentials)
- [x] Cross-provider deduplication via materialized views (recursive CTE overlap clustering, per-field merge by provider priority)
- [ ] Apple Health automated import (iOS Shortcut trigger)
- [ ] Hevy provider (strength training)
- [ ] Intervals.icu provider (training analytics)
- [ ] RideWithGPS provider (routes, rides)

### Dashboard & Insights
- [x] Web dashboard (Vite + React + tRPC + ECharts + shadcn/ui)
- [x] Providers page with sync controls, health status, record counts, and log history
- [x] Life events timeline (annotate health data with arbitrary date markers, before/after analysis)
- [x] Insights engine (training volume, HR zone distribution, 80/20 polarization analysis)
- [ ] Additional insight categories (ACWR, TRIMP, overtraining detection, recovery tests)
- [ ] Continuous aggregates for long-range trends

### Infrastructure
- [x] Winston structured logging with ring buffer transport for UI system logs
- [x] SOPS + Age encrypted secrets
- [x] GHA CI with Docker build + push to GHCR
- [x] Watchtower auto-deploy with Slack notifications
- [ ] CLI for authenticating, pulling, and managing providers

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
