# Activity Source Attribution Domain Model TDD Plan

This plan uses test-first implementation steps. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote activity source attribution from generic provider/id JSON plumbing into a first-class typed read-model contract.

**Behavior:** A deduped activity exposes each member source distinctly, including provider, upstream app/subsource, external id, member activity id, source label, source URL, and removed/absent state, so web and mobile render the same source list without provider-level inference.

**Scope:** Activity source-attribution models, API repository schemas, ClickHouse/dbt and Postgres view projections, and web/mobile source rendering. Non-goals: changing canonical activity storage, changing provider priority, or adding a new ingestion deduplication path.

**Docs:** `docs/production-incident-baseline.md`, `packages/server/src/models/activity-source-attribution.ts`, `packages/server/src/models/activity.ts`, `packages/server/src/repositories/activity-repository.ts`, `packages/server/src/repositories/activities-calendar-repository.ts`, `packages/web/src/pages/ActivityDetailPage.tsx`, `packages/mobile/app/activity/[id].tsx`, `analytics/models/read_models/deduped_activities.sql`, `drizzle/_views/01_v_activity.sql`.

---

## Current Evidence

- The July 2, 2026 Strong strength workout exists in production ClickHouse and is grouped into the same canonical activity as WHOOP cloud and WHOOP Apple Health member rows.
- Current attribution plumbing is split between `source_providers`, `source_external_ids`, `subsource`, and `provider_id`, which encourages clients to collapse multiple Apple Health upstream apps into one provider-level label.
- `ActivitySourceAttribution` already centralizes part of the behavior, but its input is still a generic `source_external_ids` map shape rather than an explicit activity-source read model.
- Before the immediate UI fix, web and mobile source rendering could collapse duplicate provider ids; the longer-term cleanup should make the typed source-attribution contract explicit enough that clients cannot regress to provider-level inference.

## Test Strategy

- Unit: source-attribution model tests cover grouped active sources, duplicate providers with different subsources, provider URL resolution, absent sources, mixed active/absent sources, and deterministic ordering.
- Repository/API: schema tests cover typed activity source rows from Postgres and ClickHouse projections, including `memberActivityId`, `providerId`, `externalId`, `subsource`, and `providerAbsentAt`.
- SQL/read models: SQL text or integration tests verify `deduped_activities` and `v_activity` emit the typed source-attribution shape from member rows.
- UI/mobile/web parity: web and mobile activity detail tests render multiple source entries for Strong via Apple Health, WHOOP via Apple Health, and WHOOP Cloud without collapsing by provider.

## File Structure

- Create: `packages/server/src/models/activity-source.ts` - first-class domain/read-model types for activity member source attribution.
- Modify: `packages/server/src/models/activity-source-attribution.ts` - consume typed source entries instead of generic external-id maps.
- Modify: `packages/server/src/models/activity.ts` - expose the typed source-attribution API shape.
- Modify: `packages/server/src/repositories/activity-repository.ts` - parse typed source-attribution rows with Zod.
- Modify: `packages/server/src/repositories/activities-calendar-repository.ts` - reuse the same typed source-attribution parsing for calendar activity rows.
- Modify: `analytics/models/read_models/deduped_activities.sql` - emit the typed activity source shape for ClickHouse consumers.
- Modify: `drizzle/_views/01_v_activity.sql` and add a migration - emit the typed activity source shape for Postgres consumers.
- Modify: `packages/web/src/pages/ActivityDetailPage.tsx` - render typed source attribution directly.
- Modify: `packages/mobile/app/activity/[id].tsx` - render typed source attribution directly, including duplicate providers with distinct subsources.

## Tasks

### Task 1: Add Failing Domain Model Tests

**Files:**
- Create/modify: `packages/server/src/models/activity-source.test.ts`
- Modify: `packages/server/src/models/activity-source-attribution.test.ts`
- Modify: `packages/server/src/models/activity.test.ts`

- [ ] Define the typed source-attribution behavior through tests before adding the new model.
- [ ] Cover duplicate provider ids with distinct subsources and member ids.
- [ ] Cover active plus absent source behavior without collapsing absent entries incorrectly.
- [ ] Run `rtk pnpm vitest run packages/server/src/models/activity-source.test.ts packages/server/src/models/activity-source-attribution.test.ts packages/server/src/models/activity.test.ts`.
- [ ] Confirm the tests fail for the expected missing typed model or collapsed-source reason.

### Task 2: Add Failing Repository And Read-Model Tests

**Files:**
- Modify: `packages/server/src/repositories/activity-repository.test.ts`
- Modify: `packages/server/src/repositories/activities-calendar-repository.test.ts`
- Modify: `analytics/models/read_models/read_model_microbatch.sql.test.ts`

- [ ] Add repository tests proving rows parse typed source attribution instead of unstructured map entries.
- [ ] Add calendar repository tests for the same source-attribution shape.
- [ ] Add SQL/read-model assertions for `memberActivityId`, `providerId`, `externalId`, `subsource`, and `providerAbsentAt`.
- [ ] Run `rtk pnpm vitest run packages/server/src/repositories/activity-repository.test.ts packages/server/src/repositories/activities-calendar-repository.test.ts analytics/models/read_models/read_model_microbatch.sql.test.ts`.
- [ ] Confirm the tests fail for the expected schema/projection reason.

### Task 3: Add Failing Web And Mobile Parity Tests

**Files:**
- Modify: `packages/web/src/pages/ActivityDetailPage.test.tsx`
- Modify: `packages/mobile/app/activity/[id].test.tsx`

- [ ] Add web activity-detail tests for Strong via Apple Health, WHOOP via Apple Health, and WHOOP Cloud on one deduped activity.
- [ ] Add mobile activity-detail tests for the same source list.
- [ ] Assert duplicate provider ids are rendered as distinct entries when `memberActivityId` or `subsource` differs.
- [ ] Run `rtk pnpm vitest run packages/web/src/pages/ActivityDetailPage.test.tsx`.
- [ ] Run `rtk pnpm test:mobile -- app/activity/[id].test.tsx`.
- [ ] Confirm the tests fail for the expected collapsed-source reason.

### Task 4: Implement The Typed Source-Attribution Contract

**Files:**
- Create: `packages/server/src/models/activity-source.ts`
- Modify: `packages/server/src/models/activity-source-attribution.ts`
- Modify: `packages/server/src/models/activity.ts`
- Modify: `packages/server/src/repositories/activity-repository.ts`
- Modify: `packages/server/src/repositories/activities-calendar-repository.ts`

- [ ] Add a typed activity source entry model with explicit member id, provider id, external id, subsource, absent timestamp, display label, and URL fields.
- [ ] Make repository schemas parse the typed shape with Zod at the runtime boundary.
- [ ] Keep provider label/link resolution in the server domain model so clients only render supplied fields.
- [ ] Keep `sourceProviders` only where a legacy/list-level provider-id summary is still needed.
- [ ] Run the focused server/model/repository tests and confirm they pass.

### Task 5: Update SQL Projections

**Files:**
- Modify: `analytics/models/read_models/deduped_activities.sql`
- Modify: `analytics/models/read_models/read_model_microbatch.sql.test.ts`
- Modify: `drizzle/_views/01_v_activity.sql`
- Create: `drizzle/0040_v_activity_source_subsources.sql`

- [ ] Emit the typed source-attribution shape from deduped activity member rows.
- [ ] Preserve per-member Apple Health upstream app names from `raw.sourceName` with a provider `source_name` fallback.
- [ ] Include absent source entries with the same typed shape and removed timestamp.
- [ ] Run `rtk pnpm migrate` after creating the Drizzle migration.
- [ ] Run `rtk pnpm vitest run analytics/models/read_models/read_model_microbatch.sql.test.ts`.
- [ ] Run `rtk pnpm lint:migrations`.

### Task 6: Render Typed Sources On Web And Mobile

**Files:**
- Modify: `packages/web/src/pages/ActivityDetailPage.tsx`
- Modify: `packages/web/src/pages/ActivityDetailPage.stories.tsx`
- Modify: `packages/mobile/app/activity/[id].tsx`

- [ ] Render `activity.sourceLinks` or its successor typed source list directly on web.
- [ ] Render the same typed source list directly on mobile without looking up links by provider id.
- [ ] Keep removed sources visually distinct on both platforms.
- [ ] Update stories for default, multi-source grouped, and removed-source states where the component has stories.
- [ ] Run the focused web and mobile tests and confirm they pass.

### Task 7: Final Verification

- [ ] Run `rtk pnpm vitest run packages/server/src/models/activity-source.test.ts packages/server/src/models/activity-source-attribution.test.ts packages/server/src/models/activity.test.ts packages/server/src/repositories/activity-repository.test.ts packages/server/src/repositories/activities-calendar-repository.test.ts analytics/models/read_models/read_model_microbatch.sql.test.ts packages/web/src/pages/ActivityDetailPage.test.tsx`.
- [ ] Run `rtk pnpm test:mobile -- app/activity/[id].test.tsx`.
- [ ] Run `rtk pnpm lint`.
- [ ] Run `rtk pnpm tsc --noEmit`.
- [ ] From `packages/server`, run `rtk pnpm tsc --noEmit`.
- [ ] From `packages/web`, run `rtk pnpm tsc --noEmit`.
- [ ] From `packages/mobile`, run `rtk pnpm tsc --noEmit`.
