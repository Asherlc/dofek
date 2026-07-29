# Record-Local Time Context TDD Plan

> **Test-first workflow:** Write each failing test before its production change.

**Goal:** Make activity and sleep clock times answerable from each record by storing the resolved start/end UTC offsets, optional IANA timezone, and explicit provenance at ingestion.

**Behavior:** `timestamptz` remains the canonical instant. Activity and sleep records additionally carry independent start/end UTC offsets plus an optional IANA timezone and a source that distinguishes provider/device context from unknown data. Consumers render the record's own local clock time, including sessions that cross a daylight-saving transition, without using the viewer's current timezone or guessing from a user profile.

**Scope:** Issue [#2250](https://github.com/Asherlc/dofek/issues/2250) only. Activity and sleep sessions, their current ingestion writers, Postgres/ClickHouse serving paths, tRPC/MCP contracts, and web/mobile clock-time rendering are included. Other timestamped domains are excluded until a concrete user-facing clock-time requirement is identified.

**Docs:** [Database model](../../schema.md), [provider guide](../../adding-a-provider.md), [testing tiers](../../testing.md), and [PostgreSQL date/time types](https://www.postgresql.org/docs/current/datatype-datetime.html).

---

## Current Evidence

- `fitness.activity.started_at` / `ended_at` and `fitness.sleep_session.started_at` / `ended_at` preserve instants but not the resolved local offset. Activity has an optional `timezone`; sleep has no local-time context.
- The current activity and sleep serving models format timestamps in UTC or the request timezone, so MCP and clients cannot state the record-local clock time reliably after travel or a daylight-saving transition.
- Provider contracts vary. WHOOP explicitly defines `timezone_offset` as the user's offset when a workout was recorded ([WHOOP workout contract](https://developer.whoop.com/docs/developing/user-data/workout/)); Google Fit defines session query bounds as RFC 3339 timestamps ([Google Fit sessions](https://developers.google.com/fit/rest/v1/reference/users/sessions/list)); Apple Health exposes workout start/end as `Date` values without a timezone field in that API surface ([Apple `HKWorkout`](https://developer.apple.com/documentation/healthkit/hkworkout)). Therefore an offset or zone is authoritative only when the specific provider contract or device upload field establishes it as record-local context; timestamp syntax alone is not sufficient.
- Existing activity rows may retain trustworthy timezone/offset fields in `timezone` or `raw`; existing sleep rows generally do not retain raw payloads and therefore must remain explicitly unknown rather than receive an authoritative-looking guess.

## Chosen Design

- Preserve the existing `activity.timezone` column and add nullable `start_utc_offset_minutes`, nullable `end_utc_offset_minutes`, and non-null `local_time_source`.
- Add the same fields plus nullable `timezone` to `sleep_session`.
- Constrain `local_time_source` to `provider_timezone`, `provider_offset`, `device_timezone`, `device_offset`, or `unknown`.
- Resolve start and end offsets independently from a trusted IANA timezone, or store explicitly supplied offsets. Unknown context requires a null timezone and null offsets.
- Prefer the IANA timezone for display; when it is absent, format with the stored fixed offset. Never fall back to the current viewer/profile timezone.
- Inventory every activity and sleep producer. Each writer must intentionally provide trusted provider/device context or rely on the schema's explicit `unknown` default.
- Keep the deploy migration schema-only. Repair existing trustworthy activity rows with a separate bounded, idempotent TypeScript operator command; leave unresolvable records unknown.

## Test Strategy

- Unit: offset parsing, IANA validation, independent start/end resolution, invalid inputs, unknown/null invariants, daylight-saving transition boundaries, and a session straddling a transition.
- Provider/writer contracts: prove every activity/sleep writer supplies mapped trusted context or intentionally writes unknown; verify provider/device-specific mappings retain raw payloads unchanged.
- Postgres integration: verify schema constraints, activity/sleep persistence, deduplicated view projection, unknown behavior, and idempotent bounded backfill.
- ClickHouse integration: verify PeerDB raw-table columns and the `deduped_activities` / `daily_sleep` dbt serving rows retain the selected record's local-time context.
- API/MCP: verify tRPC list/detail/latest results and `search_activities` / `get_sleep_summary` expose the bundle without request-time timezone inference.
- UI parity: verify shared formatting and both web/mobile activity and sleep surfaces render record-local start/end clocks, including fixed-offset fallback and daylight-saving changes.

## File Structure

- Create `packages/format/src/record-local-time.ts` and its colocated unit test for the shared context contract, resolver, and record-local clock formatting.
- Modify `src/db/schema/activity.ts`; add a forward Postgres migration and journal entry.
- Modify the canonical activity view, ClickHouse raw-table/read-model builders, ClickHouse migrations, dbt activity/sleep models, and their executable integration tests.
- Modify every activity/sleep provider writer plus focused provider/writer tests identified by the producer inventory.
- Modify server activity/sleep repositories and models, MCP tools, and focused unit/integration tests.
- Modify the relevant web/mobile activity and sleep components/screens, tests, and stories.
- Create `scripts/backfill-record-local-time-context.ts`, register its package command, and add operator documentation.

## Tasks

### Task 1: Lock the Local-Time Contract with Failing Unit Tests

- [ ] Add the shared context/source types and test cases before implementation.
- [ ] Cover IANA resolution immediately before/after a daylight-saving transition and a session whose start/end offsets differ.
- [ ] Cover provider/device explicit offset parsing, fixed-offset formatting, invalid zones/offsets, and the `unknown` + null invariant.
- [ ] Run `rtk pnpm vitest run packages/format/src/record-local-time.test.ts --project unit`.
- [ ] Confirm the tests fail because the contract/resolver does not exist.

### Task 2: Add Schema and Serving-Model Tests Before Migrations

- [ ] Add Postgres integration fixtures for activity/sleep persisted context, deduplicated projection, and unknown rows.
- [ ] Add ClickHouse integration fixtures for `deduped_activities` and `daily_sleep`, including different start/end offsets.
- [ ] Add migration/read-model tests for the new raw and serving columns.
- [ ] Run `rtk pnpm test:integration -- src/db/record-local-time-context.integration.test.ts src/db/daily-sleep-read-model.integration.test.ts`.
- [ ] Confirm failures identify the missing columns/projections.

### Task 3: Implement Schema-Only Postgres and ClickHouse Migrations

- [ ] Add the columns and database invariants without a historical data update in the deploy migration.
- [ ] Project the selected canonical context through `fitness.v_activity`.
- [ ] Extend PeerDB ClickHouse raw tables, `analytics.v_sleep`, `deduped_activities`, and `daily_sleep`.
- [ ] Run `rtk pnpm migrate`.
- [ ] Run `rtk pnpm analytics:build`, `rtk pnpm lint:migrations`, `rtk pnpm lint:analytics-sql`, and `rtk pnpm lint:analytics-policy`.
- [ ] Re-run the focused schema/read-model tests and confirm they pass.

### Task 4: Inventory Writers and Add Failing Producer Tests

- [ ] Enumerate every production `activity` and `sleep_session` insert/upsert path.
- [ ] Classify each path as trusted provider timezone, provider offset, device timezone, device offset, or unknown based on retained payload semantics.
- [ ] Add focused failing tests for Peloton, MapMyFitness, WHOOP, native Apple Health / Zepp, and each other provider whose documented payload supplies trustworthy local context.
- [ ] Add a static producer-policy test where practical so new writers cannot bypass the intentional context decision.
- [ ] Verify payloads with no trustworthy context explicitly persist `unknown`; do not infer from a user profile or viewer request.
- [ ] Run `rtk pnpm test:unit -- <focused producer test files>`.
- [ ] Confirm failures show the context is not yet mapped.

### Task 5: Implement Minimal Ingestion Mapping

- [ ] Use the shared resolver at each trusted producer boundary and pass resolved context through insert and conflict-update values.
- [ ] Preserve raw provider payloads verbatim where they already exist.
- [ ] Ensure start/end offsets are resolved independently and every unmapped writer lands as `unknown`.
- [ ] Re-run the focused producer tests and confirm they pass.

### Task 6: Add the Bounded, Idempotent Backfill

- [ ] Write failing tests for preview mode, bounded batches, idempotence, trusted existing timezone/raw extraction, and unknown preservation.
- [ ] Implement a TypeScript operator command that updates only records with trustworthy retained context.
- [ ] Document preview/execute usage, evidence output, how to resume, and the deliberate absence of sleep guesses.
- [ ] Run `rtk pnpm vitest run scripts/backfill-record-local-time-context.test.ts --project unit`.
- [ ] Confirm the test passes and preview mode makes no writes.

### Task 7: Expose Context Through tRPC and MCP

- [ ] Add failing repository/router tests for activity list/detail/search and sleep list/latest responses.
- [ ] Add failing MCP tests for `search_activities` and `get_sleep_summary`, including a daylight-saving-straddling sleep.
- [ ] Return the stored bundle unchanged; remove request-time local-clock inference from these results.
- [ ] Run `rtk pnpm vitest run packages/server/src/repositories/activity-repository.test.ts packages/server/src/repositories/sleep-repository.test.ts packages/server/src/mcp/tools.test.ts --project unit`.
- [ ] Run the focused server integration tests and confirm both APIs preserve context.

### Task 8: Render Record-Local Clock Times on Web and Mobile

- [ ] Add failing shared-format tests for IANA preference and fixed-offset fallback.
- [ ] Add/update web tests and stories for activity cards/details and sleep start/end clock labels.
- [ ] Add/update mobile tests and stories for the equivalent activity and sleep surfaces.
- [ ] Use only the shared record-local formatter; do not duplicate time arithmetic in clients.
- [ ] Run `rtk pnpm vitest run <focused web tests> --project unit`.
- [ ] Run `rtk pnpm test:mobile -- <focused mobile tests>`.
- [ ] Confirm both platforms render the record's clock time rather than the test runner/device timezone.

### Task 9: Final Verification and Delivery

- [ ] Run `rtk pnpm lint`.
- [ ] Run `rtk pnpm tsc --noEmit`.
- [ ] Run `rtk pnpm --dir packages/server tsc --noEmit`.
- [ ] Run `rtk pnpm --dir packages/web tsc --noEmit`.
- [ ] Run `rtk pnpm test:changed:all`.
- [ ] Review the diff for provider-agnostic storage, raw-data preservation, dual-platform parity, and absence of profile/viewer-timezone guesses.
- [ ] Commit and push each meaningful passing slice, open a PR with `Fixes #2250`, monitor required checks/reviews, address all actionable feedback, and merge only when permitted.
