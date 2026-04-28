# Health Data

> **Canonical agent guidelines.** AGENTS.md is the source of truth. Other agent config files (CLAUDE.md, GEMINI.md, etc.) are symlinked to it.

Provider-agnostic fitness/health data pipeline. Syncs data from various providers (Wahoo, WHOOP, Garmin, Peloton, etc.) into a TimescaleDB database with a built-in web dashboard and iOS app.

## Stack
- TypeScript + Drizzle ORM
- TimescaleDB (Postgres + time-series extensions)
- Vitest for testing
- Docker for deployment

## General
- **Apply minimum fix**: Only perform the minimum fix required to resolve the issue at hand. Do not add extra error handling, validation, or infrastructure unless explicitly requested. The user will ask if they want more far-reaching changes.
- **Consistency over duplicate tools**: Do not add or keep multiple dependencies that solve the same problem in the same area of the codebase. Choose one canonical library/tool and migrate remaining call sites to it rather than carrying parallel options.
- **No branch switching without approval**: Never switch branches (`git checkout`, `git switch`, creating a new local branch from another branch, or rebasing onto another branch) unless the user explicitly approves it first.
- **YAGNI first**: Follow "You Aren't Gonna Need It" — do not add abstractions, options, flags, or future-proofing for hypothetical needs unless there is a current, concrete requirement.
- **Ask before deviating from YAGNI**: If a non-YAGNI change appears important, stop and ask the user before implementing it.
- **Prefer elegant solutions**: Favor clear, maintainable, first-principles fixes over ad-hoc patches or layered self-healing workarounds. If a fix feels hacky, stop and propose a cleaner alternative.
- **Check with user before choosing approach**: Before committing to a specific implementation approach, strategy, or workaround for a non-trivial task, confirm the direction with the user first. Do not independently choose a strategy and run with it without user alignment.
- **Persist on chosen strategy; ask before pivoting**: When pursuing a specific user-requested strategy/tactic, continue until you have exhausted reasonable debugging and implementation options for that strategy. Do not switch to a different approach on your own. If the strategy appears blocked after reasonable attempts, stop and check with the user before pivoting.
- **Strategy pivot hook (mandatory stop gate)**: Before changing strategy, run this gate in your own response: (1) state the current strategy, (2) list attempted steps and evidence, (3) explain exactly why it is blocked, (4) propose one alternative strategy, (5) ask for approval in one sentence. Do not execute the alternative strategy, run additional commands for it, or make code changes for it until the user explicitly approves.
- **Read README.md first**: Before working on deployment, infrastructure, or operational tasks, always read the README for current architecture, deployment procedures, and operational runbooks. The README is the source of truth for how the production system works.
- **Mirror agent config files with symlinks**: Every directory that contains an `AGENTS.md` file must also contain `CLAUDE.md` and `GEMINI.md` symlinked to `AGENTS.md` (same directory). Keep these in sync whenever adding or moving agent guidance files.
- **No commented-out dead code/config**: Do not leave commented-out code, workflow jobs, config blocks, or TODO-disabled paths unless the user explicitly asks for that. If something is being removed, delete it fully.
- **"I can't see a provider" means it's broken**: When the user says they can't see a provider in the UI, it means the provider is failing validation and being hidden. The fix is to debug **why** the provider's `validate()` fails (missing env vars, bad config, etc.) — not to show disabled providers. Disabled providers are intentionally hidden from users. Use the `/fix-provider` skill to diagnose and fix.
- **Always use latest versions**: When adding or updating any dependency, Docker image, service, artifact, or tool, always use the latest stable version available. Check for the current latest version rather than copying an older version from elsewhere in the codebase. Pin to specific versions in production (e.g., `timescale/timescaledb:2.26.2-pg18`, not `latest`), but those pinned versions should be the newest stable release at the time of the change.
- **Use TypeScript for repository scripts**: New or updated repository automation scripts must be written in TypeScript (`.ts`) and run with `pnpm tsx`. Do not add new Python scripts for repo tooling unless the work is explicitly inside the Python ML package (`packages/ml`).

## Agent Documentation
- **Local AGENTS.md files**: Packages and logical directories should have their own `AGENTS.md` and `README.md` files.
- **Symlinks**: `AGENTS.md` must be symlinked to `GEMINI.md` and `CLAUDE.md` in the same directory.
- **Agent-only content**: Populate `AGENTS.md` with information useful *only* to an agent.
- **Shared content**: Use `README.md` for information relevant to both agents and humans.
- **Human docs must stand alone**: `README.md` and files in `docs/` must not depend on agent skills, agent-only workflows, or instructions that assume an agent is present.
- **README reference**: `AGENTS.md` must always instruct the agent to read the `README.md`.

## End-of-Task Retrospective
- **Always close with a short retrospective**: At the end of each task, briefly evaluate what went well, what required investigation, what would be useful context next time, and what guidelines were missing or could be refined.
- **Update the production incident baseline**: After any production incident, deploy failure, infrastructure issue, database pressure event, CI/deploy outage, or operational debugging session, append a concise summary to `docs/production-incident-baseline.md`. Capture the date, symptoms, user impact, evidence, root cause if known, fix or mitigation, remaining risk, and follow-up work. If the issue is still unresolved, record it as unresolved rather than omitting it.
- **Propose concrete improvements to the user**: After that retrospective, propose specific updates to `AGENTS.md`, `README.md`, or `docs/` that would have made the task faster, safer, or clearer.
- **Suggest useful skills**: As part of the retrospective, suggest relevant skills that should be used next time for similar tasks (or new skills that should be created if a gap exists).
- **Create a positive feedback loop**: Treat each completed task as input for improving future tasks. Surface suggested wording changes or new runbook notes to the user for approval.

## Debugging
- **Instrumentation first**: When debugging a production issue, before attempting a fix, verify that we have working instrumentation (logs, metrics, traces) to confirm the diagnosis. If logs aren't reaching the observability platform, or the relevant code path has no logging, fix that first. A confident fix requires confident evidence — don't guess at root causes when you can instrument and observe. If you find yourself saying "likely", "probably", or "most likely", that's a signal you need more observability — add logging/tracing to confirm the hypothesis before writing a fix.
- **Diagnose before changing behavior**: When an issue appears, first determine why it is happening and confirm the failure mode with evidence (logs, reproduction, failing check). Do not jump straight to custom transformations, compatibility layers, or workaround-only changes just to make the symptom disappear.
- **Root cause before resilience knobs**: When production is in an error state (for example, DB recovery mode, repeated restarts, failing healthchecks), investigate and fix the underlying cause first. Do not default to adding longer waits, more retries, or broader timeouts in deploy/workflow code as the primary fix. Only add resilience tuning after root cause is identified and addressed, and document why it is still needed.
- **Use the DB incident skill for Postgres outages**: For production DB incidents (`in recovery mode`, restart loops, disk pressure), use `.agents/skills/db-incident-response/SKILL.md` first.
- **Incident fix policy (non-negotiable)**: For CI/deploy/infra incidents, do not ship mitigations (timeouts, retries, sleeps, fallback defaults, `continue-on-error`, warn-and-continue behavior) before identifying the root cause with evidence.
- **Evidence requirement**: Before changing behavior, capture and cite (1) the exact failing command/step, (2) the first fatal log line, and (3) the causal explanation for why that failure occurs.
- **No paper-over PRs**: A fix is incomplete if it only suppresses or delays failure without proving and addressing the underlying cause.
- **Fail loudly on missing prerequisites**: Missing secrets/config must hard-fail immediately with explicit key names; never continue in degraded mode.
- **New env vars require Infisical updates**: Whenever code, config, CI, or infrastructure starts referencing a new environment variable, verify that it already exists in Infisical for the relevant environment(s). If it does not exist, create it before considering the task done. Do not merge or deploy code that references a new env var without ensuring Infisical is updated too.
- **Definition of done for incident fixes**: Include all of the following in the final report: one-sentence root cause, direct fix for that cause, validation run showing success without ad-hoc waits, and a one-line justification for any remaining resilience knob.
- **Escalation rule**: If root cause remains unknown after initial investigation, stop and ask the user for direction instead of improvising workaround behavior.

## Development Rules
- **Server-side metric computation**: All metric values must be computed on the server — never derive, aggregate, or transform metric data in web or iOS client code. The API response should contain every value the UI needs to display. Clients are responsible only for rendering (colors, labels, formatting, layout) — not for computing the numbers they display. This prevents inconsistencies when the same metric appears on multiple screens or platforms. If a client is calling a scoring/calculation function on raw data from the API, that calculation belongs in the server router instead.
- **Good architecture and modeling**: Actively look for opportunities to decouple code, model real-world concepts as proper classes/types, use common interfaces, and apply SOLID principles with domain-driven design. When you see scattered logic that represents a single concept (e.g., "is this provider connected?"), extract it into a model or interface rather than leaving it inline. Prefer domain-driven abstractions over ad-hoc checks spread across the codebase. Follow SOLID principles: single responsibility (each class/module does one thing), open/closed (extend via composition, not modification), Liskov substitution (subtypes must be substitutable), interface segregation (small, focused interfaces), and dependency inversion (depend on abstractions, not concretions). Prefer composition over inheritance — build complex behavior by combining simple, focused components rather than deep class hierarchies. Use dependency injection, strategy patterns, and mixins instead of base classes.
- **Dual-platform parity (web + mobile)**: Every feature, bug fix, and UI change must be implemented on both `packages/web` and `packages/mobile`. When adding a new page, chart, or data view to one platform, implement the equivalent on the other in the same PR. Shared logic lives in domain-specific packages (`@dofek/format`, `@dofek/scoring`, `@dofek/nutrition`, `@dofek/training`, `@dofek/stats`, `@dofek/onboarding`, `@dofek/providers`) — import from there instead of duplicating. Platform-specific code (HealthKit, barcode scanning, Expo secure storage, ECharts vs react-native-svg) stays in the respective package. When reviewing PRs, check that both platforms are updated.
- **Always report errors to Sentry**: Never silently swallow errors or only log them. Every `catch` block that handles an unexpected error must call `captureException()` (from `./telemetry` in mobile, or the equivalent in server code) so failures are visible in our error monitoring. Silent `catch(() => {})` blocks are banned — they hide bugs and make debugging impossible.
- **Surface errors to the user by default**: When a server error occurs, send a specific, actionable error message to the client — never hide it behind a generic "Something went wrong" or "Failed to load." Use a TRPCError with an appropriate code (e.g., `PRECONDITION_FAILED`, `NOT_FOUND`) and a human-readable message that tells the user what's wrong and what to do. Clients must display `error.message` from the server, not hardcoded strings. Hiding the real error from the user makes debugging slower and generates support requests that could be self-service.
- **Fail fast, never warn-and-continue**: When a required precondition is missing (env file, config, dependency), fail immediately with a clear error — never log a warning and silently continue with broken state. A deploy that proceeds with an empty `.env.prod` is worse than one that fails loudly. Warnings that don't stop execution are deceptive; they hide the real problem and cause confusing downstream failures.
- **Fix properly, no workarounds**: When encountering an issue, fix the root cause. Lint rules, type checks, and CI gates exist for a reason — don't disable them, skip them, add ignores, or use workarounds to make problems go away. Always do the harder thing that actually solves the problem. If you genuinely cannot fix the root cause, **stop and ask the user before** resorting to any shortcut, disable, or workaround. Never take the "easy" or "efficient" way out without explicit approval.
- **No stopgaps or temporary compatibility layers**: Do not ship interim aliases, fallback paths, dual-route bridges, or other stopgap behavior to paper over a misconfiguration. Implement the single canonical fix directly. If a migration might require a temporary bridge, stop and ask the user for explicit approval before adding it.
- **Never bump size limits**: When the `size-limit` CI check fails, reduce the actual bundle size — don't increase the threshold in `.size-limit.json`. Deduplicate code, extract shared components, lazy-load routes, or tree-shake unused imports. The limit exists to enforce discipline; bumping it defeats the purpose.
- **TDD**: Write tests first, then implement. Every new feature or provider starts with a failing test. When fixing bugs, write a failing test that reproduces the bug before writing the fix. If a PR touches code that lacks tests, add tests for the changed behavior — never dismiss missing coverage as "pre-existing" or "not introduced by this PR." For SQL/query bugs, write integration tests against a real database; don't dismiss them as untestable because unit tests mock the DB.
- **Do not test static config files**: Treat static config file tests as unnecessary. If a config file only contains declarative static values and no meaningful runtime logic, do not add or run dedicated tests for it.
- **Production code drives, tests adapt**: Never add hacks, indirection, or complexity to production code just to make tests easier. No lazy initialization to avoid connections in tests, no conditional logic gated on `NODE_ENV === 'test'`, no runtime feature flags for testability. Tests should use mocks, dependency injection, or module-level mocking (`vi.mock`) to work around production code — not the other way around. If production code needs restructuring to be testable, that restructuring should also improve the production design (e.g., proper DI).
- **No exports just for testability**: Never export a function, class, or variable solely because a test needs to access it. Exports define the public API of a module — every export should serve a production consumer. If a test needs to verify internal behavior, test it through the public interface instead. Comments like "exported for testing" are a code smell — if it's worth exporting, it's worth exporting for production use too.
- **Shared test utilities**: When multiple unit or integration tests need to share mock setups, utility functions, or test data, extract them into a local `test-helpers.ts` file within the same directory. Do not export these helpers from the source file being tested or import them from another `*.test.ts` file.
- **Colocated unit tests**: Unit test files live next to the source file they test, named `<source>.test.ts`. Do not use `__tests__/` directories. For example, `src/db/tokens.ts` has its unit test at `src/db/tokens.test.ts`. Integration tests (`*.integration.test.ts`) can live wherever makes sense.
- **Test separation**: Unit tests use `*.test.ts`, integration tests use `*.integration.test.ts`. Unit tests must never need access to external services (databases, APIs). Integration tests must never mock at the module level (`vi.mock`). For 3rd party services in integration tests, mock at the network level with [MSW](https://mswjs.io/) (`setupServer` from `msw/node`), not with constructor-injected fetch or `vi.spyOn(globalThis, 'fetch')`.
- **Start integration dependencies first**: Before running any integration tests (including `pnpm test:changed`), ensure Docker dependencies are up: `docker compose up -d db redis`. Verify they are running with `docker compose ps db redis`. Do not run integration suites against a stopped local stack.
- **Mutation testing (Stryker)**: High coverage is a baseline, but the goal is to kill every mutant. When the `Test / Stryker` job fails, check the logs for surviving mutants even if unit/integration tests pass. Add targeted test cases to cover the exact branch, operator, or boundary that survived.
- **Provider-agnostic**: The schema and sync framework must not be coupled to any specific provider. Providers implement a plugin interface.
- **Food DB must stay provider-agnostic**: `fitness.food_entry`, `fitness.food_entry_nutrient`, and `fitness.supplement_nutrient` must store food/nutrition facts and generic provider references only. Never add Slack-specific (or any source-implementation-specific) fields to these core food tables.
- **One canonical nutrient storage path**: Store nutrients as rows in `fitness.food_entry_nutrient` and `fitness.supplement_nutrient`, with nutrient definitions in `fitness.nutrient`. Do not add or reintroduce wide nutrient tables, duplicate daily nutrient tables, or per-nutrient columns. Daily nutrition totals must be derived from `fitness.v_nutrition_daily`, not stored as a second source of truth.
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
  docker run -d --name dofek-test-db --network dofek-test 
    -e POSTGRES_DB=health -e POSTGRES_USER=health -e POSTGRES_PASSWORD=test 
    timescale/timescaledb:2.26.2-pg18
  sleep 5
  docker run -d --name dofek-test-web --network dofek-test -p 3000:3000 
    -e DATABASE_URL=postgres://health:test@dofek-test-db:5432/health -e PORT=3000 
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
- **Validate infrastructure changes locally before PRs**: Before creating a PR that touches any deployment/infrastructure files (`deploy/*.tf`, `deploy/server/cloud-init.yml`, `deploy/stack.yml`, `deploy/otel-collector-config.yaml`), run `terraform plan` and `terraform apply` yourself using Infisical secrets, and run `docker stack config -c deploy/stack.yml` to verify the stack file parses. Never push infrastructure changes that you haven't verified actually work. CI running `terraform apply` is not a substitute for local validation.
- **No manual server changes**: Never SSH into the server to edit config files directly. All server config changes must go through `deploy/stack.yml` (committed to git) or Terraform. See the README for details. SSH is allowed for **debugging** (reading logs, checking container status, inspecting state) but not for making changes — the fix must be a code/infrastructure change that handles the failure automatically.
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
- **Swarm deploy release unit**: For web deploys, treat `docker stack deploy` as the single release action. Do not split `web` and `training-export-worker` into separate deploy workflows/jobs for normal releases; both are updated by the same stack using the same image tag.
- **Knip unused code analysis**: Root `knip.json` must be updated whenever adding a new package with its own runtime entry point (e.g. `packages/server/src/index.ts`). If Knip reports false positives for an entire package, verify its entry point is correctly registered.
- **Use the `gh` CLI** to check build status and read job logs — never scrape the web UI or use raw API calls with curl. Example: `gh run list`, `gh run view <id>`. See `docs/ci-debugging.md` for how to extract actual error messages from truncated CI logs (especially iOS builds where xcodebuild output is piped through `tail -40`).
- **Use the CI fix skill**: When a user asks to fix failing GitHub Actions checks, use the `github:gh-fix-ci` skill.
- **`github:gh-fix-ci` required workflow**: (1) inspect failing run logs, (2) extract the first fatal error line, (3) prove causal chain, (4) implement the minimum root-cause fix, (5) validate with local checks and rerun workflow, (6) report root cause/fix/evidence.
- **Keep workflow steps granular for visibility**: Prefer multiple small, clearly named CI steps over one large script step so failures show exactly where execution stopped (for example: env export, DB readiness, migrations, deploy).
- **Periodically check CI runs** to catch failures early. Before starting work, check if CI is green.
- **Never rerun flaky CI as a fix**: Re-running a failed job is never an acceptable solution. Every CI failure — even "infrastructure" flakes like network timeouts, tool install failures, or timing issues — must be fixed at the root cause (pin versions, add caching, replace flaky dependencies, etc.). Flaky CI that gets re-run trains the team to ignore failures.
- **Prefer Terraform-native CI approaches**: When automating infrastructure changes (compose deploys, DNS, server config), use Terraform with `templatefile()`, providers, and `terraform apply` in CI rather than ad-hoc shell scripts or manual `curl`/`sed` pipelines. Terraform provides plan/apply semantics, state tracking, and idempotency that scripts lack.

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
deploy/                      — Terraform (Hetzner + Cloudflare) + Docker Compose deploy
Dockerfile                   — Multi-stage: server target (includes built web assets)
```
