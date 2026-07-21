# Testing Notes

## Integration Dependencies

Start the local backing services before running integration tests:

```bash
pnpm compose:env --write
docker compose --env-file .env.local up -d db clickhouse redis redpanda
pnpm compose:env --write
docker compose --env-file .env.local ps db clickhouse redis redpanda
set -a; . ./.env.local; set +a
pnpm exec vitest run --project integration
```

Compose assigns collision-free host ports per workspace. Source the generated
`.env.local` in the same shell that starts Vitest; otherwise ClickHouse clients
fall back to `localhost:8123` even when this workspace exposes ClickHouse on a
different port. Docker Compose supports explicit environment files for variable
interpolation: <https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/#substitute-with---env-file>.

For faster local integration runs against the shared compose database, point
`TEST_DATABASE_URL` at the generated local Postgres URL:

```bash
pnpm compose:up
set -a; . ./.env.local; set +a
TEST_DATABASE_URL="$DATABASE_URL" pnpm exec vitest run --project integration
```

When `TEST_DATABASE_URL` is set, `setupTestDatabase()` creates one migrated
template database for the current Vitest process and clones each isolated test
database from that template. PostgreSQL supports creating a database from a
template database with `CREATE DATABASE ... TEMPLATE ...`; cloning avoids
replaying the full migration set for every integration test file while keeping
per-file database isolation.

Sources:

- PostgreSQL `CREATE DATABASE` template option: https://www.postgresql.org/docs/current/sql-createdatabase.html
- Vitest `--shard` option for splitting CI test runs: https://vitest.dev/guide/cli.html#shard

### Isolated browser end-to-end stack

Run browser E2E in an explicit Compose project so it cannot collide with the
normal workspace stack:

```bash
docker compose -p dofek-e2e-audit -f docker-compose.e2e.yml up -d --build
docker compose -p dofek-e2e-audit -f docker-compose.e2e.yml ps -a
pnpm e2e:web:run
```

Use a task-specific project name rather than Compose's directory-derived
default; Docker documents project-name isolation and precedence here:
<https://docs.docker.com/compose/how-tos/project-name/>.

On failure, preserve evidence before teardown:

```bash
docker compose -p dofek-e2e-audit -f docker-compose.e2e.yml ps -a
docker compose -p dofek-e2e-audit -f docker-compose.e2e.yml logs --no-color
```

Then remove only this isolated project's containers and fresh volumes:

```bash
docker compose -p dofek-e2e-audit -f docker-compose.e2e.yml down -v
```

This topology currently validates browser paths. It is not a complete mobile
write-path environment because the metric-stream broker prerequisites are
missing; that confirmed gap is tracked in
[#1806](https://github.com/Asherlc/dofek/issues/1806). Do not treat its healthy
server status as proof that activity recording can save.

### Native FIT Decoder

Wahoo, Coros, and Suunto integration tests invoke the native FIT decoder at
`.build/fit-decoder/bin/dofek-fit-decoder`. If they report `Unable to start the
native FIT decoder`, first verify that the file exists and matches the host
architecture:

```bash
file .build/fit-decoder/bin/dofek-fit-decoder
```

The `fit-decoder-linux` CI artifact is an ELF executable and cannot run on
macOS. On macOS, build a native decoder with the repository's pinned vcpkg
toolchain:

```bash
VCPKG_ROOT=/path/to/full/vcpkg/checkout pnpm build:fit-decoder
```

Use the vcpkg commit and bootstrap sequence from
[`test.yml`](../.github/workflows/test.yml); the project uses vcpkg manifest
mode as documented by Microsoft:
<https://learn.microsoft.com/vcpkg/concepts/manifest-mode>.

### Docker Disk Recovery

If a required validation command fails with `No space left on device`, inspect usage before
deleting anything:

```bash
docker system df -v
```

Remove disposable containers and volumes created by the current workspace, then prune the
rebuildable build cache:

```bash
docker compose down -v
docker builder prune -af
```

If that does not reclaim enough space, prune images that are not used by any container:

```bash
docker image prune -af
```

Preserve running containers and named volumes belonging to other workspaces. Do not run
`docker volume prune` or `docker system prune --volumes` unless the user explicitly approves
deleting unused cross-workspace data. Docker documents which object types each prune command
removes in its [resource pruning guide](https://docs.docker.com/engine/manage-resources/pruning/).

Router integration tests that exercise activity sensor analytics use ClickHouse-backed
test stores. The test helper isolates ClickHouse databases per test database, creates
the current ClickHouse schema/read models directly, syncs the seeded Postgres fixtures,
and drops the isolated databases during test cleanup.

Do not make router integration setup call the tracked production ClickHouse migration
runner. Historical one-off migrations and backfills should not be replayed by broad
test suites; tests should validate application behavior against the current schema.

## Web E2E

Use the full reset command when Dockerfiles, migrations, analytics models, or seeded
state changed:

```bash
pnpm e2e:web
```

For repeated local runs after the E2E image and volumes already exist, reuse the
stack instead:

```bash
pnpm e2e:web:reuse
```

`pnpm e2e:web:reuse` starts the existing E2E compose services with `--no-build`,
waits for migrations and analytics setup, keeps volumes after Cypress exits, and
passes extra flags through to Cypress:

```bash
pnpm e2e:web:reuse -- --spec cypress/e2e/dashboard.cy.ts
```

CI runs Cypress specs in one job because the Docker build, service startup,
migrations, analytics setup, and server startup dominate the runtime. Manual
spec sharding on GitHub-hosted runners repeats that setup for each shard.
Cypress's built-in `--parallel` orchestration requires recorded Cypress Cloud
runs, so the workflow does not use Cloud orchestration either.

Source: Cypress parallelization requirements: https://docs.cypress.io/cloud/features/smart-orchestration/parallelization

## Chain-Mock Assertions (`values(...)`)

When testing DB write paths that use chainable mocks (`insert().values().onConflict...`), assert on the recorded payloads directly from `db.values.mock.calls`.

### Pattern: collect `values(...)` arguments

```ts
function getValuesCallArgs(db: ReturnType<typeof makeChainableMock>): unknown[] {
  return db.values.mock.calls.map((call: unknown[]) => call[0]);
}
```

### Pattern: assert a specific inserted record exists

```ts
const valuesCallArgs = getValuesCallArgs(db);
const exerciseInsert = valuesCallArgs.find(
  (arg) =>
    arg &&
    typeof arg === "object" &&
    !Array.isArray(arg) &&
    "name" in arg &&
    (arg as { name?: string }).name === "Bench Press",
);
expect(exerciseInsert).toBeDefined();
```

### Pattern: assert no empty batch insert happened (`values([])`)

Use this when code should skip `insert(...).values(setRows)` if `setRows.length === 0`.

```ts
const insertedEmptyBatch = db.values.mock.calls.some(
  (call: unknown[]) => Array.isArray(call[0]) && call[0].length === 0,
);
expect(insertedEmptyBatch).toBe(false);
```

### Pattern: assert an alias/write was not attempted

```ts
const valuesCallArgs = getValuesCallArgs(db);
const aliasInsert = valuesCallArgs.find(
  (arg) =>
    arg &&
    typeof arg === "object" &&
    !Array.isArray(arg) &&
    (arg as { providerExerciseId?: string }).providerExerciseId === "NOT_FOUND",
);
expect(aliasInsert).toBeUndefined();
```
