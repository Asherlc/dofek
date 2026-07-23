# Dofek (דופק)

[![CI](https://github.com/Asherlc/dofek/actions/workflows/ci.yml/badge.svg)](https://github.com/Asherlc/dofek/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Asherlc/dofek/graph/badge.svg)](https://codecov.io/gh/Asherlc/dofek)
[![Knip](https://knip.dev/shields/badge.svg)](https://knip.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Biome](https://img.shields.io/badge/Biome-60a5fa?logo=biome&logoColor=white)](https://biomejs.dev/)
[![pnpm](https://img.shields.io/badge/pnpm-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![Drizzle ORM](https://img.shields.io/badge/Drizzle_ORM-C5F74F?logo=drizzle&logoColor=black)](https://orm.drizzle.team/)
[![Expo](https://img.shields.io/badge/Expo-000020?logo=expo&logoColor=white)](https://expo.dev/)

Provider-agnostic fitness and health data pipeline. Pulls data from various APIs (strength training, cardio, body composition, sleep, nutrition, journals) into a TimescaleDB database with a built-in web dashboard.

## Documentation Map

If you are starting cold and do not want to hunt through agent notes, begin here:

- [docs/README.md](docs/README.md): human-facing index of architecture notes, runbooks, and provider research.
- [deploy/README.md](deploy/README.md): production architecture, deploy flow, secrets, and debugging access.
- [docs/schema.md](docs/schema.md): canonical database model and storage rules.
- [docs/adding-a-provider.md](docs/adding-a-provider.md): how to add or extend a provider.
- [docs/exercise-metadata.md](docs/exercise-metadata.md): strength exercise muscle metadata source, overrides, and update workflow.
- [docs/testing.md](docs/testing.md): testing patterns used across the repo.
- [docs/processing-status-runbook.md](docs/processing-status-runbook.md): durable provider/import processing evidence and operational diagnosis.

## Architecture

```
┌─────────────┐
│ Apple Health │──┐
├─────────────┤  │
│  Wahoo API  │──┤
├─────────────┤  │     ┌──────────────┐     ┌──────────────┐
│  WHOOP API  │──┼────▶│  Sync Runner │────▶│ TimescaleDB  │──┐
├─────────────┤  │     └──────────────┘     └──────────────┘  │
│  Peloton    │──┤        (provider           (raw fitness     │
├─────────────┤  │         plugins)            schema)          │
│  FatSecret  │──┤                         ┌──────────────┐    │
├─────────────┤  │                         │ ClickHouse   │◀───┘
│  Withings   │──┤                         │ projections  │
├─────────────┤  │                         └──────┬───────┘
│ RideWithGPS │──┤                                │
├─────────────┤  │                                ▼
│  Polar      │──┤                         ┌───────────┐
├─────────────┤  │                         │ Web UI    │
│  Garmin     │──┤                         │ (tRPC)    │
│ Amazfit/Zepp│──┘                         └───────────┘
└─────────────┘
```

Each data source is a **provider plugin** that implements a simple interface. The sync runner orchestrates all enabled providers. Raw app data lands in a `fitness` Postgres schema, except high-volume `metric_stream` samples: those publish to Redpanda, sink into ClickHouse, and are archived by Redpanda Connect to Cloudflare R2 for long-term replay. Other raw fitness tables still use PeerDB as the internal Postgres-to-ClickHouse CDC path into `postgres_fitness.*`. ClickHouse maintains stored analytics read models for heavy activity stream reads. Incremental dbt models under `analytics/models/` define derived ClickHouse analytics tables such as `analytics.deduped_sensor` and `analytics.resting_heart_rate_sleep_window` outside the web/API request path. Derived rows are not written back to Postgres. The web dashboard provides sync controls, provider health monitoring, insights, and data exploration. A companion iOS app (Expo + React Native) provides native HealthKit integration and on-the-go access. Nutrition logging on web and iOS supports natural-language AI meal input that can split one message into multiple food items. Long-running sync jobs are processed by BullMQ workers backed by Redis. In production, the `worker` container registers repeatable scheduled sync jobs in BullMQ, and the `analytics-worker` container runs the production-safe subset of dbt analytics builds every 15 minutes with a bounded retry delay; the `sync` mode remains available for manual one-shot runs. `analytics.sensor_scalar_sample`, `analytics.deduped_sensor`, `analytics.sleep_heart_rate_sample`, `analytics.activity_sensor_sample`, and `analytics.activity_location_sample` run as bounded `recorded_at` microbatch models; `analytics.resting_heart_rate_sleep_window`, the activity aggregate intermediates, and `analytics.activity_summary_rows` use dirty-key incremental models over those bounded inputs.

## Quick Start

```bash
# Install dependencies
pnpm install

# Start local infrastructure with collision-free stable local ports
pnpm compose:up

# Log in to Infisical (see "Secrets" section below) and store the credential
# encryption key — required for boot, see "Credential encryption at rest":
infisical secrets set --env=prod \
  CREDENTIAL_ENCRYPTION_KEY_BASE64=$(openssl rand -base64 32)

# Apply Postgres + ClickHouse migrations (idempotent — safe to re-run):
infisical run --env=prod -- pnpm setup-db

# Optional: run a one-shot sync if you have provider credentials configured.
infisical run --env=prod -- pnpm sync
```

`pnpm setup-db` is the canonical fresh-DB bootstrap and matches what
`entrypoint.sh migrate` runs in production: it applies SQL files in `drizzle/`
to Postgres, then runs the ClickHouse-side migrations. Use `pnpm migrate`
(drizzle-kit) only for incremental schema work after a `pnpm generate`.

## Adding a Provider

See [docs/adding-a-provider.md](docs/adding-a-provider.md).
See [docs/nutrition-ai-input.md](docs/nutrition-ai-input.md) for natural-language meal logging flow on web and iOS.

## Schema

See [docs/schema.md](docs/schema.md) for the full data model.

### Known gaps

- **`fitness.medication_dose_event`** — table exists (modeled after the iOS 26 `HKMedicationDoseEvent` type) but has no ingestion path and no read path wired up. Apple Health imports do not write to it, and no router or repository reads from it. Wire-up needed: (1) ingest from `HKMedicationDoseEvent` samples in `packages/mobile` and POST to a sync endpoint, (2) add reader in `packages/server/src/repositories` exposing dose history via tRPC, (3) display in web/mobile medication views.

## Project Structure

pnpm workspace monorepo:

```
dofek/
├── src/                           # Root package — sync runner, providers, DB schema
│   ├── db/clickhouse-migrations/  # Ordered file-per-migration ClickHouse registry modules
│   └── providers/                 # Provider plugin implementations
├── packages/
│   ├── server/                    # dofek-server — Express + tRPC API + BullMQ jobs
│   ├── web/                       # dofek-web — Vite + React SPA (browser)
│   ├── mobile/                    # dofek-mobile — Expo + React Native app (iOS)
│   ├── ios/                       # Shared iOS-native support package(s)
│   ├── format/                    # @dofek/format — date, duration, number, unit formatting
│   ├── scoring/                   # @dofek/scoring — score colors, labels, workload helpers
│   ├── nutrition/                 # @dofek/nutrition — meal types, auto-meal detection
│   ├── training/                  # @dofek/training — activity types, weekly volume
│   ├── stats/                     # @dofek/stats — correlation, regression analysis
│   ├── recovery/                  # @dofek/recovery — recovery metrics and scoring
│   ├── onboarding/                # @dofek/onboarding — onboarding flow logic
│   ├── provider-http/             # @dofek/provider-http — shared provider HTTP errors/rate limiting
│   ├── providers-meta/            # @dofek/providers — provider display labels
│   ├── zones/                     # @dofek/zones — HR/power zone calculations
│   ├── auth/                      # @dofek/auth — shared authentication logic
│   ├── heart-rate-variability/    # @dofek/heart-rate-variability — HRV analysis
│   ├── ml/                        # Local ML/export tooling and Docker image
│   ├── ble-probe/                 # macOS BLE reverse-engineering tool
│   ├── whoop-whoop/               # RE'd WHOOP internal API client
│   ├── eight-sleep/               # RE'd Eight Sleep internal API client
│   ├── zwift-client/              # RE'd Zwift internal API client
│   ├── zepp-client/               # RE'd Amazfit/Zepp internal API client
│   ├── trainerroad-client/        # RE'd TrainerRoad internal API client
│   ├── velohero-client/           # RE'd VeloHero API client
│   ├── garmin-connect/            # RE'd Garmin Connect SSO + API client
│   └── trainingpeaks-connect/     # RE'd TrainingPeaks internal API client
├── native/fit-decoder/             # C++ Garmin FIT streaming decoder (CMake + vcpkg)
├── cypress/                       # E2E tests (Cypress)
├── drizzle/                       # SQL migrations (0000_baseline.sql + forward migrations)
│   └── _views/                    # Canonical materialized view definitions
├── deploy/                        # Terraform + Docker Swarm production stack — see deploy/README.md
└── Dockerfile                     # Multi-stage: server image with built web assets
```

The server imports shared code from the root package via `dofek` workspace dependency (e.g. `import { createDatabaseFromEnv } from "dofek/db"`). The web client imports the `AppRouter` type from the server via `dofek-server/router`. Shared domain logic lives in dedicated packages (`@dofek/format`, `@dofek/scoring`, etc.) imported by both web and mobile.

Use `@dofek/format` for display formatting instead of local rounding, string-built units, or ad hoc date/time formatting. Nutrition displays should use the nutrition helpers, body composition should use the body composition helpers, recovery metrics should use `formatHRV`/`formatSpO2`, intensity and training load should use their domain helpers, dates/times should use the shared date/time helpers, and durations should use the shared human-readable duration helpers.

### Strain semantics

Current strain is a same-day, activity-derived value. It starts at 0 each day and is computed from today's activity load (`duration_minutes * average_heart_rate / max_heart_rate`) converted to the 0-21 strain scale. Passive all-day heart-rate samples do not contribute to current strain.

Target strain is separate from current strain. It uses readiness and recent training-load balance to recommend how much strain to aim for, while current strain only reports what the user has actually accumulated today from activities.

## Development

```bash
# Postgres + ClickHouse + Redis (required for any dev workflow)
pnpm compose:up

# PeerDB CDC stack — required for the API server, since its boot path waits
# for ClickHouse analytics views and lower-volume postgres_fitness mirrors.
pnpm compose -- -f docker-compose.yml -f docker-compose.peerdb.yml up -d
# (The peerdb-temporal-init container auto-registers the MirrorName Temporal
# search attribute that PeerDB workflows depend on. PeerDB startup fails if
# registration cannot be verified.)
# PeerDB UI is available at http://localhost:3001 when the PeerDB stack is up.

# Apply Postgres + ClickHouse migrations to a fresh DB (idempotent).
pnpm setup-db
# Configure the remaining PeerDB mirrors for lower-volume Postgres fitness tables.
pnpm clickhouse-cdc

# Optional local Redpanda/R2 replay stack. This starts Redpanda, local MinIO,
# Redpanda Connect archive, and sink containers using the server image target.
pnpm compose -- --profile metric-stream up -d \
  redpanda metric-stream-minio metric-stream-r2-archive \
  metric-stream-clickhouse-sink

pnpm test                       # Docker-free unit + mobile tests
pnpm test:integration           # Compose-backed integration tests
pnpm test:all                   # unit + mobile + integration tests
pnpm test:watch                 # Docker-free tests in watch mode
pnpm dev                        # run sync runner in dev mode

# Web dashboard — starts Vite dev server (proxies /api to Express)
cd packages/web && pnpm dev

# API server
cd packages/server && pnpm dev

# Mobile app
cd packages/mobile && pnpm start

# Storybook
pnpm storybook:web
pnpm storybook:mobile
```

### Exercise Metadata

Strength exercise muscle metadata uses a minified copy of Free Exercise DB in `src/free-exercise-db.json`, plus local aliases/corrections from `src/exercise-metadata-overrides.json`.

To pull upstream Free Exercise DB changes, run:

```bash
curl -fsSL https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json \
  | node -e 'let input = ""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => process.stdout.write(JSON.stringify(JSON.parse(input)) + "\n"));' \
  > src/free-exercise-db.json
```

Keep `src/free-exercise-db.json` minified so upstream catalog refreshes do not blow past PR size limits. Add Dofek-specific name aliases or corrections to `src/exercise-metadata-overrides.json`, not the upstream copy. See [docs/exercise-metadata.md](docs/exercise-metadata.md) for the full workflow.

Pull requests can publish web and mobile Storybook previews automatically on every PR event. The preview is uploaded to the `dofek-storybook` R2 bucket and served from `https://storybook.dofek.fit/pr-<PR number>/index.html` and `https://storybook.dofek.fit/pr-<PR number>/mobile/index.html`. Closed PR previews are deleted by workflow, with R2 lifecycle rules as a fallback safety net. Configure `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` in GitHub Actions secrets. The workflow sets `R2_BUCKET=dofek-storybook`; Terraform in `deploy/storage.tf` manages the bucket and lifecycle policy, while the `storybook.dofek.fit` custom domain is configured in the Cloudflare dashboard. Production web assets use the separate `dofek-web-assets` R2 bucket; its `assets.dofek.fit` custom domain and browser CORS policy are Terraform-managed in `deploy/storage.tf` because Cloudflare R2 custom domains require bucket-level domain bindings and CORS policy for cross-origin browser loads: https://developers.cloudflare.com/r2/buckets/public-buckets/#custom-domains and https://developers.cloudflare.com/r2/buckets/cors/#use-cors-with-a-custom-domain.

Dedicated PR review apps have been retired. Pull requests still publish Storybook previews to R2 for web and mobile UI review.

Tests use [Vitest](https://vitest.dev/). TDD is the standard workflow — write tests first, then implement. Test files are colocated with source files (e.g. `index.test.ts` next to `index.ts`). E2E tests use [Cypress](https://www.cypress.io/) and run against a Docker Compose stack in CI. [Stryker](https://stryker-mutator.io/) mutation testing runs on PRs to verify test quality.

Local Compose commands should run through `pnpm compose -- <arguments>`. The wrapper pins Docker Compose's project name, project directory, file, and child working directory to the physical workspace so Conductor workspaces cannot accidentally share resources through an inherited stale path. Docker Compose documents the precedence and isolation role of [project names](https://docs.docker.com/compose/how-tos/project-name/) and the [`--project-directory` option](https://docs.docker.com/reference/cli/docker/compose/).

### Migration Baseline (Squashed History)

- `drizzle/0000_baseline.sql` is the canonical baseline for fresh databases.
- `runMigrations()` holds the existing PostgreSQL advisory lock and delegates the complete
  `drizzle/meta/_journal.json` history to Drizzle's node-postgres migrator. Every tracked SQL
  migration must have a journal entry. See [Drizzle's runtime migration workflow](https://orm.drizzle.team/docs/migrations)
  and [PostgreSQL advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS).
- `drizzle/0001_seed_journal_questions.sql` seeds canonical journal questions on fresh installs and is idempotent for existing environments.
- For an existing schema with empty migration tracking, `runMigrations()` marks the
  `*_baseline.sql` journal entry as applied without executing it. Legacy filename-based
  tracking rows are reconciled to Drizzle content hashes before pending migrations run.
- Postgres migration SQL must be transaction-compatible: do not add file-level transaction
  control or `CREATE INDEX CONCURRENTLY`. PostgreSQL transactions provide all-or-nothing
  execution, while concurrent index creation cannot run inside a transaction block. See
  [PostgreSQL transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html)
  and [`CREATE INDEX`](https://www.postgresql.org/docs/current/sql-createindex.html).
- Add all new migrations as forward-only files in `drizzle/` (for example, `0003_add_...sql`, `0004_add_...sql`).
- ClickHouse migrations live as ordered TypeScript modules in `src/db/clickhouse-migrations/`; add one file per migration and register it in `src/db/clickhouse-migrations/registry.ts`.
- Deploy migrations must be schema-only. Do not inline historical backfills, full read-model refreshes, `INSERT ... SELECT` data moves, ClickHouse mutations, or `OPTIMIZE FINAL` in deploy migrations. Put large data work in resumable scripts or jobs with progress tracking and a separate cutover/validation step.
- `pnpm lint:migrations` checks changed `drizzle/*.sql` files for deploy-blocking data work. CI runs the same policy check in the Migration Lint job before Squawk.

## Docker

A single image is built from a multi-stage Dockerfile:

| Image | Base | Contents |
|-------|------|----------|
| `ghcr.io/asherlc/dofek:latest` | node:26-alpine3.23 | Express API + built web assets + migrations + sync/worker entrypoints |

### How it works

```text
Dockerfile (multi-stage)
├── fit-decoder-build   — CMake/vcpkg build and CTest for the Garmin FIT decoder
├── workspace-manifests — lockfile and workspace package manifests only
├── workspace-deps      — full pnpm install for Vite build tooling
├── server-deps         — production pnpm install filtered to dofek-server
├── client-build        — full source + Vite build
└── server target       — Node 26 runtime with native decoder, TypeScript sources, web assets, and entrypoint
```

Dependency layers are intentionally source-independent: `workspace-manifests` copies only package manifests, the lockfile, and patches, then `workspace-deps` and `server-deps` install from that stable input set. `server-deps` uses `pnpm install --prod --frozen-lockfile --filter dofek-server...` rather than `pnpm deploy`, keeping the image on pnpm's regular install path and avoiding `deploy --legacy`. See pnpm's docs for filtered installs and deploy behavior: https://pnpm.io/filtering, https://pnpm.io/cli/install, https://pnpm.io/cli/deploy.

The `fit-decoder-build` stage builds and tests the C++ decoder with Garmin's official [FIT C++ SDK](https://github.com/garmin/fit-cpp-sdk), [CMake presets](https://cmake.org/cmake/help/latest/manual/cmake-presets.7.html), and [vcpkg manifest mode](https://learn.microsoft.com/vcpkg/concepts/manifest-mode). The server image copies only the resulting executable into the runtime. It then copies the workspace source tree plus production dependencies from `server-deps` and creates explicit symlinks for workspace packages so bare imports resolve at runtime. Built web assets from `packages/web/dist` are included in the server image — Express serves them directly with SPA fallback. BuildKit cache mounts keep the pnpm and vcpkg caches warm across builds, and CI exports E2E/server build caches to GitHub Actions cache plus GHCR registry cache for reuse across PRs. See Docker's cache backend docs: https://docs.docker.com/build/cache/backends/gha/, https://docs.docker.com/build/cache/backends/registry/. Production runs TypeScript directly on Node 26; there is no separate server transpile step inside the container.

### Building locally

```bash
# Build and test
docker build --target server -t dofek-server:local .

# Verify server can resolve its dependencies
docker run --rm --entrypoint node dofek-server:local \
  -e "console.log('OK')"
```

Always test Docker builds locally before deploying. The CI build runs on Linux and may behave differently than local dev.

### Entrypoint modes

The server image runs in multiple modes via `entrypoint.sh`:

```bash
# Run pending database migrations (runs once, then exits)
docker run dofek:latest migrate

# API server (Express + tRPC)
docker run dofek:latest web

# BullMQ job worker (processes sync jobs, file imports)
docker run dofek:latest worker

# Sync runner (provider data sync, one-shot)
docker run dofek:latest sync
```

All modes use Node 26 to run TypeScript source directly — no build step. The `sync`, `worker`, and `migrate` modes run migrations themselves. In production, `web` does not run migrations on startup; CI runs migrations before `docker stack deploy`. This also means swarm rollback is image rollback only, not schema rollback.

## Deployment

See [`deploy/README.md`](deploy/README.md) for the production architecture, services, CI/CD pipeline, secrets handling, SSH access, log sources, and operational runbooks.

### OpenTelemetry (Provider-Agnostic)

Frontend telemetry is initialized in `packages/web/src/lib/telemetry.ts` and only activates when `VITE_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (or `VITE_OTEL_EXPORTER_OTLP_ENDPOINT`) is set.

The browser instrumentation propagates trace headers on `/api`, `/auth`, and `/callback` so backend OpenTelemetry can continue frontend traces.

Backend telemetry is initialized in `src/instrumentation.ts` and uses the standard OTLP env vars:
- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
- `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`

### Performance instrumentation

The API server has three layers of performance instrumentation:

**1. tRPC procedure metrics (Prometheus)**

Every tRPC query/mutation records duration via `prom-client` histograms, exposed at `/metrics`:

- `trpc_procedure_duration_seconds{procedure, type, cache_hit}` — total wall clock time per procedure
- `trpc_db_query_duration_seconds{procedure}` — database portion only (excludes cache lookup)
- `trpc_cache_lookup_duration_seconds{procedure, hit}` — cache lookup time
- `trpc_cache_hits_total{procedure}` / `trpc_cache_misses_total{procedure}` — hit/miss counters

Queries exceeding 500ms emit a warning log: `Slow query: activity.stream took 842ms`.

Defined in `packages/server/src/lib/metrics.ts`, recorded in `packages/server/src/trpc.ts`.

**2. Per-query OTel spans**

Every `executeWithSchema()` call (the funnel point for all repository DB reads) emits an OpenTelemetry `db.query` span with:

- `db.system` — `postgresql`
- `db.statement` — first 120 chars of the parameterized SQL
- `db.row_count` — number of rows returned
- Span duration — wall clock time of the Postgres round-trip

These spans nest under the HTTP request trace, so in Axiom you see the full waterfall:

```
HTTP GET /api/trpc/activity.stream  145ms
  └─ db.query "WITH pivoted AS ( SELECT ds.recorded_at..."  98ms  rows=500
```

Defined in `packages/server/src/lib/typed-sql.ts`.

**3. Sentry browser tracing**

The web client (`packages/web/src/lib/telemetry.ts`) uses `browserTracingIntegration()` to capture page navigation timing and propagate trace headers to the API.

**Analyzing performance**

To check API latency for a specific procedure (e.g., before/after a query optimization):

```bash
# Axiom: query db.query spans for a specific procedure
axiom query 'dofek-logs' --filter 'span.name == "db.query" AND attributes.db.statement contains "deduped_sensor"'

# Axiom: find slow queries (>200ms)
axiom query 'dofek-logs' --filter 'span.name == "db.query" AND duration > 200ms'

# Prometheus: check p95 latency for activity.stream (via /metrics endpoint or Grafana)
# trpc_db_query_duration_seconds{procedure="activity.stream"}

# Slow query warnings in logs
axiom query 'dofek-logs' --filter 'message contains "Slow query"'
```

Production Postgres also records statement-level diagnostics:

- `pg_stat_statements` retains aggregated execution stats for SQL fingerprints.
- `log_min_duration_statement=1000` writes any SQL statement taking 1 second or longer to Postgres logs.

Use the commands in [deploy/README.md](deploy/README.md#postgres-statement-diagnostics) during incidents to inspect current statements, top cumulative queries, and recent slow SQL directly from production.

### Production secrets and deploy-time injection

See [`deploy/README.md`](deploy/README.md#production-secrets) for how Infisical secrets are exported to the production stack at deploy time, the list of required Infisical keys, and the production machine identity setup.

## Supplements

Supplements are fundamentally **nutrition data**, not a separate concept. The `auto-supplements` provider automates repetitive daily entry by reading a supplement stack config and inserting one `food_entry` row per supplement per day, with `category = 'supplement'`. This means:

- Supplement start/stop dates are **implicit** — they're visible from when consumption records begin and end in the `food_entry` table. No separate tracking needed.
- Supplement data participates in all nutrition analysis (calorie totals, micro/macronutrient breakdowns, insights engine) automatically.
- The web UI provides a supplement stack editor to define what you take daily. Changes to the stack config are reflected in future sync runs.

See `src/providers/auto-supplements.ts` for the provider implementation.

## Nutrition Storage

Food and supplement nutrients use one canonical storage model: `fitness.food_entry` / `fitness.food_entry_nutrient` for foods and `fitness.supplement_nutrient` for supplement definitions. Daily nutrition totals come from `fitness.v_nutrition_daily`, which is derived from food-entry nutrient rows. Do not add wide nutrient tables or per-nutrient columns for new nutrients; add the nutrient to `fitness.nutrient` and write amounts as rows.

## Life Events

Life events are arbitrary time markers (point-in-time, bounded date range, or ongoing) that let you annotate your health timeline and compare metrics before/during/after. Examples: starting a diet, an injury, a training change. The web dashboard provides a UI to create events and view before/after analysis across heart rate, HRV, sleep, body composition, and activity metrics.

See `packages/server/src/routers/life-events.ts` for the API and `packages/web/src/components/LifeEventsPanel.tsx` for the UI.

## Roadmap

See [docs/roadmap.md](docs/roadmap.md) for the product roadmap and technical backlog.

## Authentication

The web UI requires sign-in via an identity provider (OIDC). Supported providers:

| Provider | Required `.env` Variables |
|----------|--------------------------|
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` |
| Apple | `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `APPLE_REDIRECT_URI` |

All credentials are stored in Infisical. The login page auto-discovers which providers are configured and shows buttons accordingly. If no provider env vars are set, the login page shows "No identity providers configured."

## Provider Configuration

Each provider is enabled by adding its credentials to Infisical. OAuth providers also require a one-time browser authorization via the Data Sources page.

### Implemented Data Sources (31)

The server registry currently has 30 providers in `packages/server/src/routers/sync-helpers.ts`. Apple Health is an additional upload/import data source exposed through the web and iOS clients rather than a registered scheduled provider.

| Provider | Auth Type | Data Types | Required `.env` Variables |
|----------|-----------|------------|--------------------------|
| Apple Health | File import | HR, HRV, sleep, workouts, body, glucose, nutrition, walking, labs | None (upload `.zip`/`.xml` via web UI or share to iOS app) |
| BodySpec | OAuth 2.0 | DEXA scans (body composition, bone density, visceral fat, RMR) | `BODYSPEC_CLIENT_ID`, `BODYSPEC_CLIENT_SECRET` |
| Wahoo | OAuth 2.0 | Activities with FIT file parsing (GPS, power, HR, cadence, running dynamics) | `WAHOO_CLIENT_ID`, `WAHOO_CLIENT_SECRET` |
| WHOOP | RE'd (Cognito) | Sleep, recovery, workouts, 6s HR streams, journal, strength sets | None (credentials entered in UI modal) |
| Peloton | Automated login | Workouts with performance metrics | None (credentials entered in UI modal) |
| FatSecret | OAuth 1.0 | Per-food-item nutrition with full micro/macronutrients | `FATSECRET_CONSUMER_KEY`, `FATSECRET_CONSUMER_SECRET` |
| Withings | OAuth 2.0 | Scale, BP, thermometer | `WITHINGS_CLIENT_ID`, `WITHINGS_CLIENT_SECRET` |
| RideWithGPS | Custom | Trips with GPS track points | None (entered in UI modal) |
| Polar | OAuth 2.0 | Exercises, sleep, HR, Nightly Recharge | `POLAR_CLIENT_ID`, `POLAR_CLIENT_SECRET` |
| Garmin | RE'd (SSO) | Activities, sleep, daily metrics, body battery, stress, HRV, training | `GARMIN_EMAIL`, `GARMIN_PASSWORD` |
| Strava | OAuth 2.0 | Activities | `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` |
| Fitbit | OAuth 2.0 | HR, sleep, SpO2, HRV, temperature, VO2 max, activity | `FITBIT_CLIENT_ID`, `FITBIT_CLIENT_SECRET` |
| Oura | OAuth 2.0 | Sleep, readiness, activity, SpO2, VO2 max, workouts, stress, resilience | `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET` |
| Eight Sleep | RE'd (hardcoded creds) | Sleep trends (HR, HRV, respiratory, temperature, stages) | `EIGHT_SLEEP_EMAIL`, `EIGHT_SLEEP_PASSWORD` |
| Zwift | RE'd (Keycloak) | Activities with power/HR/cadence, FTP | `ZWIFT_USERNAME`, `ZWIFT_PASSWORD` |
| TrainerRoad | RE'd (CSRF cookies) | Activities with power data, career stats | `TRAINERROAD_USERNAME`, `TRAINERROAD_PASSWORD` |
| Suunto | OAuth 2.0 | Workouts | `SUUNTO_CLIENT_ID`, `SUUNTO_CLIENT_SECRET`, `SUUNTO_SUBSCRIPTION_KEY` |
| COROS | OAuth 2.0 | Activities | `COROS_CLIENT_ID`, `COROS_CLIENT_SECRET` |
| Concept2 | OAuth 2.0 | Rowing results | `CONCEPT2_CLIENT_ID`, `CONCEPT2_CLIENT_SECRET` |
| Komoot | OAuth 2.0 | Tours | `KOMOOT_CLIENT_ID`, `KOMOOT_CLIENT_SECRET` |
| MapMyFitness | OAuth 2.0 | Workouts | `MAPMYFITNESS_CLIENT_ID`, `MAPMYFITNESS_CLIENT_SECRET` |
| Ultrahuman | RE'd | Sleep, activity, daily metrics | `ULTRAHUMAN_EMAIL`, `ULTRAHUMAN_PASSWORD` |
| Amazfit/Zepp | RE'd | Steps, distance, active calories, sleep, minute-level heart rate | None (credentials entered in UI modal; optional `ZEPP_API_BASE_URL`) |
| VeloHero | RE'd (SSO) | Workouts with HR/power/cadence | `VELOHERO_SSO_KEY` |
| Xert | OAuth 2.0 | Activities | `XERT_CLIENT_ID`, `XERT_CLIENT_SECRET` |
| Cycling Analytics | OAuth 2.0 | Rides | `CYCLING_ANALYTICS_CLIENT_ID`, `CYCLING_ANALYTICS_CLIENT_SECRET` |
| Wger | OAuth 2.0 | Workouts | `WGER_CLIENT_ID`, `WGER_CLIENT_SECRET` |
| Decathlon | OAuth 2.0 | Activities | `DECATHLON_CLIENT_ID`, `DECATHLON_CLIENT_SECRET` |
| Strong | File import | Strength training history | None (upload `.csv` via web UI or share to iOS app) |
| Cronometer | File import | Nutrition | None (upload `.csv` via web UI or share to iOS app) |
| Auto-Supplements | Config-based | Daily supplement entries | None (configured in UI) |

OAuth providers also need a callback URL env var pointing at your deployment's `/callback` route (for example `https://dofek.asherlc.com/callback`). Set `OAUTH_REDIRECT_URI` in Infisical. After adding credentials, click the provider tile on the Data Sources page to complete the OAuth flow.
Provider secrets must be stored in Infisical, not `.env.local`.

### Reverse-Engineered API Packages (8)

Standalone TypeScript packages for internal APIs that lack public developer access:

| Package | Auth Pattern | Source |
|---------|-------------|--------|
| `packages/whoop-whoop` | AWS Cognito | Internal API |
| `packages/eight-sleep` | Hardcoded OAuth creds (from APK) | Internal API |
| `packages/zwift-client` | Keycloak password grant | Internal API |
| `packages/zepp-client` | Huami registration token exchange | Internal API |
| `packages/trainerroad-client` | CSRF cookie form login | Internal API |
| `packages/velohero-client` | SSO token | Simple web API |
| `packages/garmin-connect` | Multi-step SSO (OAuth1 → OAuth2) | Based on python-garminconnect |
| `packages/trainingpeaks-connect` | Browser cookie → Bearer exchange | Based on tp2intervals |

### Not Implemented

| Provider | Reason | Workaround |
|----------|--------|------------|
| Rouvy | No public API, no RE work exists. Firebase + GraphQL behind Tyk gateway. | Sync to Strava/Garmin, pull from there |
| Hammerhead | No public API. Some RE work exists but SRAM account migration broke auth. | Sync to Strava/Intervals.icu, pull from there |
| Samsung Health | No web API, no RE work. Would need dedicated Android companion app. | Not feasible for server-side sync |

See [docs/provider-api-audit.md](docs/provider-api-audit.md) for detailed RE feasibility analysis of each provider.

## Secrets

Environment variables are split into two tiers:

| Tier | Where | Examples | Needs rebuild? |
|------|-------|----------|----------------|
| **Non-secret config** | Committed `.env` in this repo | Client IDs, redirect URIs, endpoints, DSNs | Yes (baked into image) |
| **Secrets** | [Infisical](https://infisical.com/) (prod environment) → exported to a short-lived temp file during deploy | Client secrets, API keys, tokens, private keys | No (redeploy services) |

### Setup (new machine)

```bash
# Install the CLI
brew install infisical/get-cli/infisical

# Log in (opens browser)
infisical login

# Link this project (already done — .infisical.json is committed)
# infisical init
```

### Local development

Non-secret config is loaded automatically from `.env`. Secrets are injected by the Infisical CLI:

```bash
# Run any command with secrets injected
infisical run --env=prod -- pnpm dev

# Or use the helper script (sources .env + Infisical)
./scripts/with-env.sh pnpm dev

# Vite dev server (VITE_ vars come from packages/web/.env)
infisical run --env=prod -- sh -c 'cd packages/web && pnpm dev'
```

### Managing secrets

```bash
# List all secrets
infisical secrets --env=prod

# Add or update a secret
infisical secrets set --env=prod KEY=value

# Get a single secret
infisical secrets get KEY --env=prod

# Delete a secret
infisical secrets delete KEY --env=prod --type shared
```

### Data export storage and email

User-triggered data exports run in the background, write CSV ZIP files to the private
`dofek-exports` R2 bucket under `exports/<user-id>/<export-id>/`, and email the user a
signed download link. R2 lifecycle policy deletes export objects after 7 days.

Required production config:

- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `EXPORT_R2_BUCKET` (set in `deploy/stack.yml` as `dofek-exports`)
- `BREVO_SMTP_USER`
- `BREVO_SMTP_KEY`
- `EXPORT_EMAIL_FROM`

### Durable file import storage

Browser file imports upload directly to the private `dofek-imports` R2 bucket with
short-lived multipart URLs. Postgres owns upload state and a transactional outbox;
workers verify the complete object's size and SHA-256 before importing it. See
[`docs/file-upload-architecture.md`](docs/file-upload-architecture.md) for the protocol,
recovery behavior, rollout order, and operational runbook.

Production requires the shared `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, and
`R2_SECRET_ACCESS_KEY` secrets plus `IMPORT_R2_BUCKET` (set in `deploy/stack.yml`).

### Stripe billing

Stripe Checkout, Customer Portal sessions, and webhook verification require
Stripe config before the billing path can run. Store these values in Infisical:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_ID`

Billing return URLs use `PUBLIC_URL`, which is set by the production deploy workflow.

Set `STRIPE_WEBHOOK_SECRET` to the webhook endpoint secret from Stripe for
`/api/webhooks/stripe`; it is the `whsec_...` value, not the API secret key.

### Credential encryption at rest (provider credentials)

Provider credentials stored in the database are encrypted in the application layer before insert/update using the AWS Encryption SDK with a raw AES keyring.

Required Infisical key:

- `CREDENTIAL_ENCRYPTION_KEY_BASE64` (required): base64-encoded 32-byte AES key

Optional Infisical keys:

- `CREDENTIAL_ENCRYPTION_KEY_NAMESPACE` (default: `dofek`)
- `CREDENTIAL_ENCRYPTION_KEY_NAME` (default: `provider-credentials`)

Generate a new key:

```bash
openssl rand -base64 32
```

Set/update in Infisical:

```bash
infisical secrets set --env=prod CREDENTIAL_ENCRYPTION_KEY_BASE64='<base64-32-byte-key>'
infisical secrets set --env=prod CREDENTIAL_ENCRYPTION_KEY_NAMESPACE='dofek'
infisical secrets set --env=prod CREDENTIAL_ENCRYPTION_KEY_NAME='provider-credentials'
```

Encryption uses authenticated context (`table`, `column`, `scope`) so ciphertext copied to a different row/column/scope will fail decryption.
Legacy plaintext values remain readable and are encrypted when rewritten by normal flows.

Repository boundary rule:

- Only repository/data-access code may call credential crypto helpers (`encryptCredentialValue`, `decryptCredentialValue`).
- Routes, routers, services, and provider sync logic must consume plaintext domain values from repositories and must not perform DB secret decryption directly.

### Adding a new env var

- **Is it a secret?** (API key, token, password, private key, client secret) → Add to Infisical: `infisical secrets set --env=prod KEY=value`, then redeploy (`gh workflow run deploy-web.yml -f environment=production -f image_tag=latest`).
- **Is it non-secret config?** (client ID, redirect URI, endpoint, DSN) → Add to the committed `.env` at the repo root.

For production deploy-time secret injection, the required Infisical `prod` keys, GitHub Actions secrets, the production machine identity setup, and the 1Password deploy items, see [`deploy/README.md`](deploy/README.md#production-secrets).

## Stack

- **TypeScript** — sync scripts, provider plugins, and web + mobile apps (Node 22 native type stripping at runtime — no tsx in production)
- **Drizzle ORM** — type-safe schema and migrations
- **TimescaleDB + PostGIS** — Postgres with time-series and geospatial extensions
- **ClickHouse** — stored analytics read models for heavy activity stream and summary reads
- **Vite + React** — web dashboard frontend
- **Expo + React Native** — iOS mobile app with native HealthKit integration
- **tRPC + Express** — API layer
- **BullMQ + Redis** — job queue for async sync jobs and file imports
- **ECharts** — data visualization (web)
- **shadcn/ui + Tailwind** — UI components (web)
- **Winston** — structured logging
- **Sentry** — error tracking (via OpenTelemetry)
- **Vitest** — unit + integration testing
- **Cypress** — E2E testing
- **Stryker** — mutation testing
- **Biome** — linting and formatting
- **Infisical** — secrets management (client secrets, API keys, tokens)
- **Docker + GHCR** — deployment via GitHub Actions to Docker Swarm
