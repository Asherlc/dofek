# Health Data

Provider-agnostic fitness/health data pipeline. Syncs data from various providers (Wahoo, Intervals.icu, etc.) into a TimescaleDB database for Grafana dashboards.

## Stack
- TypeScript + Drizzle ORM
- TimescaleDB (Postgres + time-series extensions)
- Vitest for testing
- Docker for deployment

## General
- **Read README.md first**: Before working on deployment, infrastructure, or operational tasks, always read the README for current architecture, deployment procedures, and operational runbooks. The README is the source of truth for how the production system works.
- **"I can't see a provider" means it's broken**: When the user says they can't see a provider in the UI, it means the provider is failing validation and being hidden. The fix is to debug **why** the provider's `validate()` fails (missing env vars, bad config, etc.) — not to show disabled providers. Disabled providers are intentionally hidden from users. Use the `/fix-provider` skill to diagnose and fix.

## Development Rules
- **Fix properly, no workarounds**: When encountering an issue, fix the root cause. Lint rules, type checks, and CI gates exist for a reason — don't disable them, skip them, add ignores, or use workarounds to make problems go away. Always do the harder thing that actually solves the problem. If you genuinely cannot fix the root cause, **stop and ask the user before** resorting to any shortcut, disable, or workaround. Never take the "easy" or "efficient" way out without explicit approval.
- **TDD**: Write tests first, then implement. Every new feature or provider starts with a failing test. When fixing bugs, write a failing test that reproduces the bug before writing the fix.
- **Colocated unit tests**: Unit test files live next to the source file they test, named `<source>.test.ts`. Do not use `__tests__/` directories. For example, `src/db/tokens.ts` has its unit test at `src/db/tokens.test.ts`. Integration tests (`*.integration.test.ts`) can live wherever makes sense.
- **Test separation**: Unit tests use `*.test.ts`, integration tests use `*.integration.test.ts`. Unit tests must never need access to external services (databases, APIs). Integration tests must never mock at the module level (`vi.mock`). For 3rd party services in integration tests, mock at the network level with [MSW](https://mswjs.io/) (`setupServer` from `msw/node`), not with constructor-injected fetch or `vi.spyOn(globalThis, 'fetch')`.
- **Provider-agnostic**: The schema and sync framework must not be coupled to any specific provider. Providers implement a plugin interface.
- **Isolated & modular providers**: Each provider must be self-contained in its own file under `src/providers/`. Providers implement the `Provider` interface from `types.ts` and must not depend on other providers. All provider-specific types, parsing, API client code, and sync logic live within the provider's own file. This keeps providers easy to add, remove, or modify independently.
- **Raw data only, no duplicate sources of truth**: Only store raw data — never store computed or aggregate values that can be derived from raw data. If a value is computable from existing data (averages, totals, durations, start/end times), don't store it. Be ruthless about this. Every column must earn its place by being genuinely raw or structural (e.g., activity type, name) and not derivable from other stored data.
- **No `any` types**: Never use `any` in TypeScript. Use proper types, generics, `unknown`, or type assertions with specific types instead. If a type is complex, define an interface — but never `any`.
- **Minimize `as` type assertions**: Avoid `as Type` casts whenever possible — they bypass the type checker. Prefer type narrowing (type guards, `instanceof`, discriminated unions), generics, or `satisfies`. When `as` is truly unavoidable (e.g., tRPC raw SQL results before proper typing is added), document why. Biome cannot enforce this automatically, so treat it as a code review convention. Never use `as any`, `as never`, or `as unknown as X` (double-cast) — these are strictly banned (enforced by the `plugins/no-double-cast.grit` Biome plugin).
- **Zod for runtime data boundaries**: Use Zod schemas to parse and validate any data whose shape TypeScript cannot guarantee at runtime — API responses, database query results, uploaded files, webhook payloads, browser messages (postMessage, BroadcastChannel), and any other data that crosses a boundary where the compiler cannot verify the type. Prefer `executeWithSchema()` (from `packages/server/src/lib/typed-sql.ts`) over `db.execute<T>()` generics for raw SQL queries. TypeScript generics only provide compile-time safety; Zod catches runtime shape mismatches.
- **Avoid acronyms in code**: Use descriptive names instead of acronyms for variables, types, and interfaces. Common unit abbreviations are fine (lbs, mg, km, etc.), but domain-specific acronyms should be spelled out. For example, use `CriticalPowerModel` not `CpModel`, `heartRateTrainingStressScore` not `hrTSS`.
- **Layman-readable UI text**: All user-facing text — chart titles, axis labels, legends, tooltips, badges, empty states, and explanatory captions — must be understandable without domain expertise. Never use unexpanded acronyms (CTL, ATL, TSB, ACWR, FTP, HRV, EF, NP, VI, IF, PI, CP, W', etc.) as standalone labels. Either spell them out ("Fitness" not "CTL", "Heart Rate Variability" not "HRV") or put the acronym in parentheses after the readable name ("Fitness (CTL)"). Abbreviations for units (W, bpm, ms, km) are fine.
- **No coverage exclusions for convenience**: Never exclude source files from code coverage just to keep thresholds high. If a file has low coverage, write tests for it — don't hide it. The only legitimate coverage exclusions are test files themselves, test helpers, fixture files, and `node_modules/`.
- **Ask about trade-offs**: When there are design decisions with multiple valid approaches (e.g., completeness vs simplicity, stability vs features), always ask the user rather than making assumptions. Don't cut corners without asking first.
- **Commit regularly**: Commit at regular intervals — after each meaningful chunk of work (new feature, passing tests, refactor). Don't let changes accumulate.
- **Always push after commit**: Push to remote after every commit so CI runs and changes are backed up.
- **Pre-push checks**: Before every push, run `pnpm lint`, `pnpm test`, and typecheck all packages (`pnpm tsc --noEmit`, `cd packages/server && pnpm tsc --noEmit`, `cd packages/web && pnpm tsc --noEmit`). Never push code that fails lint, tests, or type checking.
- **Test Docker changes locally end-to-end**: Before pushing Dockerfile or entrypoint changes, do a full local test — not just image builds. Run the server container against a real database and verify it starts, runs migrations, and serves API responses. Run the client container and verify it serves HTML and the SPA fallback works:
  ```bash
  # Build both targets
  docker build --target server -t dofek-server:local .
  docker build --target client -t dofek-client:local .
  # Stand up a test DB and run the server
  docker network create dofek-test
  docker run -d --name dofek-test-db --network dofek-test \
    -e POSTGRES_DB=health -e POSTGRES_USER=health -e POSTGRES_PASSWORD=test \
    timescale/timescaledb:latest-pg16
  sleep 5
  docker run -d --name dofek-test-web --network dofek-test \
    -e DATABASE_URL=postgres://health:test@dofek-test-db:5432/health -e PORT=3000 \
    dofek-server:local web
  sleep 8
  docker logs dofek-test-web  # should show migrations + "API running"
  # Test client serves HTML
  docker run -d --name dofek-test-client --network dofek-test -p 8888:80 dofek-client:local
  curl http://localhost:8888/  # should return index.html
  # Clean up
  docker rm -f dofek-test-web dofek-test-client dofek-test-db
  docker network rm dofek-test
  ```
- **Document as you go**: Keep README.md and docs/ updated with every significant change. When learning about external APIs, data formats, auth protocols, or provider quirks, write notes in `docs/` (e.g., `docs/peloton.md`, `docs/apple-health.md`). These notes help future development and debugging.
- **Run migrations**: After generating a migration from schema changes, always run `pnpm migrate` yourself — don't tell the user to do it.
- **Never modify repo settings**: Never change GitHub branch protection rules, required status checks, repo rulesets, or any other repository-level settings via the API or CLI. If branch protection is blocking a merge, ask the user how to proceed.
- **No manual server changes**: Never SSH into the server to edit config files directly. All server config changes (`docker-compose.yml`, `Caddyfile`) must go through Terraform (`cd deploy/deploy-config && terraform apply -var="server_ip=<IP>"`). See the README for details.
- **Drizzle generate is interactive**: `pnpm generate` (`drizzle-kit generate`) prompts interactively when it detects potential table/column renames. Since CLI tools can't handle interactive prompts, write migration SQL files manually when `generate` would prompt. Name them sequentially (e.g., `drizzle/0012_description.sql`). Use `ALTER TABLE ... ADD COLUMN` for new columns, etc. Always run `pnpm migrate` after creating manual migrations.

## Commands
- `pnpm test` — run tests
- `pnpm test:watch` — run tests in watch mode
- `pnpm dev` — run sync in dev mode
- `pnpm generate` — generate Drizzle migrations from schema changes
- `pnpm migrate` — apply migrations
- `cd packages/web && pnpm dev` — run Vite dev server (proxies /api to Express)
- `cd packages/server && pnpm dev` — run Express API server
- `pnpm lint` — run Biome linter
- `pnpm lint:fix` — auto-fix lint issues
- `pnpm format` — format code with Biome

## CI
- **CircleCI** runs on every push/PR: install, check (lint + typecheck + web build), test (unit + integration with coverage), e2e (Docker-based), mutation (Stryker, PR-only).
- **Use the `circleci` CLI** to check build status and read job logs — never scrape the web UI or use raw API calls with curl. Example: `circleci pipeline list <project-id>`.
- **Periodically check CI runs** to catch failures early. Before starting work, check if CI is green.

## Package Manager
- **Always use pnpm** — never npm or yarn

## Project Structure
```
src/                         — Root package: sync runner, providers, DB schema
  db/schema.ts               — Drizzle schema (source of truth for DB)
  db/index.ts                — DB connection
  providers/types.ts         — Provider plugin interface
  providers/                 — Provider implementations
  sync/runner.ts             — Sync orchestrator
  index.ts                   — CLI entry point
packages/
  server/src/                — dofek-server: Express + tRPC API (Node)
    routers/                 — tRPC route handlers
    index.ts                 — Express server entry point
  web/src/                   — dofek-web: Vite + React SPA (browser)
    components/              — React components (ECharts, shadcn/ui, Tailwind)
    pages/                   — Route pages
    lib/trpc.ts              — tRPC client (imports AppRouter from dofek-server)
drizzle/                     — SQL migrations
Dockerfile                   — Multi-stage: server + client targets
nginx.conf                   — Nginx config (static files + API proxy)
```
