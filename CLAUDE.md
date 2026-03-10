# Health Data

Provider-agnostic fitness/health data pipeline. Syncs data from various providers (Hevy, Wahoo, Intervals.icu, etc.) into a TimescaleDB database for Grafana dashboards.

## Stack
- TypeScript + Drizzle ORM
- TimescaleDB (Postgres + time-series extensions)
- Vitest for testing
- Docker for deployment

## Development Rules
- **TDD**: Write tests first, then implement. Every new feature or provider starts with a failing test.
- **Provider-agnostic**: The schema and sync framework must not be coupled to any specific provider. Providers implement a plugin interface.
- **Document as you go**: Keep README.md and docs/ updated with every significant change.

## Commands
- `pnpm test` — run tests
- `pnpm test:watch` — run tests in watch mode
- `pnpm dev` — run sync in dev mode
- `pnpm generate` — generate Drizzle migrations from schema changes
- `pnpm migrate` — apply migrations

## Package Manager
- **Always use pnpm** — never npm or yarn

## Project Structure
```
src/
  db/schema.ts         — Drizzle schema (source of truth for DB)
  db/index.ts          — DB connection
  providers/types.ts   — Provider plugin interface
  providers/           — Provider implementations
  sync/runner.ts       — Sync orchestrator
  index.ts             — CLI entry point
drizzle/               — Generated migrations
docker-compose.yml     — TimescaleDB
```
