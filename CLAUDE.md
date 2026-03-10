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
- **Ask about trade-offs**: When there are design decisions with multiple valid approaches (e.g., completeness vs simplicity, stability vs features), always ask the user rather than making assumptions. Don't cut corners without asking first.
- **Commit regularly**: Commit at regular intervals — after each meaningful chunk of work (new feature, passing tests, refactor). Don't let changes accumulate.
- **Document as you go**: Keep README.md and docs/ updated with every significant change.
- **Run migrations**: After generating a migration from schema changes, always run `pnpm migrate` yourself — don't tell the user to do it.

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
