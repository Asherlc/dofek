# Task 10 report: end-to-end activity identity regression coverage

## Outcome

Task 10 pins the stable activity-group contract through real PostgreSQL and ClickHouse behavior and the public MCP request path. The regression fixtures use synthetic identifiers and current final-schema models. No production behavior was changed to accommodate test doubles, and the parked Task 6 repeated stream-tombstone work was not touched.

Task 10 is recorded as one privacy-sanitized replacement commit. Its fixtures use deliberately artificial dates, names, identifiers, and measurements while preserving the required structural invariants. The branch history was rewritten with explicit user approval so superseded commits containing incident-identical fixture values are not part of the remote branch history. The replacement commit cannot contain its own hash; the task handoff records it after creation.

## RED evidence

The first direct Vitest attempt failed fast before collection because it bypassed the repository integration wrapper:

```text
TEST_DATABASE_URL is required for database-backed integration tests
```

The test was then run through the documented workspace Compose wrapper:

```sh
rtk pnpm test:integration -- packages/server/src/repositories/activity-visibility-consistency.integration.test.ts
```

The first behavioral failure was:

```text
Active activity is missing persisted group identity
```

The shared PostgreSQL-to-ClickHouse test mirror did not project the now-required `group_id`, and singleton visibility fixtures did not seed it. Adding the current column to the shared mirror and explicit singleton group identities repaired the harness without changing production code.

The focused calendar command was:

```sh
rtk pnpm vitest run packages/server/src/repositories/activities-calendar-repository.test.ts
```

It initially reported 26 failures and 35 passes. The first failed assertion received `undefined` because its query mock still recognized the retired raw `fitness.activity` visibility shape. The production repository correctly queries `fitness.v_activity`; updating the mock to that stable-group public contract made all 61 tests pass.

The activity-dedup integration fixture initially returned null `avgHr`, `avgPower`, and `sampleCount`. Its ClickHouse summary test double was keyed by a member ID while the current contract requests summaries by stable group ID. Rekeying the fixture and asserting the exact stable ID request fixed the stale expectation.

The new end-to-end fixture also exposed two current-model harness omissions in sequence:

```text
Unknown expression or function identifier primary_activity_id
Number of columns doesn't match (source: 24 and result: 25)
```

The test `deduped_activities` schema lacked `primary_activity_id`, then its current read-model builder omitted the matching select expression. Adding the current final-schema column and projection resolved both failures.

## Pinned fixture invariants

`activity-details-stable-groups.integration.test.ts` uses the actual MCP server with `InMemoryTransport`, real PostgreSQL, and real ClickHouse test stores. It does not use module mocks or replay heavyweight migration history.

The fixtures prove:

- A deliberately artificial Apple Health + Strong + WHOOP strength group retains seven ordered entries after representative change: five working sets at sequential indexes and two typed rest entries. Its future dates, arbitrary movement labels, loads, repetition counts, and rest durations do not match an observed workout.
- A second strength group remains non-empty even when its representative carries no structured exercise payload.
- Two deliberately artificial WHOOP cycling/commuting + Peloton cardio groups retain the specific `cycling` classification, `commuting` refinement, and distinct non-null heart-rate summaries even though their metadata and sensor evidence are disjoint.
- After structured payload is mirrored to another member and provider priority changes, reconciliation and ClickHouse refresh can change the display representative without changing the persisted stable group ID.
- Re-fetching by stable group ID preserves identity; member and historical alias lookups return the stable ID and expose the requested identifier in `resolved_from`.
- The recursively collected set of populated response-field paths is identical before and after representative change.
- Current ClickHouse `deduped_activities` rows select the payload-bearing WHOOP member rather than the metadata-only Peloton mirror for the commuting fixtures.
- Every final MCP payload is parsed through `activityDetailsOutputSchema`, pinning the test to production field names.

The existing MCP route fixture was also expanded to pin the same three-source provenance, five working sets with two typed rest entries, sensor-summary union, stable identity, and `resolved_from` contract at the focused unit boundary. Its labels and numeric series are deliberately artificial and differ from both the integration fixture and the reported incident.

## GREEN evidence

Focused unit/MCP/calendar tier:

```sh
rtk pnpm vitest run packages/server/src/mcp/route.test.ts packages/server/src/repositories/activities-calendar-repository.test.ts
```

Result: 2 files passed, 128 tests passed.

Focused real-database integration tier, through the workspace Compose wrapper:

```sh
rtk pnpm test:integration -- packages/server/src/mcp/activity-details-stable-groups.integration.test.ts packages/server/src/repositories/activity-visibility-consistency.integration.test.ts packages/server/src/routers/activity-dedup.integration.test.ts
```

Result: 3 files passed, 34 tests passed; PostgreSQL and ClickHouse dependencies were healthy. The new end-to-end fixture also passed alone: 1 file, 1 test, 9.23 seconds.

Static validation:

```sh
rtk pnpm typecheck
```

Result: `TypeScript: No errors found`.

Targeted Biome over the eight changed TypeScript files:

```text
Checked 8 files. No fixes applied.
```

Targeted cspell over the changed files other than the historical incident ledger reported 0 issues. Including the full incident ledger reports 264 pre-existing spelling findings after the sole newly introduced term was corrected. No repository documentation link-check command was found. `rtk git diff --check` completed with no output.

After fixture sanitation, the focused unit/MCP/calendar command was rerun outside
the network sandbox because its test helper binds an ephemeral HTTP listener:

```text
Test Files  2 passed (2)
Tests       128 passed (128)
Duration    1.47s
```

The unchanged in-sandbox attempt provided explicit environmental evidence: no
TCP listener existed, `server.address()` was null, and the untouched first test
ended with `Server address is not an object`. The escalated test run needed no
code or timeout change.

The sanitized real-database command was rerun through the workspace Compose
wrapper:

```text
Test Files  3 passed (3)
Tests       34 passed (34)
Duration    17.70s
```

The post-sanitization `rtk pnpm typecheck` again reported no errors; targeted
Biome again checked eight files with no fixes; and `rtk git diff --check`
remained clean.

An additions-only scan of the aggregate Task 10 diff from `e50995a61` checked
the reported activity dates, movement names, load values, heart-rate values,
sample counts, identifiers, upload filename, upload token, and local upload
path. The search returned exit status 1 with no matches. Provider combinations
and `America/Los_Angeles` remain only where the contract requires them.

## Operational documentation

`docs/activity-data-integrity-repair-runbook.md` now specifies the durable repair order:

1. Reconcile persisted group membership and aliases transactionally in PostgreSQL.
2. Wait for CDC and perform a bounded dependency-aware dbt rebuild/refresh.
3. Verify stable/member/alias resolution, structured and sensor union, and finalized ClickHouse rows.
4. Re-import Strong only when the raw stored source or set rows themselves are proven corrupt.

New operational claims cite the official PostgreSQL transaction documentation, dbt graph-operator documentation, and ClickHouse `FINAL` documentation.

`docs/production-incident-baseline.md` records the generalized symptoms, user impact, captured technical failures, proven representative-coupling causes, implemented code/test repair, local stale-schema evidence, and remaining deployment/historical-refresh risk. Historical attribution of the set-row transposition writer remains explicitly unknown because current parser and persistence fixtures do not reproduce it.

## Remaining risks

- Production deployment and a bounded historical activity-group refresh remain operator work; this task records the safe order but does not claim they have occurred.
- Historical set-row transposition attribution remains unknown until raw stored source rows or historical writer evidence demonstrate the cause.
- The Task 6 repeated stream-tombstone append issue remains intentionally parked for the whole-branch fix pass.
- Remote publication is blocked only by the execution-policy rejection of `git push`; both local commits are ready for the root agent to push.

## Retrospective

What went well: exercising the public MCP contract over current real database models caught test-harness drift that isolated unit tests could not see. Parsing through the production schema made field-name drift fail loudly.

What required investigation: three stale assumptions lived in different layers—the raw mirror omitted `group_id`, the current ClickHouse test model omitted `primary_activity_id`, and mocks keyed visibility/summaries by pre-group member identity. Treating these as one stable-group contract issue led to small fixture-only repairs.

Useful context next time: when the activity read model changes, update the final test table schema, its select builder, raw mirror column list, and summary fixture keys together. A small parity assertion between the current `deduped_activities` test schema and builder output would have surfaced both ClickHouse harness omissions earlier.

Suggested guideline improvement: add that test-schema/builders representing current read models must be changed atomically and exercised once through the real engine. For similar work, use `integration-tests-ready` first and `write-tests` when adding cross-boundary contract fixtures.
