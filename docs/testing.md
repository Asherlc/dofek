# Testing Notes

## Integration Dependencies

The default and changed-test commands are intentionally Docker-free:

```bash
pnpm test
pnpm test:changed
pnpm test:coverage
```

Use an explicit integration command when database behavior is under test:

```bash
pnpm test:integration
pnpm test:integration -- src/db/db.integration.test.ts
pnpm test:all
pnpm test:changed:all
pnpm test:coverage:all
```

These commands start the current workspace's Postgres, ClickHouse, Redis, and
Redpanda services through `pnpm compose:up` and wait for their Compose health
checks before Vitest starts. Docker documents the `--wait` health-gated startup
behavior in its [Compose startup-order guide](https://docs.docker.com/compose/how-tos/startup-order/).
The command loads `.env.local` and sets `TEST_DATABASE_URL` to the workspace
Postgres URL. Redpanda-backed integration
tests receive the generated workspace-local `REDPANDA_BROKERS` value so they
cannot connect to another workspace's broker. `setupTestDatabase()` fails
immediately when the Postgres URL is absent; it never creates an unbounded
generic Testcontainers instance. Within a Vitest process it creates one
migrated template database and clones an isolated database for each test file.

The Vitest projects remain separate in CI: unit, mobile, and four integration
shards are invoked explicitly. Stryker uses the Docker-free mutation config and
must not collect `*.integration.test.ts` files. CI mutation discovery therefore
only sends changed TypeScript files with a colocated `.test.ts` or `.test.tsx`
unit suite to Stryker; integration-only implementations are covered by the
integration shards instead of being counted as uncovered Docker-free mutants.
Use `pnpm test:integration` for integration behavior and `pnpm test:mutation`
for mutation quality; do not mix the two execution models.

Sources:

- PostgreSQL `CREATE DATABASE` template option: https://www.postgresql.org/docs/current/sql-createdatabase.html
- Vitest test projects: https://vitest.dev/guide/projects
- Vitest `--shard` option for splitting CI test runs: https://vitest.dev/guide/cli.html#shard
- Stryker Vitest runner configuration: https://stryker-mutator.io/docs/stryker-js/vitest-runner/
- Redpanda Kafka API compatibility: https://docs.redpanda.com/current/develop/kafka-clients/

### Isolated browser end-to-end stack

Use the repository Compose wrapper with the `e2e` project suffix for every
browser E2E command. The wrapper resolves that to `<workspace>-e2e`, which is
stable within the workspace and distinct from the normal `<workspace>` project:

```bash
pnpm compose -- --project-suffix e2e -f docker-compose.e2e.yml up -d --build --wait --wait-timeout 180
pnpm compose -- --project-suffix e2e -f docker-compose.e2e.yml ps -a
if ! pnpm e2e:web:run; then
  pnpm compose -- --project-suffix e2e -f docker-compose.e2e.yml ps -a
  pnpm compose -- --project-suffix e2e -f docker-compose.e2e.yml logs --no-color
  pnpm compose -- --project-suffix e2e -f docker-compose.e2e.yml down -v
  exit 1
fi
pnpm compose -- --project-suffix e2e -f docker-compose.e2e.yml down -v
```

The isolated topology includes Redpanda and explicit metric-stream producer
configuration. Server startup connects the producer before opening the HTTP
listener, and Compose waits for both broker health and `/readyz`; Docker
documents health-gated dependency startup in its
[startup-order guide](https://docs.docker.com/compose/how-tos/startup-order/).

Use the `e2e` suffix for startup, reuse, service inspection, logs, and teardown.
Docker documents project-name isolation and precedence here:
<https://docs.docker.com/compose/how-tos/project-name/>.

The failure branch preserves container state and complete service logs before
teardown. Both paths remove only this isolated project's containers and fresh
volumes.

The default Compose service uses a bounded ClickHouse review profile: a 1536
MiB container ceiling and a 1280 MiB `max_server_memory_usage` setting. The
isolated E2E service uses its own bounded profile: a 2048 MiB container ceiling
and a 1792 MiB `max_server_memory_usage` setting. The E2E profile is larger
because the CI browser stack runs the complete seeded analytics build, not just
the small review fixture; both profiles retain an explicit server cap and a
256 MiB outer headroom gap. Docker documents `mem_limit` as the Compose service
memory ceiling ([service reference](https://docs.docker.com/reference/compose-file/services/#mem_limit));
ClickHouse documents `max_server_memory_usage` in its
[server settings reference](https://clickhouse.com/docs/operations/server-configuration-parameters/settings#max_server_memory_usage).

If a review analytics build reaches the tracked limit, treat the ClickHouse
memory error as a fixture/profile sizing failure and collect the rendered
Compose config plus container inspection before changing the profile. Do not
add retries or waits to the review workflow.

This topology currently validates browser paths. It is not a complete mobile
write-path environment because the metric-stream broker prerequisites are
missing; that confirmed gap is tracked in
[#1806](https://github.com/Asherlc/dofek/issues/1806).

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

Remove disposable containers and volumes created by the current workspace,
then prune the build cache, which Docker can recreate:

```bash
pnpm compose -- down --remove-orphans --volumes
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

Conductor's archive hook runs the equivalent Compose shutdown for both the
default `<workspace>` project and isolated `<workspace>-e2e` project using the
archived workspace's physical directory. It removes those projects'
containers, networks, anonymous volumes, and declared named volumes while
preserving shared images, build cache, and resources belonging to other
workspaces. This matches Docker Compose's documented
[`down --volumes` behavior](https://docs.docker.com/reference/cli/docker/compose/down/).

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
passes extra flags through to Cypress. Both commands use the isolated
`<workspace>-e2e` Compose project:

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
