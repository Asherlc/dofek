# Health Data

> **Canonical agent guidelines.** agents.md is the source of truth. Other agent config files (CLAUDE.md, GEMINI.md, etc.) are symlinked to it.

Provider-agnostic fitness/health data pipeline. Syncs data from various providers (Wahoo, WHOOP, Garmin, Peloton, etc.) into a TimescaleDB database with a built-in web dashboard and iOS app.

## Stack
- TypeScript + Drizzle ORM
- TimescaleDB (Postgres + time-series extensions)
- Vitest for testing
- Docker for deployment

## General
- **Read README.md first**: Before working on deployment, infrastructure, or operational tasks, always read the README for current architecture, deployment procedures, and operational runbooks. The README is the source of truth for how the production system works.
- **"I can't see a provider" means it's broken**: When the user says they can't see a provider in the UI, it means the provider is failing validation and being hidden. The fix is to debug **why** the provider's `validate()` fails (missing env vars, bad config, etc.) — not to show disabled providers. Disabled providers are intentionally hidden from users. Use the `/fix-provider` skill to diagnose and fix.

## Debugging
- **Instrumentation first**: When debugging a production issue, before attempting a fix, verify that we have working instrumentation (logs, metrics, traces) to confirm the diagnosis. If logs aren't reaching the observability platform, or the relevant code path has no logging, fix that first. A confident fix requires confident evidence — don't guess at root causes when you can instrument and observe. If you find yourself saying "likely", "probably", or "most likely", that's a signal you need more observability — add logging/tracing to confirm the hypothesis before writing a fix.

## Development Rules
- **Server-side metric computation**: All metric values must be computed on the server — never derive, aggregate, or transform metric data in web or iOS client code. The API response should contain every value the UI needs to display. Clients are responsible only for rendering (colors, labels, formatting, layout) — not for computing the numbers they display. This prevents inconsistencies when the same metric appears on multiple screens or platforms. If a client is calling a scoring/calculation function on raw data from the API, that calculation belongs in the server router instead.
- **Good architecture and modeling**: Actively look for opportunities to decouple code, model real-world concepts as proper classes/types, use common interfaces, and apply SOLID principles with domain-driven design. When you see scattered logic that represents a single concept (e.g., "is this provider connected?"), extract it into a model or interface rather than leaving it inline. Prefer domain-driven abstractions over ad-hoc checks spread across the codebase. Follow SOLID principles: single responsibility (each class/module does one thing), open/closed (extend via composition, not modification), Liskov substitution (subtypes must be substitutable), interface segregation (small, focused interfaces), and dependency inversion (depend on abstractions, not concretions). Prefer composition over inheritance — build complex behavior by combining simple, focused components rather than deep class hierarchies. Use dependency injection, strategy patterns, and mixins instead of base classes.
- **Dual-platform parity (web + mobile)**: Every feature, bug fix, and UI change must be implemented on both `packages/web` and `packages/mobile`. When adding a new page, chart, or data view to one platform, implement the equivalent on the other in the same PR. Shared logic lives in domain-specific packages (`@dofek/format`, `@dofek/scoring`, `@dofek/nutrition`, `@dofek/training`, `@dofek/stats`, `@dofek/onboarding`, `@dofek/providers`) — import from there instead of duplicating. Platform-specific code (HealthKit, barcode scanning, Expo secure storage, ECharts vs react-native-svg) stays in the respective package. When reviewing PRs, check that both platforms are updated.
- **Always report errors to Sentry**: Never silently swallow errors or only log them. Every `catch` block that handles an unexpected error must call `captureException()` (from `./telemetry` in mobile, or the equivalent in server code) so failures are visible in our error monitoring. Silent `catch(() => {})` blocks are banned — they hide bugs and make debugging impossible.
- **Fix properly, no workarounds**: When encountering an issue, fix the root cause. Lint rules, type checks, and CI gates exist for a reason — don't disable them, skip them, add ignores, or use workarounds to make problems go away. Always do the harder thing that actually solves the problem. If you genuinely cannot fix the root cause, **stop and ask the user before** resorting to any shortcut, disable, or workaround. Never take the "easy" or "efficient" way out without explicit approval.
- **TDD**: Write tests first, then implement. Every new feature or provider starts with a failing test. When fixing bugs, write a failing test that reproduces the bug before writing the fix. If a PR touches code that lacks tests, add tests for the changed behavior — never dismiss missing coverage as "pre-existing" or "not introduced by this PR." For SQL/query bugs, write integration tests against a real database; don't dismiss them as untestable because unit tests mock the DB.
- **Production code drives, tests adapt**: Never add hacks, indirection, or complexity to production code just to make tests easier. No lazy initialization to avoid connections in tests, no conditional logic gated on `NODE_ENV === 'test'`, no runtime feature flags for testability. Tests should use mocks, dependency injection, or module-level mocking (`vi.mock`) to work around production code — not the other way around. If production code needs restructuring to be testable, that restructuring should also improve the production design (e.g., proper DI).
- **No exports just for testability**: Never export a function, class, or variable solely because a test needs to access it. Exports define the public API of a module — every export should serve a production consumer. If a test needs to verify internal behavior, test it through the public interface instead. Comments like "exported for testing" are a code smell — if it's worth exporting, it's worth exporting for production use too.
- **Colocated unit tests**: Unit test files live next to the source file they test, named `<source>.test.ts`. Do not use `__tests__/` directories. For example, `src/db/tokens.ts` has its unit test at `src/db/tokens.test.ts`. Integration tests (`*.integration.test.ts`) can live wherever makes sense.
- **Test separation**: Unit tests use `*.test.ts`, integration tests use `*.integration.test.ts`. Unit tests must never need access to external services (databases, APIs). Integration tests must never mock at the module level (`vi.mock`). For 3rd party services in integration tests, mock at the network level with [MSW](https://mswjs.io/) (`setupServer` from `msw/node`), not with constructor-injected fetch or `vi.spyOn(globalThis, 'fetch')`.
- **Provider-agnostic**: The schema and sync framework must not be coupled to any specific provider. Providers implement a plugin interface.
- **Isolated & modular providers**: Each provider must be self-contained in its own file under `src/providers/`. Providers implement the `Provider` interface from `types.ts` and must not depend on other providers. All provider-specific types, parsing, API client code, and sync logic live within the provider's own file. This keeps providers easy to add, remove, or modify independently.
- **Raw data only, no duplicate sources of truth**: Only store raw data — never store computed or aggregate values that can be derived from raw data. If a value is computable from existing data (averages, totals, durations, start/end times), don't store it. Be ruthless about this. Every column must earn its place by being genuinely raw or structural (e.g., activity type, name) and not derivable from other stored data.
- **Deduplicate at query time, not insert time**: Never filter, merge, or discard data during ingestion. Store all raw records from all sources with their source attribution intact (e.g., per-source daily totals, not a naive sum across sources). Deduplication belongs in materialized views or queries — not in insert pipelines. This preserves the ability to re-derive correct values when dedup logic improves and avoids irreversible data loss. For example, when Apple Health reports steps from both iPhone and Apple Watch, store each source's daily total separately and let the view pick the best source — don't sum them at insert time.
- **No empty strings as absent values**: Never use empty strings (`""`) to represent missing or absent data — use `null` or `undefined` instead. Empty strings are ambiguous: they look like "has a value" but semantically mean "no value." This applies to both database columns (use nullable columns, not `NOT NULL DEFAULT ''`) and application code (use `null`/`undefined`, not `""`). Empty strings are fine when they carry genuine meaning (string concatenation, protocol requirements, form inputs).
- **No `any` types**: Never use `any` in TypeScript. Use proper types, generics, `unknown`, or type assertions with specific types instead. If a type is complex, define an interface — but never `any`.
- **Minimize `as` type assertions**: Avoid `as Type` casts whenever possible — they bypass the type checker. Prefer type narrowing (type guards, `instanceof`, discriminated unions), generics, or `satisfies`. When `as` is truly unavoidable (e.g., tRPC raw SQL results before proper typing is added), document why. Biome cannot enforce this automatically, so treat it as a code review convention. Never use `as any`, `as never`, or `as unknown as X` (double-cast) — these are strictly banned (enforced by the `plugins/no-double-cast.grit` Biome plugin).
- **Zod for runtime data boundaries**: Use Zod schemas to parse and validate any data whose shape TypeScript cannot guarantee at runtime — API responses, database query results, uploaded files, webhook payloads, browser messages (postMessage, BroadcastChannel), and any other data that crosses a boundary where the compiler cannot verify the type. Prefer `executeWithSchema()` (from `packages/server/src/lib/typed-sql.ts`) over `db.execute<T>()` generics for raw SQL queries. TypeScript generics only provide compile-time safety; Zod catches runtime shape mismatches.
- **Avoid acronyms and single-letter variables**: Use descriptive names instead of acronyms or single-letter variables for variables, parameters, types, and interfaces. Common unit abbreviations are fine (lbs, mg, km, etc.), but domain-specific acronyms should be spelled out. Single-letter variable names are never descriptive enough — use a meaningful name instead. For example, use `CriticalPowerModel` not `CpModel`, `heartRateTrainingStressScore` not `hrTSS`, `const micronutrients = ...` not `const n = ...`. The only exception is `_` for intentionally unused bindings. Enforced by the `plugins/no-single-letter-variables.grit` Biome plugin.
- **Layman-readable UI text**: All user-facing text — chart titles, axis labels, legends, tooltips, badges, empty states, and explanatory captions — must be understandable without domain expertise. Never use unexpanded acronyms (CTL, ATL, TSB, ACWR, FTP, HRV, EF, NP, VI, IF, PI, CP, W', etc.) as standalone labels. Either spell them out ("Fitness" not "CTL", "Heart Rate Variability" not "HRV") or put the acronym in parentheses after the readable name ("Fitness (CTL)"). Abbreviations for units (W, bpm, ms, km) are fine.
- **Storybook stories for every component**: Every React component in `packages/web/src/components/` and `packages/mobile/components/` must have a colocated `.stories.tsx` file. When adding or modifying a component, add or update its Storybook stories in the same PR. Stories should cover: default state, loading state, empty/no-data state, and any significant visual variants. Context providers (e.g., `DashboardLayoutProvider`) and non-visual utilities are exempt.
- **No coverage exclusions for convenience**: Never exclude source files from code coverage just to keep thresholds high. If a file has low coverage, write tests for it — don't hide it. The only legitimate coverage exclusions are test files themselves, test helpers, fixture files, and `node_modules/`.
- **No barrel files**: Never create `index.ts` barrel/re-export files when decomposing modules into directories. Barrel files add indirection, slow down tooling, and make import paths less explicit. When splitting a large file into a directory of smaller files, update all import sites to point directly at the specific submodule file (e.g., `import { OuraClient } from "./oura/client.ts"`, not `import { OuraClient } from "./oura/index.ts"`).
- **Max 1000 lines per file**: No TypeScript file should exceed 1000 lines. If a file is approaching that limit, proactively split it into smaller, focused modules before it grows further. When creating new code, plan the module structure so individual files stay well under 1000 lines.
- **Ask about trade-offs**: When there are design decisions with multiple valid approaches (e.g., completeness vs simplicity, stability vs features), always ask the user rather than making assumptions. Don't cut corners without asking first.
- **Commit regularly**: Commit at regular intervals — after each meaningful chunk of work (new feature, passing tests, refactor). Don't let changes accumulate.
- **Always push after commit**: Push to remote after every commit so CI runs and changes are backed up.
- **Pre-push checks**: Before every push, run `pnpm lint`, `pnpm test:changed`, and typecheck all packages (`pnpm tsc --noEmit`, `cd packages/server && pnpm tsc --noEmit`, `cd packages/web && pnpm tsc --noEmit`). CI runs the full test suite, but never push code that fails lint, changed-test coverage, or type checking.
- **Test Docker changes locally end-to-end**: Before pushing Dockerfile or entrypoint changes, do a full local test — not just image builds. Run the server container against a real database and verify it starts, runs migrations, serves API responses, and serves the SPA:
  ```bash
  # Build the server image
  docker build --target server -t dofek-server:local .
  # Stand up a test DB and run the server
  docker network create dofek-test
  docker run -d --name dofek-test-db --network dofek-test \
    -e POSTGRES_DB=health -e POSTGRES_USER=health -e POSTGRES_PASSWORD=test \
    timescale/timescaledb:latest-pg16
  sleep 5
  docker run -d --name dofek-test-web --network dofek-test -p 3000:3000 \
    -e DATABASE_URL=postgres://health:test@dofek-test-db:5432/health -e PORT=3000 \
    dofek-server:local web
  sleep 8
  docker logs dofek-test-web  # should show migrations + "API running"
  curl http://localhost:3000/  # should return index.html (SPA)
  curl http://localhost:3000/healthz  # should return {"status":"ok"}
  # Clean up
  docker rm -f dofek-test-web dofek-test-db
  docker network rm dofek-test
  ```
- **Document as you go**: Keep README.md and docs/ updated with every significant change. When learning about external APIs, data formats, auth protocols, or provider quirks, write notes in `docs/` (e.g., `docs/peloton.md`, `docs/apple-health.md`). These notes help future development and debugging.
- **Run migrations**: After generating a migration from schema changes, always run `pnpm migrate` yourself — don't tell the user to do it.
- **Never modify repo settings**: Never change GitHub branch protection rules, required status checks, repo rulesets, or any other repository-level settings via the API or CLI. If branch protection is blocking a merge, ask the user how to proceed.
- **No manual server changes**: Never SSH into the server to edit config files directly. All server config changes must go through Dokploy (UI or API) or Terraform. See the README for details. SSH is allowed for **debugging** (reading logs, checking container status, inspecting state) but not for making changes — the fix must be a code/infrastructure change that handles the failure automatically.
- **Drizzle generate is interactive**: `pnpm generate` (`drizzle-kit generate`) prompts interactively when it detects potential table/column renames. Since CLI tools can't handle interactive prompts, write migration SQL files manually when `generate` would prompt. Name them sequentially (e.g., `drizzle/0012_description.sql`). Use `ALTER TABLE ... ADD COLUMN` for new columns, etc. Always run `pnpm migrate` after creating manual migrations.

## Code Review
- **Flag linter-catchable issues**: During code reviews, still flag violations even if they would be caught by a linter. Do not skip issues just because a linter or Biome plugin enforces them — the review should catch everything, not defer to CI.

## Commands
- `pnpm test` — run tests
- `pnpm test:changed` — run tests affected by files changed from `origin/main`
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
- **GitHub Actions** runs on every push/PR: lint, typecheck, knip, test (unit + integration with coverage), e2e (Docker-based), mutation (Stryker, PR-only).
- **Use the `gh` CLI** to check build status and read job logs — never scrape the web UI or use raw API calls with curl. Example: `gh run list`, `gh run view <id>`. See `docs/ci-debugging.md` for how to extract actual error messages from truncated CI logs (especially iOS builds where xcodebuild output is piped through `tail -40`).
- **Periodically check CI runs** to catch failures early. Before starting work, check if CI is green.

## Package Manager
- **Always use pnpm** — never npm or yarn

## Project Structure
```
src/                         — Root package: sync runner, providers, DB schema
  db/schema.ts               — Drizzle schema (source of truth for DB)
  db/index.ts                — DB connection
  providers/types.ts         — Provider plugin interface
  providers/                 — Provider implementations (30 providers)
  index.ts                   — CLI entry point (enqueues sync via BullMQ)
packages/
  format/src/                — @dofek/format: date, duration, number, unit formatting
  scoring/src/               — @dofek/scoring: score colors, labels, workload helpers
  nutrition/src/             — @dofek/nutrition: meal types, auto-meal detection
  training/src/              — @dofek/training: activity types, weekly volume
  stats/src/                 — @dofek/stats: correlation, regression analysis
  recovery/src/              — @dofek/recovery: recovery metrics and scoring
  onboarding/src/            — @dofek/onboarding: onboarding flow logic
  providers-meta/src/        — @dofek/providers: provider display labels
  zones/src/                 — @dofek/zones: HR/power zone calculations
  auth/src/                  — @dofek/auth: shared authentication logic
  heart-rate-variability/src/ — @dofek/heart-rate-variability: HRV analysis
  server/src/                — dofek-server: Express + tRPC API + BullMQ jobs (Node)
    routers/                 — tRPC route handlers
    index.ts                 — Express server entry point
  web/src/                   — dofek-web: Vite + React SPA (browser)
    components/              — React components (ECharts, shadcn/ui, Tailwind)
    pages/                   — Route pages
    lib/trpc.ts              — tRPC client (imports AppRouter from dofek-server)
  mobile/                    — dofek-mobile: Expo + React Native app
    app/                     — Expo Router screens (file-based routing)
    components/              — React Native components (SVG charts)
    lib/                     — Auth, tRPC client, HealthKit integration
    modules/health-kit/      — Native Swift HealthKit module
  whoop-whoop/               — RE'd WHOOP internal API client
  eight-sleep/               — RE'd Eight Sleep internal API client
  zwift-client/              — RE'd Zwift internal API client
  trainerroad-client/        — RE'd TrainerRoad internal API client
  velohero-client/           — RE'd VeloHero API client
  garmin-connect/            — RE'd Garmin Connect SSO + API client
  trainingpeaks-connect/     — RE'd TrainingPeaks internal API client
cypress/                     — E2E tests (Cypress)
drizzle/                     — SQL migrations
deploy/                      — Terraform (Hetzner + Cloudflare) + Dokploy setup
Dockerfile                   — Multi-stage: server target (includes built web assets)
```
