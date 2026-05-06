# Testing Notes

## Integration Dependencies

Start the local backing services before running integration tests:

```bash
docker compose up -d db clickhouse redis
docker compose ps db clickhouse redis
pnpm exec vitest run --project integration
```

Router integration tests that exercise activity sensor analytics use ClickHouse-backed
test stores. The test helper isolates ClickHouse databases per test database, runs
the tracked ClickHouse migrations after the test fixtures are seeded, and drops the
isolated databases during test cleanup.

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
