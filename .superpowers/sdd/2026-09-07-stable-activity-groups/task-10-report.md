# Task 10 report: end-to-end activity identity regression coverage

## Outcome

Task 10 pins the stable activity-group contract through real PostgreSQL and ClickHouse behavior and the public MCP request path. The regression fixtures use synthetic identifiers and current final-schema models. No production behavior was changed to accommodate test doubles, and the parked Task 6 repeated stream-tombstone work was not touched.

Task 10's sanitized base is commit `92e6785f6`, and review-fix implementation
begins at `a32c4d1cc`. Its fixtures use deliberately artificial dates, names,
identifiers, and measurements while preserving the required structural
invariants. Superseded local fixture commits are not ancestors of the sanitized
history. Publication status is recorded at handoff rather than inside this
commit-internal report.

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

Review fix round 1 first made the representative-invariance assertion
non-vacuous. The focused real-engine test failed because the response contained
only `Fixture Movement Alpha` when the expected union also required the
independently seeded `Fixture Movement Delta`. After both disjoint payloads were
seeded before the initial fetch, a direct ClickHouse assertion failed because
the harness selected the synthetic Strong member instead of the third,
sensor-bearing WHOOP member. Those failures proved that the previous fixture
could pass without exercising either structured union or source-attributed
sensor ranking.

## Pinned fixture invariants

`activity-details-stable-groups.integration.test.ts` uses the actual MCP server with `InMemoryTransport`, real PostgreSQL, and real ClickHouse test stores. It does not use module mocks or replay heavyweight migration history.

The fixtures prove:

- A deliberately artificial Apple Health + Strong + WHOOP strength group seeds
  equal-richness but disjoint seven-entry structured payloads on Apple Health and
  Strong before the first fetch. Both arbitrary movement series retain five
  working sets at sequential indexes and two typed rest entries after a
  representative change.
- A second deliberately artificial strength group requested by stable group ID
  returns non-empty structured exercise details that parse through the current
  `activityDetailsOutputSchema`.
- Two deliberately artificial WHOOP cycling/commuting + Peloton cardio groups retain the specific `cycling` classification, `commuting` refinement, and distinct non-null heart-rate summaries even though their metadata and sensor evidence are disjoint.
- Changing only Apple Health and Strong provider priorities after the first
  fetch changes the PostgreSQL display representative without copying or
  changing either structured payload and without changing the stable group ID.
- Re-fetching by stable group ID preserves identity; member and historical alias lookups return the stable ID and expose the requested identifier in `resolved_from`.
- The recursively collected set of populated response-field paths is identical before and after representative change.
- The ClickHouse test schema preserves nullable `deduped_sensor.source_activity_id`.
  Its executable current-model builder applies member/null-provenance sample
  inclusion, excludes an overlapping sample attributed to another group, and
  selects the third sensor-bearing WHOOP member for the strength fixture plus
  WHOOP over metadata-only Peloton for both commute fixtures.
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

Review fix round 1 repeated the focused gates:

```sh
rtk pnpm vitest run packages/server/src/mcp/route.test.ts packages/server/src/repositories/activities-calendar-repository.test.ts
```

Result: 2 files passed, 128 tests passed, 1.35 seconds.

```sh
rtk pnpm test:integration -- packages/server/src/mcp/activity-details-stable-groups.integration.test.ts packages/server/src/repositories/activity-visibility-consistency.integration.test.ts packages/server/src/routers/activity-dedup.integration.test.ts
```

Result: 3 files passed, 34 tests passed, 18.08 seconds. The focused E2E also
passed alone after the final harness change: 1 file, 1 test, 8.60 seconds.
`rtk pnpm typecheck` reported `TypeScript: No errors found`; targeted Biome
checked the three changed TypeScript files with no fixes; and
`rtk git diff --check` produced no output.

Repeated combined real-database attempts were interrupted by a ClickHouse
container OOM at its fixed 1.5 GiB limit. Docker events recorded `container oom`
and exit 137; there was no test assertion failure. The test adapter was still
replaying the retired pre-dbt activity-summary query. Replacing that adapter
with the current member-mapped sensor/location composition removed the memory
spike without changing a resource limit, timeout, or production behavior.

`rtk pnpm lint:analytics-sql` compiled the dbt project successfully, then
reported five existing `ST03` unused-CTE findings in the unchanged
`activity_location_sample.sql`, `activity_location_summary_rows.sql`, and
`activity_stream_points.sql` models. No analytics SQL file changed in this fix;
the changed SQL builders were exercised by the passing real ClickHouse suite.

## Operational documentation

`docs/activity-data-integrity-repair-runbook.md` now specifies the durable repair order:

1. Trigger the executable bounded `start_provider_sync` public operation for an
   affected pull provider so the canonical commit reconciles groups and aliases
   within one transaction.
2. Verify the regular PostgreSQL `fitness.v_activity` view directly before CDC;
   it is not a relational projection to rebuild.
3. Follow the anchored canonical analytics procedure: apply ClickHouse
   migrations 0076 through 0078, verify CDC membership, replay historical
   provenance with the documented bounded microbatch when required, and run
   the retention-aware full refresh in dependency order. The documented
   preflight lookback must be passed explicitly; the default 120-day retention
   is never acceptable for historical repair.
4. Verify stable/member/alias resolution, structured and sensor union, and
   finalized ClickHouse rows.
5. Re-import Strong only when the raw stored source or set rows themselves are
   proven corrupt.

New operational claims cite the official PostgreSQL transaction and `CREATE
VIEW` documentation, dbt graph-operator documentation, and ClickHouse `FINAL`
documentation.

Review fix round 2 changed documentation only. Targeted cspell reported zero
issues across this runbook and report. The repository has no documentation
link-check script; direct internal-link validation found the canonical analytics
heading and the runbook reference to its generated anchor. `rtk git diff
--check` produced no output.

The follow-up documentation correction made the linked analytics procedure
executable without duplicating it in the activity repair runbook. The canonical sequence now
prevents default retention. Selector validation under dbt 1.11.12 and
dbt-clickhouse 1.10.1 resolved the three-model microbatch selection to
`sensor_scalar_sample`, `deduped_sensor`, and `activity_sensor_sample`; the
eleven-model full-refresh selection resolved every named identity, location,
stream, summary, and VO2 max model; and the existing cycling selector resolved
`cycling_activity`. Each `dbt ls` command exited zero. The first in-sandbox
attempt failed before dbt because uv could not read its user cache; the
identical read-only validation outside that filesystem sandbox passed.

`docs/production-incident-baseline.md` records the generalized symptoms, user impact, captured technical failures, proven representative-coupling causes, implemented code/test repair, local stale-schema evidence, and remaining deployment/historical-refresh risk. Historical attribution of the set-row transposition writer remains explicitly unknown because current parser and persistence fixtures do not reproduce it.

## Remaining risks

- Production deployment and a bounded historical activity-group refresh remain operator work; this task records the safe order but does not claim they have occurred.
- Historical set-row transposition attribution remains unknown until raw stored source rows or historical writer evidence demonstrate the cause.
- The Task 6 repeated stream-tombstone append issue remains intentionally parked for the whole-branch fix pass.
- Commit and publication status are recorded in the task handoff rather than
  embedded as a self-referential report SHA.

## Retrospective

What went well: exercising the public MCP contract over current real database models caught test-harness drift that isolated unit tests could not see. Parsing through the production schema made field-name drift fail loudly.

What required investigation: the first round found three stale assumptions in
the raw mirror, final table schema, and group-keyed mocks. Review then exposed
two deeper test-only assumptions: copied structured payload made invariance
vacuous, and the ClickHouse adapter discarded source provenance and replayed a
retired summary query. Executing the fixture against the real engine made both
visible.

Useful context next time: when the activity read model changes, update the final
test table schema, select builder, raw mirror columns, provenance rules, and
summary fixture keys together. Prefer a small current-model composition over
replaying a retired query in integration helpers.

Suggested guideline improvement: add that test-schema/builders representing current read models must be changed atomically and exercised once through the real engine. For similar work, use `integration-tests-ready` first and `write-tests` when adding cross-boundary contract fixtures.
