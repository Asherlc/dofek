---
name: write-tests
description: Write tests for changed or untested code — unit tests, integration tests, or both depending on what the code does.
---

# Write Tests

Write tests for code that lacks coverage. Follows the project's TDD rules and test separation conventions.

## Current state

- Branch: !`git branch --show-current`
- Status: !`git status --short`

## Arguments

`$ARGUMENTS` should be a file path, function name, or description of what needs tests. If not provided, look at the current branch's diff against `main` and identify untested changes.

## Rules

- **Never dismiss missing coverage as "pre-existing"**: If code is being changed, it needs tests for the changed behavior.
- **SQL/query bugs need integration tests**: Don't dismiss SQL-level issues as "can't be unit tested" — that's what integration tests (`*.integration.test.ts`) are for. Run queries against a real database.
- **Unit vs integration**: Unit tests (`*.test.ts`) mock external services and test TypeScript logic. Integration tests (`*.integration.test.ts`) hit real databases and never use `vi.mock`. For 3rd party services in integration tests, mock at the network level with MSW.
- **Colocated unit tests**: Place `<source>.test.ts` next to the source file. No `__tests__/` directories.
- **No coverage exclusions**: Never add coverage ignore comments (Stryker disable, istanbul ignore, c8 ignore).

## Steps

### 1. Identify what needs tests

If `$ARGUMENTS` is a file path, read it. Otherwise, find untested changes:

```bash
MERGE_BASE=$(git merge-base origin/main HEAD)
git diff $MERGE_BASE HEAD --name-only
```

For each changed file, check if tests exist:

```bash
# For src/foo/bar.ts, look for src/foo/bar.test.ts and src/foo/bar.integration.test.ts
```

### 2. Determine test type

- **TypeScript logic** (field mapping, formula computation, data transformation): Unit test
- **SQL queries** (zone calculations, aggregations, joins, filters): Integration test against real DB
- **UI components** (labels, tooltips, rendering logic): Unit test with the component's exported builder functions
- **API endpoints** (end-to-end request/response): Integration test

### 3. Read existing test patterns

Before writing tests, read a nearby existing test file to match the project's conventions:

- Unit tests: Check the source file's sibling `.test.ts`
- Integration tests: Check `packages/server/src/routers/router-data.integration.test.ts` for the DB setup pattern
- UI tests: Check `packages/web/src/components/chart-options.test.ts` for the chart testing pattern

### 4. Write the tests (TDD style)

Write failing tests first, then verify they fail for the right reason. Key patterns:

**Unit test (server router)**:
```typescript
vi.mock("../trpc.ts", async () => { /* mock tRPC */ });
vi.mock("../lib/typed-sql.ts", () => ({ executeWithSchema: vi.fn(async (db) => db.execute()) }));
const caller = createCaller({ db: { execute: vi.fn().mockResolvedValue(rows) }, userId: "user-1" });
```

**Integration test (real DB)**:
```typescript
import { setupTestDatabase } from "../../../../src/db/test-helpers.ts";
// Insert test data with known values → call endpoint → verify computed results
```

**UI component test**:
```typescript
import { buildSomeOption } from "./SomeChart.tsx";
const option = buildSomeOption(testData);
// Test the returned ECharts config object, tooltip formatters, labels, etc.
```

### 5. Run and verify

```bash
# Unit tests
pnpm test -- --run <test-file>

# Integration tests (needs Docker or TEST_DATABASE_URL)
pnpm test -- --run <integration-test-file>

# Lint
pnpm lint
```

### 6. Commit

Commit the tests separately from the implementation when possible, with a clear message describing what's being tested.

## Important

- Every changed behavior needs a test — no exceptions
- Test the actual behavior, not just that code runs without errors
- For boundary conditions (e.g., zone thresholds at exactly 80% HRmax), write explicit boundary tests
- Verify Treff/formula calculations with hand-computed expected values
