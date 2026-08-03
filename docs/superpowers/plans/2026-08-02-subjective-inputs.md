# Subjective Inputs Implementation Plan

> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable subjective check-ins, body symptoms, injury tracking, and session RPE with equivalent web and iOS workflows.

**Architecture:** Postgres owns raw user-entered state in new reference and subjective tables; the server repository and `subjective` tRPC router expose it to both clients. Session RPE updates the existing activity column. An MCP read tool returns only raw subjective state under the existing `health:read` scope.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL, Zod, tRPC, MCP SDK, React, React Native, Vitest.

## Global Constraints

- Do not alter `life_events` or provider body-measurement storage.
- Persist raw subjective entries only; do not add analytics, readiness scores, or client-side calculations.
- All writes and reads are user-scoped and every API boundary has Zod validation.
- `subjective_check_in` presence means logged; an empty symptom set means all clear.
- Symptom scores are integers 1–10; injury severity and activity RPE are nullable-or-integer/real values in 0–10.
- Stable body-region IDs include bilateral hands, thumb-specific nodes, and A1–A5 pulley nodes for each non-thumb finger.
- Keep web and mobile workflows functionally equivalent; reusable UI components have colocated tests and stories.
- Use a new forward-only Drizzle migration and executable database integration tests.

---

### Task 1: Canonical subjective schema and migration

**Files:**
- Modify: `src/db/schema/activity.ts`, `src/db/schema/events.ts`, `src/db/drizzle-schema.test.ts`
- Create: `drizzle/0069_subjective_inputs.sql`, `src/db/subjective-inputs.integration.test.ts`

**Interfaces:**
- Produces: `bodyRegion`, `subjectiveCheckIn`, `subjectiveSymptom`, and `injuryEvent` Drizzle tables.
- Produces: seeded stable body-region IDs consumable by the subjective repository.

- [x] Write integration tests proving RPE rejects values outside 0–10, symptoms reject 0/11, an all-clear check-in can have no symptoms, and injury resolution cannot precede onset.
- [ ] Run `pnpm test:integration src/db/subjective-inputs.integration.test.ts`. Blocked by the shared Docker host's exhausted address pools.
- [x] Add the schema definitions and write the forward-only migration: activity RPE constraint; body-region hierarchy; check-in unique `(user_id, date)`; sparse symptom uniqueness/constraints; injury constraints and indexes; reference data seed.
- [x] Run the migration policy check; the real database integration run remains blocked by Docker network allocation.

### Task 2: Repository and tRPC contracts

**Files:**
- Create: `packages/server/src/repositories/subjective-repository.ts`, `packages/server/src/repositories/subjective-repository.test.ts`, `packages/server/src/routers/subjective.ts`, `packages/server/src/routers/subjective.test.ts`
- Modify: `packages/server/src/repositories/activity-repository.ts`, `packages/server/src/repositories/activity-repository.test.ts`, `packages/server/src/routers/activity.ts`, `packages/server/src/routers/activity.test.ts`, `packages/server/src/router.ts`

**Interfaces:**
- Produces: `subjective.regions`, `subjective.checkIn`, `subjective.saveCheckIn`, `subjective.injuries`, `subjective.createInjury`, `subjective.updateInjury`, `subjective.deleteInjury`, and `subjective.timeline`.
- Produces: `activity.perceivedExertion` read and `activity.setPerceivedExertion` mutation.

- [x] Write repository and router tests for ownership boundaries, out-of-range values, all-clear persistence, date-window ordering, and RPE updates that target a visible canonical activity only.
- [x] Implement Zod schemas, typed repository SQL, transactional check-in upsert-and-replace behavior, injury CRUD, timeline assembly, activity RPE set/read, router registration, and targeted cache invalidation.
- [x] Re-run the focused repository/router tests and confirm they pass.

### Task 3: MCP subjective timeline

**Files:**
- Modify: `packages/server/src/mcp/tools.ts`, `packages/server/src/mcp/route.test.ts`

**Interfaces:**
- Produces: `get_subjective_timeline` MCP tool with `start_date`, `end_date`, and optional timezone input; it requires `health:read`.

- [x] Add focused MCP route coverage proving the tool is listed with the date-window schema.
- [x] Instantiate the subjective repository in the tool, validate the date window, require `health:read`, and return the raw timeline via `jsonContent`.
- [x] Re-run the focused MCP tests and confirm they pass.

### Task 4: Web Tracking and session-RPE workflow

**Files:**
- Create: `packages/web/src/components/SubjectiveTrackingPanel.tsx`, `packages/web/src/components/SubjectiveTrackingPanel.test.tsx`, `packages/web/src/components/SubjectiveTrackingPanel.stories.tsx`, `packages/web/src/components/ActivityPerceivedExertion.tsx`, `packages/web/src/components/ActivityPerceivedExertion.test.tsx`, `packages/web/src/components/ActivityPerceivedExertion.stories.tsx`
- Modify: `packages/web/src/pages/TrackingPage.tsx`, `packages/web/src/pages/ActivityDetailPage.tsx`

**Interfaces:**
- Consumes: the `subjective` and `activity.setPerceivedExertion` contracts from Task 2.
- Produces: a tracking panel that distinguishes loading/error/empty from an all-clear check-in, and an activity RPE editor.

- [x] Write component tests for all-clear save, sparse symptom save, injury creation, and activity RPE save; add colocated Storybook stories.
- [x] Implement accessible controls with targeted query invalidation, Sentry reporting in unexpected mutation error handlers, and server-provided error messages.
- [x] Re-run the focused web tests and confirm they pass.

### Task 5: Mobile Tracking and session-RPE workflow

**Files:**
- Create: `packages/mobile/components/SubjectiveTrackingPanel.tsx`, `packages/mobile/components/SubjectiveTrackingPanel.test.tsx`, `packages/mobile/components/SubjectiveTrackingPanel.stories.tsx`, `packages/mobile/components/ActivityPerceivedExertion.tsx`, `packages/mobile/components/ActivityPerceivedExertion.test.tsx`, `packages/mobile/components/ActivityPerceivedExertion.stories.tsx`
- Modify: `packages/mobile/app/(tabs)/recovery.tsx`, `packages/mobile/app/activity/[id].tsx`

**Interfaces:**
- Consumes: exactly the same `subjective` and activity-RPE contracts as Task 4.
- Produces: native-equivalent check-in, injury, symptom, and session-RPE interactions.

- [x] Extend mobile screen coverage for the new tracking and session-RPE mounts.
- [x] Run the mobile-focused tests; the Recovery and activity detail screen suites pass.
- [x] Implement native accessible controls, targeted invalidation, and `captureException` in unexpected error handling; mount them on Recovery and activity detail.
- [x] Re-run the focused mobile tests and confirm they pass.

### Task 6: Integration verification and review

**Files:**
- Modify: `docs/schema.md` only if it lists the new canonical tables or contracts.

**Interfaces:**
- Verifies: migration, typed API, MCP, and equivalent client workflows together meet the approved design.

- [ ] Run the full Docker-backed integration tier; blocked by exhausted Docker address pools.
- [x] Run focused unit tests, server/web/mobile typechecks, migration policy, Biome, and web Storybook coverage.
- [x] Review the complete diff against this plan: no life-event/provider-measurement duplication, no derived analytics, raw score boundaries enforced, and both platforms expose both workflow classes.
- [x] Commit all issue changes on the working branch with conventional subjects.
