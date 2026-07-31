# Dofek (דופק)

[![CI](https://github.com/Asherlc/dofek/actions/workflows/ci.yml/badge.svg)](https://github.com/Asherlc/dofek/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Asherlc/dofek/graph/badge.svg)](https://codecov.io/gh/Asherlc/dofek)
[![Knip](https://img.shields.io/badge/Knip-enabled-4F46E5)](https://knip.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Biome](https://img.shields.io/badge/Biome-60a5fa?logo=biome&logoColor=white)](https://biomejs.dev/)
[![pnpm](https://img.shields.io/badge/pnpm-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)

Provider-agnostic fitness and health data ingestion, analytics, and
visualization. Dofek connects fitness, sleep, nutrition, body-composition, and
training sources to a shared data model served by web and iOS clients.

## Start Here

- [Documentation index](docs/README.md): architecture, product flows, provider
  research, and operational runbooks.
- [Database model](docs/schema.md): canonical storage rules and schema.
- [Provider guide](docs/adding-a-provider.md): provider interfaces,
  authentication, ingestion, and tests.
- [Testing guide](docs/testing.md): test tiers, Docker dependencies, and local
  recovery.
- [Development environment](docs/development-environment.md): pinned tools,
  cloud initialization, Dev Containers, CodeGraph, and RTK.
- [Deployment guide](deploy/README.md): production topology, release flow,
  secrets, and diagnostics.
- [Analytics guide](analytics/README.md): dbt-owned ClickHouse models and
  bounded builds.
- [Processing-status runbook](docs/processing-status-runbook.md): end-to-end
  ingestion and analytics evidence.
- [Database backup runbook](docs/database-backup-recovery-runbook.md):
  Databasus health, R2 freshness, and isolated restore verification.

## Architecture

```text
API and import providers ──> sync/import workers ──> Postgres (fitness.*)
                                  │                       │
                                  │                       └─ PeerDB CDC
                                  │                              │
High-volume sensor samples ──────┴─> Redpanda ────────────────> ClickHouse
                                        │                         │
                                        └─> Cloudflare R2 archive │
                                                                  │
                          Web app and iOS app <── Express + tRPC ──┘
                                              │
                                              └─ Redis + BullMQ
```

- Postgres owns relational application state and lower-volume raw health data.
- High-volume `metric_stream` events bypass Postgres. Redpanda is the hot ingest
  log, Cloudflare R2 is the durable archive, and ClickHouse is the
  serving copy.
- PeerDB mirrors lower-volume `fitness.*` tables into `postgres_fitness.*` in
  ClickHouse.
- Incremental dbt models under `analytics/models/` produce expensive derived
  analytics outside request paths. Derived sensor analytics are never written
  back to Postgres.
- Express and tRPC serve both clients. BullMQ workers use Redis for scheduled
  syncs, imports, exports, post-sync work, and analytics cleanup.

See [the metric-stream architecture](docs/clickhouse-metric-stream.md),
[the schema guide](docs/schema.md), and
[the deployment architecture](deploy/README.md) for the detailed contracts.

## Prerequisites

- [mise](https://mise.jdx.dev/getting-started.html) at the minimum version
  declared in [`mise.toml`](mise.toml). mise installs Node, pnpm, Python, uv,
  Infisical, CMake, Ninja, CodeGraph, RTK, and the remaining portable CLI tools
  from the reviewed checksums in [`mise.lock`](mise.lock).
- Docker with Compose.
- Outside the Dev Container: Git, a C/C++ compiler, and a bootstrapped vcpkg
  checkout exposed through `VCPKG_ROOT`. The container supplies these from its
  pinned [`Dockerfile`](.devcontainer/Dockerfile); vcpkg documents its
  [bootstrap process](https://learn.microsoft.com/vcpkg/get_started/get-started).
- Infisical CLI access to this repository's linked project. Local commands that
  need application secrets fail if `infisical export --env=prod` cannot run;
  see [Infisical CLI documentation](https://infisical.com/docs/cli/overview).

## Quick Start

```bash
MISE_LOCKED=1 mise install --locked
mise exec -- infisical login
mise run cloud:init
```

`mise run cloud:init` installs workspace dependencies, initializes CodeGraph,
verifies RTK, starts Postgres, ClickHouse, Redis, and Redpanda on
workspace-specific local ports and writes those ports to `.env.local`.
It then loads the checked-in environment plus Infisical secrets,
applies Postgres migrations, and applies ClickHouse migrations.
See [the development-environment guide](docs/development-environment.md) for
cloud prebuilds, non-interactive authentication, and the macOS/iOS profile.

For the complete local CDC topology, start the PeerDB Compose overlay and
configure its mirrors:

```bash
pnpm compose -- -f docker-compose.yml -f docker-compose.peerdb.yml up -d
pnpm clickhouse-cdc
```

Always invoke Compose through `pnpm compose --`; the wrapper pins the physical
workspace, project name, and project directory so concurrent Conductor
workspaces remain isolated. Docker documents the same isolation controls in
[project names](https://docs.docker.com/compose/how-tos/project-name/) and
[`--project-directory`](https://docs.docker.com/reference/cli/docker/compose/).

## Development

Run the main processes in separate terminals:

```bash
# Provider sync runner
pnpm dev

# Express + tRPC API
pnpm --dir packages/server dev

# Vite web app
pnpm --dir packages/web dev

# Expo mobile app
pnpm --dir packages/mobile start
```

Useful repository commands:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:all
pnpm test:changed
pnpm test:changed:all
pnpm storybook:web
pnpm storybook:mobile
```

`pnpm test` and `pnpm test:changed` are Docker-free unit/mobile tiers.
Database-backed tests run through the integration or `:all` commands, which
start the workspace's Compose dependencies. See [docs/testing.md](docs/testing.md)
before running or changing integration tests.

## Repository Map

```text
.
├── src/                    Root package: providers, sync, queues, and DB access
├── packages/server/        Express + tRPC API
├── packages/web/           Vite + React web client
├── packages/mobile/        Expo + React Native iOS client and native modules
├── packages/               Shared domain packages and provider clients
├── analytics/              Incremental dbt models for ClickHouse
├── drizzle/                Forward-only Postgres migrations
├── native/fit-decoder/     C++ Garmin FIT streaming decoder
├── scripts/                TypeScript repository and operational tooling
├── cypress/                Browser end-to-end tests
├── deploy/                 Terraform and Docker Swarm production configuration
└── docs/                   Architecture, research, runbooks, and history
```

[`pnpm-workspace.yaml`](pnpm-workspace.yaml) is the canonical package list.
Package-local READMEs describe public responsibilities and usage; adjacent
`AGENTS.md` files contain agent-only implementation guidance.

Shared cross-client logic belongs in domain packages such as
`@dofek/format`, `@dofek/scoring`, `@dofek/nutrition`, `@dofek/training`,
`@dofek/stats`, `@dofek/onboarding`, and `@dofek/providers`. Web and mobile
clients render server-computed metric values rather than recomputing them.

## Data and Provider Contracts

- Providers implement the interfaces in
  [`src/providers/types.ts`](src/providers/types.ts) and register through the
  provider registry.
- API, credential, OAuth, config, and import-only providers are cataloged in
  [`src/providers/README.md`](src/providers/README.md); this code-adjacent
  catalog is authoritative instead of a duplicated count in this file.
- Apple Health upload/import and native WHOOP BLE capture enter through
  web/mobile ingestion paths outside the scheduled provider registry.
- Raw records retain provider and source attribution. Deduplication happens in
  queries and read models, never by discarding records during ingestion.
- Nutrients use row-based canonical storage in `fitness.food_entry_nutrient`
  and `fitness.supplement_definition_nutrient`. `fitness.v_nutrition_provider_daily`
  retains raw per-provider totals; serving totals derive from
  `fitness.v_nutrition_daily`, which resolves one contribution set at query
  time and reports ambiguous overlaps explicitly. See the
  [canonical nutrition schema](src/db/schema/nutrition.ts).
- Supplement definitions are immutable versions under a stable schedule
  identity. Daily occurrences use an append-only `planned` / `taken` /
  `skipped` / `unknown` event chain, and only an explicitly `taken` current
  leaf contributes supplement nutrients to canonical nutrition. PostgreSQL
  partial unique indexes and foreign keys enforce one active definition and a
  linear same-occurrence history; see
  [partial indexes](https://www.postgresql.org/docs/current/indexes-partial.html)
  and
  [foreign-key constraints](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK).
  The storage transition is defined by
  [migration 0061](drizzle/0061_supplement_dose_events.sql).

## Authentication and Secrets

The clients support email/password authentication, configured Google or Apple
identity providers, and eligible data-provider login flows. The server
advertises the available methods through `/api/auth/providers`; see
[the app-password guide](docs/app-password-auth.md) and
[`src/auth/README.md`](src/auth/README.md).

Committed `.env` files contain non-secret configuration. Infisical contains
secrets such as client secrets, tokens, private keys, and encryption keys.
Production CI exports those values to a short-lived runner file; it does not
store them on the server. Follow
[the production-secrets runbook](deploy/README.md#production-secrets) when
adding or rotating a secret.

## Schema and Migrations

- `drizzle/0000_baseline.sql` is the fresh-Postgres baseline; later migrations
  are forward-only and tracked by `drizzle/meta/_journal.json`.
- ClickHouse migrations are ordered TypeScript modules in
  `src/db/clickhouse-migrations/`.
- `pnpm setup-db` is the canonical fresh-database bootstrap.
- `pnpm generate` creates a Drizzle migration and regenerates schema diagrams.
- Deploy migrations must remain schema-only. Large backfills and read-model
  refreshes require bounded, resumable operational tooling and a separate
  runbook.

See [docs/schema.md](docs/schema.md) and the
[ClickHouse read-model deploy runbook](docs/clickhouse-read-model-deploy-runbook.md).

## Deployment

The production image uses Node 26 and contains the Express server, built web
assets, migrations, workers, sync entrypoints, and the native FIT decoder.
GitHub Actions deploys the image and infrastructure as a single Docker Swarm
release to the OCI host.

Do not deploy production manually from this overview. Follow
[`deploy/README.md`](deploy/README.md) for migration ordering, Infisical
injection, health gates, rollback boundaries, and diagnostics.

## Documentation Policy

`docs/README.md` separates current reference documentation from dated design
and incident records. Update active docs whenever behavior, commands, or
operations change. Preserve historical plans and incident evidence as records;
do not treat them as current instructions.
