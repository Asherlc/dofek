# Activities Workout Agenda Implementation Plan

> **For agentic workers:** Use the approved Paseo implementer workflow and red-green tests. Steps use checkboxes to track delivery.

**Goal** — Show read-only planned workouts alongside completed activities under the same Activities date headings on web and iOS.

**Architecture** — Keep completed cards and pagination on the existing activity query. Read planned workouts from the existing PostgreSQL repository with inclusive date bounds and an independent query state. The completed page defines which dates belong to it, and both clients use the same small presentation helper to combine the buckets.

**Tech stack** — TypeScript, tRPC, Postgres, ClickHouse, React, React Native, Vitest, and Storybook.

**Spec** — [Approved canvas](../../../design/activities-week-agenda/design.json) and [provider goals and calendar design](../specs/2026-11-21-provider-goals-and-calendar-design.md).

## Global constraints

- Use the existing web select and iOS inline chips. Default to **This week** (Monday–Sunday). Keep **4 weeks**, **8 weeks**, and **12 weeks** as inclusive lookback periods ending today. **Next 90 days** covers tomorrow through today plus 90 days. Use the existing Activities local date anchor for both reads and preserve provider-local day labels.
- Use the existing activity card, source disclosure, details links, sport filter, search, bulk actions, and analytics. Planned rows are read-only and never selectable or counted in activity totals. Search remains the existing completed history search. The selected sport applies to both datasets.
- Retain the current Postgres schema, Intervals.icu OAuth and ingestion code, and existing completed records, export, and erasure paths. A disconnected plan displays its source and last confirmed import date. Production activation requires an approved OAuth app, configured keys, and verified populated `CALENDAR:READ` responses.
- Preserve the rows for a successful selected range during a refetch or failure in either feed. Give each successful result its own date bounds and never mix results from different ranges or pages while changing the selection.
- Keep A/B/C races and weekly time, distance, and load targets on the roadmap after the workout calendar. Retire stale Daily Brief, morning reminder, and Data Trust Center roadmap references. Leave provider semantics that require authorized evidence open.

## Review focus

- A day split across activity pages shows its planned rows once, on its first page.
- Days containing only plans, including the entire future range, render and remain navigable.
- The same-day scheduled and recorded rows retain independent IDs, times, sources, and state.
- Loss of scope or disconnection preserves the last imported rows, with snapshot status tied to provider authorization.
- Date boundaries, sport filters, restricted accounts, and independent retry behavior apply equally on both clients.

## Task 1 — Shared date ranges and repository reads

**Files** — `packages/format/src/activity-agenda.ts` plus its test and package export, `packages/server/src/routers/calendar.ts`, `packages/server/src/repositories/{activities-calendar-repository,provider-absent-activities-calendar-repository,activity-calendar-entry,planned-workout-repository}.ts` and nearby tests.

**Interfaces** — Export `ACTIVITY_AGENDA_RANGES` and `activityAgendaRange(preset, today)` from `@dofek/format/activity-agenda`. Use string presets `this-week`, `4-weeks`, `8-weeks`, `12-weeks`, `next-90-days` and return inclusive `{ startDate, endDate, weeks }` with `weeks` equal to 1, 4, 8, or 12 for recorded training overviews and null for the future-only range. Extend `calendar.weekListV2` with optional `startDate` using its existing `endDate`, and return optional `plannedWindow: { startDate, endDate }` for explicit ranges only. Null means the page has no unclaimed plan dates. Extend `calendar.upcomingWorkouts` with optional `dateRange: { startDate, endDate }` and `activityType`. Preserve the legacy input and shape for existing callers by making snapshot metadata optional and add `snapshotImportedAt?: string` on plans from disconnected sources. Add a shared presentation helper, `mergeActivityAgendaDays(completedDays, plannedDays, plannedWindow)`, using structural day shapes and emitting `{ date, activities, workouts }` in descending ISO date order.

- [ ] Add failing unit tests for date presets across Monday, month, year, and DST boundaries, and for date-bucket merging with absent feeds and two entry types on the same date. Use the repo's existing calendar-date helpers.
- [ ] Add failing router/repository tests for explicit inclusive lower/upper bounds, range validation, and completed pagination. In a completed page, the latest eligible plan day is the requested end date on page zero or the day before the previous page's last activity. The earliest eligible day is the selected page's last recorded date when a later page exists, or the range start on the last page. If the interval is inverted, return null. An empty recorded selection owns the whole requested date range. Preserve active and hidden-row legacy behavior for callers without explicit bounds.
- [ ] Add failing real Postgres planned-read coverage for bounds, sport, user and entitlement scope, and the latest import timestamp after disconnect. Use the canonical activity-type mapping already used by Intervals.icu for comparable sport values and preserve authored fields and units. Scope the connection existence check by provider and owner. Use the existing importer-maintained `updated_at` as last confirmation; the display does not assert the vendor is live. Add or update real ClickHouse integration coverage for the new completed date bound and pagination edge.
- [ ] Implement the interfaces. Validate the planned range pair and inclusive length (up to 90 calendar days). Reuse the existing planned step projection and activity grouping. Keep Postgres and ClickHouse reads independently retryable. Do not add tables, migrations, or provider calls.
- [ ] Run focused unit and real engine tests via `rtk pnpm test:unit <paths>` and `rtk pnpm test:integration -- <paths>`. Report exact red and green evidence. Leave patch for lead review and commit.

## Task 2 — Web and iOS Activities

**Files** — `packages/web/src/pages/ActivitiesPage.tsx`, `packages/mobile/app/(tabs)/activities.tsx`, both existing `UpcomingWorkouts` components and their tests/stories, and nearby Activities route tests and fixtures. Extract narrowly scoped components if needed to stay under 1000 lines.

- [ ] Add failing web/mobile tests for the current week mixed date, both dates and source labels, a future-only range, completed-only totals, plan failure with completed content intact, and retaining data during a same-range refetch.
- [ ] Wire both existing pickers to the shared labels and presets. Share explicit date bounds between the completed list and plans. Use existing recorded overview for completed periods and do not show a prior-period overview for the future-only filter. Keep sport values usable for future plans by reusing the latest recorded sport list if present. Page resets on date and sport change.
- [ ] Replace the standalone Upcoming Workouts block with reusable planned cards inside existing day groups. Show **Planned** and **Completed** in the agenda, preserve provider attribution and the workout step disclosure, and show **Snapshot** with the import date for disconnected plans. Do not require any unsupported vendor fields.
- [ ] Preserve completed search, hide/show and bulk operations, and the existing completed detail entry point. Refresh planned reads through existing query lifecycle; preserve errors and retry per feed, and distinguish a successful empty range from a failed read.
- [ ] Run focused web and mobile tests and update matching Storybook states. Report red and green evidence. Leave patch for lead review and commit.

## Task 3 — Review and verification

- [ ] Read the actual diff after each implementation task and fix material findings before continuing. Independently review the whole change.
- [ ] Update the roadmap and the Intervals.icu rollout checklist with confirmed app status and prerequisites. Record exact test results.
- [ ] Run `rtk pnpm lint`, `rtk pnpm --recursive --include-workspace-root --if-present typecheck`, focused unit/mobile and real-engine integration tests. Verify the same seed on both platforms using available browser and iOS tools. Document unavailable checks explicitly.
- [ ] Commit each reviewed chunk and push to `origin/planned-workouts`. Report CI and the provider approval and validation status separately from implementation status.
