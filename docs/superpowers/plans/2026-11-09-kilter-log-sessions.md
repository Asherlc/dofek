# Kilter log sessions implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group native Kilter observations into activities using a 10-minute inactivity gap and connect them to recorded climbing workouts when an actual log falls inside the recording.

**Architecture:** Store raw timestamped log observations as point activity members through the existing provider activity writer. A single SQL projection derives Kilter source sessions; existing connected activity groups supply durable visible identity. No calculated session rows or bounds are written into raw Postgres state.

**Tech stack:** Existing TypeScript, Drizzle, PostgreSQL views, dbt/ClickHouse, React and React Native; no new dependencies, services or secrets.

**Spec:** `docs/superpowers/specs/2026-11-09-kilter-log-sessions-design.md` (approved 10-minute gap and actual-log containment rule).

## Global constraints

- A gap of 10 minutes or more between successive logs starts a new session; this is inactivity, not maximum session length.
- A change in recorded board or gym identity also starts a session. Midnight alone does not.
- A real log timestamp inside an active recorded climbing interval establishes an overlap edge. An unobserved gap, fabricated interval, or different activity type does not.
- Preserve explicit user attachments, source ownership, deletion/absence behavior, raw payloads and original log/attempt identity.
- Raw per-log point activity members are permitted. Derived session rows and calculated bounds remain unpersisted.
- Point members must not acquire default one-hour/twelve-hour workout or sensor windows and must not extend measured duration.
- Keep normal activity matching rules, canonical-commit reconciliation, stable group IDs and aliases. Do not add a background job or an identity framework.
- Web and mobile receive server-computed grouping and window values; clients format and render them.
- Use executable database tests for PostgreSQL/ClickHouse behavior. Start with failing tests, then minimal changes. Do not add static SQL-fragment assertions for executable behavior.
- Stay on the current branch/worktree. Workers do not delegate, switch branches, touch production, or start HTTP servers. Commit each finished task and push automatically.

## Review focus

- Earlier history can change source-session membership without invalidating previously issued raw-member or visible-group links.
- A source observation that is explicitly attached elsewhere must not leave an active orphan member contributing a duplicate session.
- A single point inside a recorded workout matches; two points surrounding a workout with neither inside do not match through their inferred span.
- Point-only sessions have unknown workout duration and do not gather twelve hours of unrelated sensor data.
- Multiple board/gym source sessions can join one workout while retaining their distinct source-session attribution and canonical climb counts.

## Task 1: Import raw observations and connect activity groups

**Files:**
- Modify `src/lib/kilter-board-client.ts` and its unit test.
- Modify `src/db/climbing-log-sync.ts`, `src/db/climbing-log-snapshot.ts`.
- Create `src/db/climbing-log-activity.ts` and `src/db/climbing-log-activity.integration.test.ts`.
- Create `drizzle/_views/02_v_climbing_log_activity.sql` and the next ordered schema-only migration; register it in `drizzle/meta/_journal.json`.
- Modify `src/db/activity-group-reconciliation.ts` and its integration suite.
- Update `src/lib/climbing-board-account.integration.test.ts` for the changed Kilter behavior; retain Aurora behavior.

**Interfaces:**
- Extend `SourceClimbingLogEntry` input with optional `activityObservation: { recordedAt: string; gymExternalId?: string | null }`; validate an offset ISO timestamp. It is input evidence, not a stored log column.
- Consume that field in the persistence writer; never spread it into Drizzle log rows.
- `persistClimbingLogActivityObservation(db, input)` in the new DB module returns the observation activity ID using `upsertProviderActivity`; consume it from the canonical writer. Preserve existing explicit `activityId` when it identifies another source activity.
- Observation members use generic `provider_type = 'climbing_log'`, `canonical_type = 'climbing'`, native log external identity, source timestamp as `started_at`, and null `ended_at`. Keep the upstream payload solely in the existing log raw field; activity raw may retain only the board/gym identity facts actually consumed by session grouping.
- `fitness.v_climbing_log_activity` exposes one row per eligible active point: `user_id`, `provider_id`, `activity_id`, `log_entry_id`, `recorded_at`, `session_id`, `first_logged_at`, `last_logged_at`. `session_id` is the first observation member ID in the source session, not a newly stored identifier.
- The SQL projection is the single owner of the 10-minute source grouping. Reconciliation connects members of each source session and adds actual-point/recorded-climbing containment edges. Keep `src/domain/activity-grouping.ts` unchanged.

- [ ] Write and run failing provider/DB tests for preserving the exact instant, two incident logs 4m33s apart, exact 10-minute split, chained sessions longer than 10 minutes, board/gym changes, midnight/DST, and one-log sessions.
- [ ] Write and run failing integration cases for the actual Kaya–WHOOP–Kilter bridge (first log eight seconds before WHOOP ends, second afterwards), no edge through an empty inferred span, no fabricated interval for a singleton, ownership and non-climbing exclusion.
- [ ] Implement source normalization and raw point-member persistence. Load geographic home timezone with the existing helper for point local-time context. Kilter has timestamp evidence, not a native date-only fact: clear its obsolete UTC-derived `climbedOn`; activity/local-date projections supply the display day.
- [ ] Implement the shared source-session view and graph edges. Exclude point members from normal interval comparisons rather than letting null ends acquire an hour. Use existing canonical-commit reconciliation after sync; do not add post-sync work.
- [ ] Cover repeated sync, earlier history, late connecting logs, absent/empty-authoritative snapshots, restoration, user-deleted observations and pre-existing explicit attachments. Reconcile corresponding source point presence with the shared provider absence helpers; do not hard-delete raw rows.
- [ ] Run `pnpm vitest run src/lib/kilter-board-client.test.ts src/db/activity-group-reconciliation.test.ts src/domain/activity-grouping.test.ts` and `pnpm test:integration src/db/climbing-log-activity.integration.test.ts src/db/activity-group-reconciliation.integration.test.ts src/lib/climbing-board-account.integration.test.ts`.
  Expected: all pass, with real database fixtures and no retries/time-limit changes.
- [ ] Review the actual diff and commit/push after the task review is clean.

## Task 2: Serve honest timing and preserve sensor/analytics semantics

**Files:**
- Modify `drizzle/_views/01_v_activity.sql`; include the replacement in a forward schema-only migration.
- Modify `analytics/models/read_models/deduped_activities.sql`, `activity_duplicate_matches.sql`, and affected sensor models only where point windows are consumed.
- Modify current equivalents in `src/db/clickhouse-read-models.ts`, `src/db/clickhouse-metric-stream-bootstrap.ts`, `packages/server/src/repositories/clickhouse-activity-sensor-store.ts`, and `clickhouse-activity-sensor-analytics.ts` where needed.
- Modify `packages/server/src/repositories/climbing-activity-log-entry-repository.ts`, `packages/server/src/contracts/climbing-log-contracts.ts`, `packages/server/src/models/activity.ts`, `packages/server/src/models/activity-source-tree.ts`, and `packages/server/src/routers/activity.ts` to expose source-session windows through existing detail APIs.
- Modify `packages/server/src/repositories/activity-calendar-entry.ts` and calendar query schemas to make unknown duration nullable.
- Add/update focused colocated tests and real-engine coverage in the existing activity/dedup/sensor integration suites.

**Interfaces:**
- Add `ClimbingLogActivitySession` contract: `{ id: string; providerId: string; memberActivityIds: string[]; firstLoggedAt: string; lastLoggedAt: string }` using existing UUID/timestamp schemas.
- `ClimbingActivityLogEntryRepository.getActivityLogSessions(activityId)` resolves source sessions within the requested visible group, using the shared view, user/access/visibility predicates and original observation identities. Return empty for groups without eligible point observations.
- Add `climbingLogSessions: ClimbingLogActivitySession[]` to activity detail. Source-tree rendering collapses observation nodes into one source node per derived source session, preserving distinct sessions and raw source links.
- `CalendarActivityEntry.durationMin` becomes `number | null`; query/row schemas must retain SQL null rather than coercing it to zero.
- For mixed groups, `started_at` and `ended_at` used for measured workout duration come only from recorded members. For point-only groups, display start is the first log and measured end remains null; first/last observed times are carried in the separate source-session window.

- [ ] Write/run failing real-engine tests proving points before/after a workout do not extend its duration, standalone point duration is null, and the merged group retains all source providers and canonical log IDs exactly once.
- [ ] Write/run failing tests showing point-only groups do not gather unrelated later sensor samples. Retain existing unknown-end behavior for actual workout recordings.
- [ ] Implement matching PostgreSQL/ClickHouse timing and explicit point exclusion in fallback windows. Keep dbt calculations in dbt; use current final-schema test setup, never heavyweight historical migration replay.
- [ ] Implement source-session detail projection and consolidated attribution. Test distinct source sessions connected through one WHOOP record, explicit attachments, late history and source absence.
- [ ] Run focused activity/calendar/source-tree unit tests and corresponding PostgreSQL/ClickHouse integration suites. Run root/server typechecks, `pnpm lint:migrations`, `pnpm lint:analytics-policy`, `pnpm lint:analytics-sql`, and `pnpm analytics:build` with generated local dependencies/environment.
  Expected: green real-engine regressions; no fabricated duration or sensor window; no new serving-path expensive read model.
- [ ] Review the actual diff and commit/push after the task review is clean.

## Task 3: Render source sessions on web and mobile

**Files:**
- Modify `packages/web/src/pages/ActivityDetailPage.tsx`, `packages/web/src/components/ActivityCardContent.tsx` and focused colocated tests/stories.
- Modify `packages/mobile/app/activity/[id].tsx`, `packages/mobile/components/ActivityCard.tsx`, route tests under `packages/mobile/app-tests/`, and focused component tests/stories.
- Update `docs/climbing-providers.md` and `docs/production-incident-baseline.md` with code-cited behavior and validation status.

**Interfaces:** Consume Task 2's server-projected `climbingLogSessions` and nullable calendar duration. Compute no session membership or metric values on either client.

- [ ] Write/run failing web/mobile tests for one connected gym activity with Kaya and Kilter climbs, a standalone Kilter source-session window, a single-log session, and unknown duration without a zero-minute claim.
- [ ] Render each source-session first/last log window with an accurate label such as `Logged climbs`, alongside existing source attribution. Preserve original workout duration when present; make unknown duration explicit for point-only groups. Keep list cards concise and supporting explanations on details.
- [ ] Add paired representative Storybook fixtures, inspect web/mobile renders with browser tools, and test screen-reader labels with visible text. If any HTTP development server is started, run `/Users/asherlc/bin/paseo-quick-tunnel <port>` for its full lifetime and report only its emitted trycloudflare URL, linking directly to the relevant story.
- [ ] Run focused web/mobile suites and both platform typechecks; review the full branch against the approved spec. Fix material findings with failing regressions first, then rerun affected suites.
- [ ] Run required broad checks, update incident status honestly (production recovery is unverified until canonical deployment and account validation), commit and push. Do not merge or deploy without the repository's normal release workflow.

## Working notes

Baseline: 51 focused unit tests and 42 PostgreSQL board/grouping integration tests passed on November 9. The existing workspace is an isolated linked worktree on `fix-kilter-board-activities-missing`; no branch change is needed. Local Compose dependencies were started with the repository wrapper. The `activity` dataset's existing canonical-commit code already calls reconciliation.

Implementation reviews must explicitly check raw observation identity, derived source-session identity, and visible group identity as different grains. The current 80-percent interval matcher remains intact for ordinary recorded activities.
