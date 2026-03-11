# health-data

Provider-agnostic fitness and health data pipeline. Pulls data from various APIs (strength training, cardio, body composition, sleep, nutrition) into a TimescaleDB database for Grafana dashboards.

## Architecture

```
┌─────────────┐
│  Hevy API   │──┐
├─────────────┤  │     ┌──────────────┐     ┌──────────────┐     ┌─────────┐
│  Wahoo API  │──┼────▶│  Sync Runner │────▶│ TimescaleDB  │────▶│ Grafana │
├─────────────┤  │     └──────────────┘     └──────────────┘     └─────────┘
│Intervals.icu│──┤        (provider           (fitness schema)
├─────────────┤  │         plugins)
│  Withings   │──┘
└─────────────┘
```

Each data source is a **provider plugin** that implements a simple interface. The sync runner orchestrates all enabled providers. Data lands in a `fitness` Postgres schema that Grafana queries directly. Sync runs as a one-shot container triggered by a server cron job.

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

The sync container runs as a one-shot job triggered by cron on the server:

```bash
# Every 6 hours
0 */6 * * * docker compose -f /path/to/health-data/docker-compose.yml run --rm sync
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

- [x] Apple Health XML parser (HR streams, HRV, sleep stages, workouts, body measurements)
- [ ] Apple Health automated import (iOS Shortcut → HTTP upload endpoint)
- [ ] Apple Health workout routes (GPS data from WorkoutRoute elements)
- [x] Clinical/lab data ingestion (Apple Health FHIR clinical records — 1,173 lab results)
- [x] Nutrition data ingestion (FatSecret provider — per-food-item granularity with full micro/macronutrients)
- [x] Supplement tracking (auto-supplements provider reads config, inserts daily; `category` enum distinguishes supplements from food)
- [ ] Cross-provider deduplication via materialized views (prefer direct-provider data over Apple Health)
- [ ] CLI for authenticating, pulling, and managing providers
- [ ] Automated analysis and insights generation
- [ ] Grafana dashboard templates
- [ ] Continuous aggregates for long-range trends
- [ ] Progress indicator for Apple Health imports (file size / record count progress)
- [x] Peloton direct provider (automated Auth0 login, workouts + performance metrics)
- [ ] RideWithGPS provider (routes, rides)

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

- **TypeScript** — sync scripts and provider plugins
- **Drizzle ORM** — type-safe schema and migrations
- **TimescaleDB** — Postgres with time-series extensions (hypertables, continuous aggregates, compression)
- **Vitest** — testing
- **Docker** — deployment
