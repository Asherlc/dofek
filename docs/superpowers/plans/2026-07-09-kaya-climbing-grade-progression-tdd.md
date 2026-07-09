# Kaya Rock Climbing Grade Progression TDD Plan

**Goal:** Add a rock climbing training surface backed by Kaya export imports, with full route/problem attempt logs and grade progression for boulders and routes.

**Behavior:** Users can import Kaya CSV export files, the app stores one canonical activity-linked climbing entry per Kaya CSV row, and web/mobile training surfaces show best sent grade progression, volume by grade, and recent climbing sessions.

**Scope:** Include canonical DB schema, grade utilities, Kaya file-import contract, server router APIs, web climbing tab, and mobile parity. Do not add manual climbing entry UI. Do not build a live Kaya API sync. Do not store derived grade ranks or attempt counts. Do not add hangboarding/training-board models. Do not couple canonical storage to Kaya-specific field names beyond provider raw metadata.

**Docs:** Related code paths include `src/db/schema/activity.ts`, `drizzle/0004_merge_strength_workout.sql`, `src/jobs/process-import-job.ts`, `packages/server/src/router.ts`, `packages/web/src/routes/training.tsx`, `packages/web/src/routes/training/strength.lazy.tsx`, `packages/mobile/app/(tabs)/strain.tsx`, and `packages/web/src/components/DataSourcesPanel.tsx`.

---

## Current Evidence

- `fitness.activity` already supports `climbing` and `rock_climbing` activity types, but no structured grade log exists.
- `fitness.strength_set` is the closest existing pattern: activity-linked sport-specific child rows, queried by repositories and surfaced in training/activity UI.
- The upload route already supports file-import jobs for Apple Health, Strong CSV, Cronometer CSV, and Zos app data.
- Web training tabs are route-based under `/training/*`; mobile training currently lives under `packages/mobile/app/(tabs)/strain.tsx`.
- No Kaya provider/importer exists yet. A real Kaya export sample is available at `.context/attachments/TJtqYk/KAYA-Export-1783620805322.csv`; parser tests should be fixture-driven from that CSV shape.
- The observed Kaya export is CSV with header `date,stiffness,rating,ascent_type,attempts,grade,color,climb_name,gym,location,country`. Example dates use JavaScript-style UTC strings such as `Thu Jul 09 2026 15:17:17 GMT+0000 (GMT+00:00)`.
- The observed export rows are bouldering ascents with V-scale grades (`v0` through `v4` in the sample), gym names in `gym`, optional climb names in `climb_name`, optional numeric attempt counts in `attempts`, and many absent values represented as empty CSV fields.

## Test Strategy

- Unit: grade normalization and server-side ranking/formatting for V-scale and Yosemite Decimal System; Kaya parser contract using a real-shape CSV fixture.
- DB/schema: Drizzle table definition, generated SQL/migration constraints, enum-backed constrained columns, cascade delete from `activity`, nullable absent values, and no empty-string defaults.
- Integration: repository/router behavior against a real Postgres test database for grade progression, volume by grade, session summary, and empty states.
- Upload/import: queue typing, job dispatch, provider registration, and importer idempotency using fixtures.
- Web/mobile: render loading, error, empty, and populated states; verify web and mobile surfaces consume the same server API concepts.

## File Structure

- Create/modify `packages/training/src/climbing-grades.ts` and `packages/training/src/climbing-grades.test.ts` for shared grade utilities.
- Modify `packages/training/package.json` to export the climbing grade module.
- Modify `src/db/schema/activity.ts`, add a new Drizzle migration under `drizzle/`, and update `docs/schema.md` / `docs/schema.dbml` / generated schema artifacts as required.
- Create `packages/server/src/repositories/climbing-repository.ts` and `packages/server/src/repositories/climbing-repository.test.ts`.
- Create `packages/server/src/routers/climbing.ts` and `packages/server/src/routers/climbing.test.ts`; register it in `packages/server/src/router.ts` and update router tests/types.
- Create `src/providers/kaya/import.ts`, `src/providers/kaya/import.test.ts`, and `src/providers/kaya/fixtures/representative-export.csv`.
- Modify `src/jobs/queues.ts`, `src/jobs/process-import-job.ts`, `packages/server/src/routes/upload.ts`, and upload/job tests for `kaya-export`.
- Modify provider metadata/import UI in `packages/web/src/components/DataSourcesPanel.tsx` and related tests.
- Create web components for climbing charts/tables under `packages/web/src/components/` with colocated tests and Storybook stories.
- Create `packages/web/src/routes/training/climbing.tsx` and `packages/web/src/routes/training/climbing.test.tsx`; add the tab in `packages/web/src/routes/training.tsx`.
- Add mobile climbing components/screen surface and tests under `packages/mobile/`, reusing existing Training tab conventions.

---

## Task 1: Add Shared Grade Utility Failing Tests

**Files:**
- Create: `packages/training/src/climbing-grades.test.ts`
- Create later: `packages/training/src/climbing-grades.ts`
- Modify later: `packages/training/package.json`

- [ ] Write failing tests for V-scale parsing:
  - `VB`, `V0`, `V1`, `V5`, and `V10` return normalized display grades and computed sort values.
  - Case and whitespace are normalized.
  - Invalid labels return `null`, not sort value `0`.
- [ ] Write failing tests for Yosemite Decimal System parsing:
  - `5.6`, `5.10a`, `5.10b`, `5.10c`, `5.10d`, `5.11a`, and `5.12-` sort in ascending order.
  - Plus/minus variants normalize to deterministic neighboring sort values.
  - Invalid labels return `null`.
- [ ] Write failing tests for display formatting:
  - UI receives normalized readable grades such as `V5` and `5.10c`.
  - Internal numeric sort values are returned only by helper/API logic and are never stored as canonical DB data.
- [ ] Run:

```bash
rtk pnpm test -- run packages/training/src/climbing-grades.test.ts
```

- [ ] Confirm the tests fail because `climbing-grades.ts` does not exist.

## Task 2: Implement Minimal Grade Utilities

**Files:**
- Create: `packages/training/src/climbing-grades.ts`
- Modify: `packages/training/package.json`

- [ ] Implement `parseClimbingGrade(input)` returning a discriminated result with `gradeSystem`, normalized `grade`, and a computed sort value, or `null`.
- [ ] Implement dedicated V-scale and Yosemite Decimal System parsers internally; do not use `any` or double casts.
- [ ] Export only production-useful functions from `@dofek/training/climbing-grades`.
- [ ] Run:

```bash
rtk pnpm test -- run packages/training/src/climbing-grades.test.ts
rtk pnpm --filter @dofek/training typecheck
```

- [ ] Confirm tests and typecheck pass.

## Task 3: Add DB Schema Failing Tests

**Files:**
- Modify: `src/db/drizzle-schema.test.ts`
- Create later: `drizzle/0047_climbing_entry.sql` or next available migration number
- Modify later: `src/db/schema/activity.ts`

- [ ] Add tests asserting `fitness.climbing_entry` exists in Drizzle schema with one row per climb attempt:
  - `id uuid primary key`
  - `activity_id uuid not null references fitness.activity(id) on delete cascade`
  - `external_id text`
  - `climb_type climbing_climb_type not null`
  - `grade_system climbing_grade_system not null`
  - `grade text not null`
  - `sent boolean not null`
  - `route_name text`
  - `location_name text`
  - `source_name text`
  - `raw jsonb`
  - `created_at timestamptz not null default now()`
- [ ] Add tests or migration-policy assertions for:
  - no `NOT NULL DEFAULT ''` string columns
  - unique import identity on `(activity_id, external_id)` when `external_id` is not null
  - `climbing_climb_type` enum allows only `boulder` and `route`
  - `climbing_grade_system` enum starts with `v_scale`, `yds`, `font`, and `french`
  - `grade` has a check constraint enforcing non-empty trimmed text
  - nullable text fields (`external_id`, `route_name`, `location_name`, `source_name`) have check constraints that reject empty strings when present
  - index on `(activity_id)` and query-oriented index on `(climb_type, grade_system, grade)`
- [ ] Run:

```bash
rtk pnpm test -- run src/db/drizzle-schema.test.ts scripts/migration-policy.test.ts
```

- [ ] Confirm tests fail because the table/migration does not exist.

## Task 4: Implement Climbing Entry Schema and Migration

**Files:**
- Modify: `src/db/schema/activity.ts`
- Add: next `drizzle/00xx_climbing_entry.sql`
- Modify generated schema docs/artifacts if required by existing migration workflow.

- [ ] Add `climbingEntry` Drizzle table near `strengthSet`, since it is also activity-linked sport detail.
- [ ] Add SQL migration with `CREATE TYPE` enum definitions, table, indexes, check constraints, and cascade foreign key.
- [ ] Add Drizzle enum definitions in `src/db/schema/enums.ts` or the local schema module, following existing enum organization.
- [ ] Constrain every DB column as tightly as the current requirements allow: use `not null`, enum types, foreign keys, unique indexes, and check constraints rather than app-only validation.
- [ ] Do not add `grade_rank`, `attempt_count`, or generic `style` columns.
- [ ] Do not add provider-specific Kaya columns to canonical tables; store provider-only payload in `raw`.
- [ ] Run:

```bash
rtk pnpm test -- run src/db/drizzle-schema.test.ts scripts/migration-policy.test.ts
rtk pnpm typecheck
```

- [ ] Confirm tests and typecheck pass.

## Task 5: Add Repository Failing Tests

**Files:**
- Create: `packages/server/src/repositories/climbing-repository.test.ts`
- Create later: `packages/server/src/repositories/climbing-repository.ts`

- [ ] Use repository unit tests for SQL shape where existing server tests mock `db.execute`.
- [ ] Add integration tests if the behavior depends on Postgres semantics:
  - seed `fitness.activity` rows for one user and `fitness.climbing_entry` attempt rows for `boulder` and `route` climb types.
  - assert cascade-delete behavior if not already covered by migration tests.
- [ ] Test `getGradeProgression(days)`:
  - returns separate boulder and route rows.
  - excludes unsent entries from best sent grade.
  - keeps the best sent grade per session/date.
  - returns normalized grades plus computed server-side sort values for charting.
- [ ] Test `getVolumeByGrade(days)`:
  - groups by climb type, grade system, and normalized grade.
  - counts attempts as row counts.
  - counts sends as rows where `sent = true`.
  - returns computed server-side sort values for ordering.
- [ ] Test `getSessionSummaries(days)`:
  - returns session date/name/location, sends, attempts, hardest sent boulder grade, hardest sent route grade.
  - returns empty arrays when no climbing entries exist.
- [ ] Run:

```bash
rtk pnpm test -- run packages/server/src/repositories/climbing-repository.test.ts
```

- [ ] Confirm tests fail because the repository does not exist.

## Task 6: Implement Climbing Repository

**Files:**
- Create: `packages/server/src/repositories/climbing-repository.ts`

- [ ] Implement domain models similar to `StrengthRepository` models, with private `#` members.
- [ ] Query `fitness.v_activity` joined to `fitness.climbing_entry` through `activity_id = ANY(a.member_activity_ids)` so deduped/grouped activities behave like strength sets.
- [ ] Use `executeWithSchema()` and Zod schemas for raw SQL result validation.
- [ ] Scope every query by `user_id`, timezone, and selected `days`.
- [ ] Do not compute chart values in clients; return all display grades, computed sort values, counts, and totals from the server.
- [ ] Run:

```bash
rtk pnpm test -- run packages/server/src/repositories/climbing-repository.test.ts
rtk pnpm --filter dofek-server typecheck
```

- [ ] Confirm tests and typecheck pass.

## Task 7: Add Router Failing Tests

**Files:**
- Create: `packages/server/src/routers/climbing.test.ts`
- Modify: `packages/server/src/router.test.ts`
- Create later: `packages/server/src/routers/climbing.ts`

- [ ] Add tests for `climbing.gradeProgression({ days })`, `climbing.volumeByGrade({ days })`, and `climbing.sessionSummary({ days })`.
- [ ] Mock or seed the repository consistently with nearby router tests.
- [ ] Assert response types include:
  - `ClimbingGradeProgressionRow`
  - `ClimbingVolumeByGradeRow`
  - `ClimbingSessionSummaryRow`
- [ ] Add `packages/server/src/router.test.ts` expectation that `appRouter` exposes `climbing`.
- [ ] Run:

```bash
rtk pnpm test -- run packages/server/src/routers/climbing.test.ts packages/server/src/router.test.ts
```

- [ ] Confirm tests fail because the router is not registered.

## Task 8: Implement Climbing Router and Public Types

**Files:**
- Create: `packages/server/src/routers/climbing.ts`
- Modify: `packages/server/src/router.ts`
- Modify: `packages/server/src/types.ts` if needed by existing export conventions.

- [ ] Add cached protected queries with `{ days: z.number().default(90) }`.
- [ ] Return repository `.toDetail()` results without client-side reshaping.
- [ ] Register `climbing: climbingRouter` in `appRouter`.
- [ ] Export public response interfaces from the router or types module following existing patterns.
- [ ] Run:

```bash
rtk pnpm test -- run packages/server/src/routers/climbing.test.ts packages/server/src/router.test.ts
rtk pnpm --filter dofek-server typecheck
```

- [ ] Confirm tests and typecheck pass.

## Task 9: Add Kaya Parser Contract Failing Tests

**Files:**
- Create: `src/providers/kaya/import.test.ts`
- Create later: `src/providers/kaya/import.ts`
- Create: `src/providers/kaya/fixtures/representative-export.csv`

- [ ] Create the representative fixture from the real Kaya export shape:
  - Header must be exactly `date,stiffness,rating,ascent_type,attempts,grade,color,climb_name,gym,location,country`.
  - Include the attached sample rows or a reduced subset that preserves the same column order, empty fields, date format, repeated gym sessions, repeated climbs, named climbs, unnamed climbs, and populated `attempts` values.
  - Keep the fixture as CSV, not JSON, because Kaya exports CSV.
- [ ] Add parser tests that transform the fixture into canonical import records:
  - group rows into climbing activities by `gym` plus calendar day derived from the UTC `date` timestamp; use the earliest row time as activity start and the latest row time as activity end.
  - generate deterministic provider external ids from stable row/session data because the export does not include explicit Kaya ids.
  - activity name should be human-readable, for example `Kaya climbing at Touchstone Pacific Pipe`, with `gym` as the location name.
  - map observed rows to `climb_type = "boulder"` because the sample uses V-scale grades and contains no route-specific type column.
  - normalize lowercase V-scale grades such as `v0`, `v3`, and `v4` to `V0`, `V3`, and `V4` with `grade_system = "v_scale"`.
  - set `sent = true` for observed sent ascent types: `Redpoint`, `Repeat`, and `Onsight`.
  - use `climb_name` as `route_name` when present and `null` when the CSV field is empty.
  - preserve `color`, `stiffness`, `rating`, `ascent_type`, `attempts`, `gym`, `location`, `country`, and the original raw date string in each entry's `raw` payload.
  - do not expand the numeric `attempts` column into multiple canonical attempt rows; one Kaya CSV row becomes one canonical climbing entry, and the original `attempts` value remains raw provider metadata unless product requirements later choose a canonical attempt-count model.
- [ ] Add tests that reject or report invalid rows with specific messages:
  - missing `date`
  - invalid Kaya date string
  - missing `gym`, because `gym` is the only reliable session/location grouping key in the observed export
  - unsupported grade
  - unsupported ascent type when it cannot be mapped to sent status
  - malformed CSV rows or unexpected headers
- [ ] Run:

```bash
rtk pnpm test -- run src/providers/kaya/import.test.ts
```

- [ ] Confirm tests fail because the importer does not exist.

## Task 10: Implement Kaya Parser Contract

**Files:**
- Create: `src/providers/kaya/import.ts`
- Create: `src/providers/kaya/fixtures/representative-export.csv`
- Modify: `package.json` exports if importer needs package-level access.

- [ ] Implement pure parsing functions first; keep DB writes separate.
- [ ] Parse CSV with an RFC 4180-compatible parser path that handles quoted fields, empty fields, CRLF/LF line endings, and optional BOM.
- [ ] Use Zod after CSV decoding to validate row objects because Kaya export data is runtime input.
- [ ] Treat empty CSV fields as `null` for optional string and numeric fields; never convert absent values to empty strings.
- [ ] Parse Kaya dates from strings like `Mon Jul 06 2026 22:21:59 GMT+0000 (GMT+00:00)` and fail loudly when the date is invalid.
- [ ] Parse and normalize grades through `@dofek/training/climbing-grades`.
- [ ] Infer bouldering from V-scale grades in the observed export; do not invent a route inference rule for Kaya until a route CSV sample exists.
- [ ] Preserve one output entry per Kaya CSV row; do not aggregate rows during import and do not expand the `attempts` count into synthetic rows.
- [ ] Create deterministic row/session external ids with a stable hash of source fields such as date, gym, climb name, grade, color, ascent type, and row index.
- [ ] Return structured parse errors; do not silently skip invalid records.
- [ ] Preserve original provider rows in `raw`.
- [ ] Run:

```bash
rtk pnpm test -- run src/providers/kaya/import.test.ts packages/training/src/climbing-grades.test.ts
rtk pnpm typecheck
```

- [ ] Confirm tests and typecheck pass.

## Task 11: Add Kaya Import Job Failing Tests

**Files:**
- Modify: `src/jobs/queues.test.ts`
- Modify: `src/jobs/process-import-job.test.ts`
- Modify: `packages/server/src/routes/upload.test.ts`
- Modify later: `src/jobs/queues.ts`
- Modify later: `src/jobs/process-import-job.ts`
- Modify later: `packages/server/src/routes/upload.ts`

- [ ] Add `ImportJobData.importType` coverage for `kaya-export`.
- [ ] Add `processImportJob` test that dispatches `kaya-export` to `importKayaExportFile`.
- [ ] Add upload route tests for:
  - `POST /kaya-export` accepts `.csv` files with `text/csv` or the existing browser upload content type used by nearby file-import tests.
  - `GET /kaya-export/status/:jobId` returns status only for the authenticated user.
  - bad file extension/content type fails loudly with a specific message that says Kaya imports require a CSV export.
- [ ] Run:

```bash
rtk pnpm test -- run src/jobs/queues.test.ts src/jobs/process-import-job.test.ts packages/server/src/routes/upload.test.ts
```

- [ ] Confirm tests fail because `kaya-export` is not supported.

## Task 12: Implement Kaya Import Job and Upload Route

**Files:**
- Modify: `src/jobs/queues.ts`
- Modify: `src/jobs/process-import-job.ts`
- Modify: `packages/server/src/routes/upload.ts`

- [ ] Add `kaya-export` to the import job type union.
- [ ] Dispatch to the Kaya importer with user context.
- [ ] Add upload and status routes consistent with existing file-import routes.
- [ ] Restrict Kaya upload handling to CSV exports; do not add JSON support unless Kaya provides a real JSON export.
- [ ] Keep validation strict; missing prerequisites must fail loudly.
- [ ] Run:

```bash
rtk pnpm test -- run src/jobs/queues.test.ts src/jobs/process-import-job.test.ts packages/server/src/routes/upload.test.ts
rtk pnpm typecheck
```

- [ ] Confirm tests and typecheck pass.

## Task 13: Add Provider Import UI Failing Tests

**Files:**
- Modify: `packages/web/src/components/DataSourcesPanel.test.tsx`
- Modify later: `packages/web/src/components/DataSourcesPanel.tsx`
- Modify later: provider metadata files if import-only providers are declared outside the panel.

- [ ] Add tests that Kaya appears as a file-import source.
- [ ] Assert the upload URL and status URL point to the Kaya upload route.
- [ ] Assert UI copy makes clear this is a Kaya export import, not live account sync.
- [ ] Run:

```bash
rtk pnpm test -- run packages/web/src/components/DataSourcesPanel.test.tsx
```

- [ ] Confirm tests fail because Kaya import is not listed.

## Task 14: Implement Kaya Import UI

**Files:**
- Modify: `packages/web/src/components/DataSourcesPanel.tsx`
- Modify provider metadata files if needed.

- [ ] Add Kaya to file import configs using the existing `FileImportZone` pattern.
- [ ] Do not add OAuth/connect controls for Kaya.
- [ ] Use layman-readable text; avoid unexplained acronyms.
- [ ] Run:

```bash
rtk pnpm test -- run packages/web/src/components/DataSourcesPanel.test.tsx
rtk pnpm --filter dofek-web typecheck
```

- [ ] Confirm tests and typecheck pass.

## Task 15: Add Web Climbing Component Failing Tests

**Files:**
- Create: `packages/web/src/components/ClimbingGradeProgressionChart.test.tsx`
- Create: `packages/web/src/components/ClimbingVolumeByGradeChart.test.tsx`
- Create: `packages/web/src/components/ClimbingSessionSummaryTable.test.tsx`
- Create later matching component files and `.stories.tsx` files.

- [ ] Test grade progression chart:
  - renders empty state for no data.
  - renders separate boulder and route series/sections.
  - displays normalized grades rather than raw sort values.
- [ ] Test volume-by-grade chart:
  - renders sends, attempts, and total entries.
  - orders grades by computed sort value.
- [ ] Test session summary table:
  - renders location, sends, attempts, hardest boulder grade, hardest route grade.
  - links sessions to activity detail when an activity id is present.
- [ ] Run:

```bash
rtk pnpm test -- run packages/web/src/components/ClimbingGradeProgressionChart.test.tsx packages/web/src/components/ClimbingVolumeByGradeChart.test.tsx packages/web/src/components/ClimbingSessionSummaryTable.test.tsx
```

- [ ] Confirm tests fail because components do not exist.

## Task 16: Implement Web Climbing Components and Stories

**Files:**
- Create: `packages/web/src/components/ClimbingGradeProgressionChart.tsx`
- Create: `packages/web/src/components/ClimbingGradeProgressionChart.stories.tsx`
- Create: `packages/web/src/components/ClimbingVolumeByGradeChart.tsx`
- Create: `packages/web/src/components/ClimbingVolumeByGradeChart.stories.tsx`
- Create: `packages/web/src/components/ClimbingSessionSummaryTable.tsx`
- Create: `packages/web/src/components/ClimbingSessionSummaryTable.stories.tsx`

- [ ] Implement compact dashboard-style components matching existing training tab visuals.
- [ ] Use existing `DofekChart`, `ActivityTable`, chart theme, skeleton, and `QueryStatePanel` patterns where appropriate.
- [ ] Keep chart calculations server-driven; clients only render grades, computed sort values, and counts returned by API.
- [ ] Add Storybook stories for default, loading, empty, and meaningful variant states.
- [ ] Run:

```bash
rtk pnpm test -- run packages/web/src/components/ClimbingGradeProgressionChart.test.tsx packages/web/src/components/ClimbingVolumeByGradeChart.test.tsx packages/web/src/components/ClimbingSessionSummaryTable.test.tsx
rtk pnpm --filter dofek-web typecheck
```

- [ ] Confirm tests and typecheck pass.

## Task 17: Add Web Training Tab Failing Tests

**Files:**
- Create: `packages/web/src/routes/training/climbing.test.tsx`
- Modify: `packages/web/src/routes/training/index.test.tsx` or route layout tests as needed
- Create later: `packages/web/src/routes/training/climbing.tsx`
- Modify later: `packages/web/src/routes/training.tsx`

- [ ] Test `/training/climbing` queries:
  - `trpc.climbing.gradeProgression`
  - `trpc.climbing.volumeByGrade`
  - `trpc.climbing.sessionSummary`
  - `trpc.activity.list` filtered to `["climbing", "rock_climbing"]`
- [ ] Test route renders four sections:
  - Grade Progression
  - Volume by Grade
  - Recent Climbing Sessions
  - Recent Climbing Activities
- [ ] Test errors show `QueryStatePanel` only for the failing section.
- [ ] Test the training tabs include `Climbing`.
- [ ] Run:

```bash
rtk pnpm test -- run packages/web/src/routes/training/climbing.test.tsx packages/web/src/routes/training/index.test.tsx
```

- [ ] Confirm tests fail because the route/tab does not exist.

## Task 18: Implement Web Training Climbing Tab

**Files:**
- Create: `packages/web/src/routes/training/climbing.tsx`
- Modify: `packages/web/src/routes/training.tsx`

- [ ] Add `/training/climbing` route using existing training section/card conventions.
- [ ] Add `Climbing` to the subtabs near other sport-specific tabs.
- [ ] Use `useTrainingDays()` for all climbing queries.
- [ ] Filter recent activities to `climbing` and `rock_climbing`.
- [ ] Run:

```bash
rtk pnpm test -- run packages/web/src/routes/training/climbing.test.tsx packages/web/src/routes/training/index.test.tsx
rtk pnpm --filter dofek-web typecheck
```

- [ ] Confirm tests and typecheck pass.

## Task 19: Add Mobile Climbing Surface Failing Tests

**Files:**
- Create/modify mobile tests near the chosen Training surface, likely `packages/mobile/app/(tabs)/strain.test.tsx` or a new colocated climbing screen test.
- Create later mobile climbing components.

- [ ] Decide implementation shape before tests:
  - If keeping a single Training tab, add a segmented control or section navigation inside `strain.tsx`.
  - If adding a separate route under Training, keep it reachable from the Training tab without adding a new bottom tab.
- [ ] Add tests that the mobile surface renders:
  - best sent grade progression
  - volume by grade
  - recent climbing sessions
  - loading, empty, error, and populated states
- [ ] Add tests that mobile consumes the same `climbing` router data and does not compute grade sort values from raw logs.
- [ ] Run:

```bash
rtk pnpm test:mobile -- packages/mobile/app/(tabs)/strain.test.tsx
```

- [ ] Confirm tests fail because the climbing surface does not exist.

## Task 20: Implement Mobile Climbing Surface

**Files:**
- Modify/create mobile screen/components under `packages/mobile/`.
- Add colocated Storybook stories for new visual components under `packages/mobile/components/` if components are placed there.

- [ ] Implement the smallest mobile surface that preserves parity with web.
- [ ] Reuse existing `DaySelector`, `QueryStatePanel`, card styles, and activity card/list conventions.
- [ ] Keep text layman-readable: use “Best Boulder Grade”, “Best Route Grade”, “Attempts”, and “Sends”.
- [ ] Do not implement mobile file upload unless existing file import UI can support it cleanly; provider/import management may remain web-only for v1.
- [ ] Run:

```bash
rtk pnpm test:mobile -- packages/mobile/app/(tabs)/strain.test.tsx
rtk pnpm --filter dofek-mobile typecheck
```

- [ ] Confirm tests and typecheck pass.

## Task 21: Add Server Integration Coverage

**Files:**
- Modify or create integration tests under `packages/server/src/routers/`.

- [ ] Start dependencies before integration tests:

```bash
rtk docker compose up -d db redis
rtk docker compose ps db redis
```

- [ ] Add integration test fixtures with real `fitness.activity` and `fitness.climbing_entry` rows.
- [ ] Verify router calls return correct grade progression, volume, and session summaries from the real database.
- [ ] Verify deleting an activity cascades climbing entries.
- [ ] Run:

```bash
rtk pnpm test -- run packages/server/src/routers/climbing.integration.test.ts
```

- [ ] Confirm integration tests pass against the real local database.

## Task 22: Final Verification

- [ ] Run targeted tests:

```bash
rtk pnpm test -- run packages/training/src/climbing-grades.test.ts src/db/drizzle-schema.test.ts scripts/migration-policy.test.ts src/providers/kaya/import.test.ts src/jobs/queues.test.ts src/jobs/process-import-job.test.ts packages/server/src/repositories/climbing-repository.test.ts packages/server/src/routers/climbing.test.ts packages/server/src/router.test.ts packages/web/src/components/DataSourcesPanel.test.tsx packages/web/src/routes/training/climbing.test.tsx
```

- [ ] Run mobile targeted tests:

```bash
rtk pnpm test:mobile -- packages/mobile/app/(tabs)/strain.test.tsx
```

- [ ] Run package typechecks:

```bash
rtk pnpm --filter @dofek/training typecheck
rtk pnpm --filter dofek-server typecheck
rtk pnpm --filter dofek-web typecheck
rtk pnpm --filter dofek-mobile typecheck
```

- [ ] Run full required pre-push checks before any push:

```bash
rtk pnpm lint
rtk pnpm test:unit
rtk pnpm test:mobile
rtk pnpm typecheck
```

- [ ] Review generated route/tree/schema artifacts and commit only intentional changes.

## Acceptance Criteria

- [ ] Kaya export import is represented as a file-import provider and dispatches through the existing queued upload system.
- [ ] Canonical climbing entries are activity-linked, provider-agnostic, and store one raw Kaya CSV row per climbing entry without duplicating generic activity fields or derived grade ranks.
- [ ] Climbing DB columns are constrained as tightly as possible with enums, foreign keys, uniqueness, `not null`, and non-empty text checks where applicable.
- [ ] V-scale and Yosemite Decimal System grade progression are separate and server-computed.
- [ ] Web `/training/climbing` and the mobile Training surface both show grade progression, volume by grade, and recent climbing sessions.
- [ ] No manual climbing entry UI is added.
- [ ] Kaya parser tests use the real observed CSV export shape, including header validation, empty fields, Kaya date strings, lowercase V-scale grades, and bouldering inference.

## Open Implementation Notes

- The first implementation should use the next available migration number, not hard-code `0047` if another migration lands first.
- If a future Kaya export differs from the observed CSV fixture, update only the Kaya adapter and its fixture tests; do not reshape canonical `climbing_entry` unless the canonical model cannot represent real data.
- If mobile route structure becomes contentious, keep the bottom tab count unchanged and add climbing inside the existing Training tab experience.
- If adding manual entry starts to look useful during implementation, stop and ask; it is explicitly out of scope for this plan.
