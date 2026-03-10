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
- **Isolated & modular providers**: Each provider must be self-contained in its own file under `src/providers/`. Providers implement the `Provider` interface from `types.ts` and must not depend on other providers. All provider-specific types, parsing, API client code, and sync logic live within the provider's own file. This keeps providers easy to add, remove, or modify independently.
- **Raw data only, no duplicate sources of truth**: Only store raw data — never store computed or aggregate values that can be derived from raw data. If a value is computable from existing data (averages, totals, durations, start/end times), don't store it. Be ruthless about this. Every column must earn its place by being genuinely raw or structural (e.g., activity type, name) and not derivable from other stored data.
- **Ask about trade-offs**: When there are design decisions with multiple valid approaches (e.g., completeness vs simplicity, stability vs features), always ask the user rather than making assumptions. Don't cut corners without asking first.
- **Commit regularly**: Commit at regular intervals — after each meaningful chunk of work (new feature, passing tests, refactor). Don't let changes accumulate.
- **Always push after commit**: Push to remote after every commit so CI runs and changes are backed up.
- **Document as you go**: Keep README.md and docs/ updated with every significant change. When learning about external APIs, data formats, auth protocols, or provider quirks, write notes in `docs/` (e.g., `docs/peloton.md`, `docs/apple-health.md`). These notes help future development and debugging.
- **Run migrations**: After generating a migration from schema changes, always run `pnpm migrate` yourself — don't tell the user to do it.

## Commands
- `pnpm test` — run tests
- `pnpm test:watch` — run tests in watch mode
- `pnpm dev` — run sync in dev mode
- `pnpm generate` — generate Drizzle migrations from schema changes
- `pnpm migrate` — apply migrations
- `pnpm lint` — run Biome linter
- `pnpm lint:fix` — auto-fix lint issues
- `pnpm format` — format code with Biome

## CI
- GitHub Actions CI runs on every push/PR to main: lint, typecheck, unit tests, integration tests, web build.
- **Periodically check GHA runs** to catch failures early. Before starting work, check if CI is green.

## Package Manager
- **Always use pnpm** — never npm or yarn

## Project Structure
```
src/                     — Pipeline (sync, providers, CLI)
  db/schema.ts           — Drizzle schema (source of truth for DB)
  db/index.ts            — DB connection
  providers/types.ts     — Provider plugin interface
  providers/             — Provider implementations
  sync/runner.ts         — Sync orchestrator
  index.ts               — CLI entry point
web/                     — React dashboard (Vite + tRPC)
  src/client/            — React frontend (ECharts, shadcn/ui, Tailwind)
  src/server/            — Express + tRPC API server
  src/shared/            — Shared tRPC types
drizzle/                 — Generated migrations
.github/workflows/       — CI (lint, test, build)
docker-compose.yml       — TimescaleDB
```
