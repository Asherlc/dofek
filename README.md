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

# Run sync (requires provider API keys in .env)
cp .env.example .env
# Edit .env with your API keys
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

## Roadmap

- [x] Apple Health XML parser (HR streams, HRV, sleep stages, workouts, body measurements)
- [ ] Apple Health automated import (iOS Shortcut → HTTP upload endpoint)
- [ ] Apple Health workout routes (GPS data from WorkoutRoute elements)
- [ ] Clinical/lab data ingestion (Apple Health clinical records, MyChart/Kaiser FHIR, lab results)
- [ ] Nutrition data ingestion
- [ ] Supplement tracking (investigate whether nutrition source covers this or needs a dedicated source)
- [ ] Cross-provider deduplication via materialized views (prefer direct-provider data over Apple Health)
- [ ] CLI for authenticating, pulling, and managing providers
- [ ] Automated analysis and insights generation
- [ ] Grafana dashboard templates
- [ ] Continuous aggregates for long-range trends
- [ ] Progress indicator for Apple Health imports (file size / record count progress)
- [x] Peloton direct provider (automated Auth0 login, workouts + performance metrics)
- [ ] RideWithGPS provider (routes, rides)

## Stack

- **TypeScript** — sync scripts and provider plugins
- **Drizzle ORM** — type-safe schema and migrations
- **TimescaleDB** — Postgres with time-series extensions (hypertables, continuous aggregates, compression)
- **Vitest** — testing
- **Docker** — deployment
