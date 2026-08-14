# Structured Finger-Loading and Climbing Session Log TDD Plan

> **For agentic workers:** Implement each task test-first. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let athletes quickly record structured finger-loading and climbing-attempt data on web and mobile, then read the canonical records through tRPC and MCP.

**Behavior:** A user can save a finger-loading protocol, repeat the latest protocol, record individual climbing attempts, and inspect recent records. Imported aggregate climbing records keep working while manual attempt detail remains the sole source for its counts and outcomes.

**Scope:** Add canonical Postgres schema, repository and tRPC boundaries, web/mobile entry components and stories, and an activity-scoped MCP read tool. Do not add derived load scores, stored effective load, generic template management, or client-side metric computation.

**Docs:** [Issue #2246](https://github.com/Asherlc/dofek/issues/2246), [`docs/schema.md`](../../schema.md), and [`docs/mcp.md`](../../mcp.md).

---

## Current Evidence

- `fitness.strength_set` models provider-imported conventional strength sets and cannot represent edge size, grip position, laterality, or hang/rest timing.
- `fitness.climbing_entry` stores one imported aggregate per climb with `sent` and `attempt_count`; it cannot represent attempt outcomes or failure reasons.
- The issue explicitly prefers a dedicated finger-loading table and requires canonical raw data, fast repeat entry, dual-platform parity, Storybook coverage, real-Postgres tests, and an MCP read surface.

## Chosen Data Contract

- Add `fitness.finger_loading_entry`, linked to a Dofek-owned activity, with one raw protocol row containing exercise, optional edge size, grip position, signed external load, contemporaneous bodyweight, laterality, set count, hold duration, rest interval, and optional RPE/notes.
- Add wall angle and hold type to `fitness.climbing_entry`.
- Add `fitness.climbing_attempt` child rows with ordered `sent` / `failed` outcomes and nullable failure reasons. Manual climbing entries leave legacy aggregate `sent` / `attempt_count` null; imported aggregate rows continue to populate them. Serving queries derive manual counts and send state from attempt rows.
- Return effective finger load from the server as `bodyweight + signed external load`; never persist it.
- “Repeat last session” reuses the latest server-returned raw protocol as a form preset and creates a new activity. It is not a stored template system.

## Test Strategy

- Unit: Drizzle metadata, Zod inputs, repository mapping, mutation behavior, MCP registration/results, and web/mobile form behavior.
- Integration: Execute migrations and repository/tRPC writes against real Postgres, including constraints, user isolation, derived manual attempt counts, and coexistence with imported aggregate climbing entries.
- UI/mobile/web parity: Both platforms expose finger and climbing forms, explicit mutation errors, repeat-last behavior, and Storybook default/empty/loading/significant variants.

## File Structure

- Modify: `src/db/schema/activity.ts`, `src/db/schema/enums.ts`, `src/db/drizzle-schema.test.ts`
- Add: `drizzle/0063_structured_finger_loading.sql`
- Add: `packages/server/src/repositories/climbing-training-log-repository.ts` and colocated tests
- Modify: `packages/server/src/routers/climbing.ts` and climbing tests
- Modify: `packages/server/src/mcp/tools.ts`, `packages/server/src/mcp/route.test.ts`, `docs/mcp.md`
- Add: web/mobile log components with colocated tests and stories; wire them into climbing/training surfaces
- Modify: `docs/schema.md` and generated schema diagrams

## Tasks

### Task 1: Add Failing Schema and Database Tests

- [ ] Add Drizzle metadata assertions for finger entries, climbing-attempt detail, enums, constraints, and indexes.
- [ ] Add real-Postgres integration tests for valid writes, invalid ranges/outcome-reason combinations, cascading deletes, and aggregate/detail coexistence.
- [ ] Run `rtk pnpm test:unit -- src/db/drizzle-schema.test.ts`.
- [ ] Run `rtk pnpm test:integration -- packages/server/src/routers/climbing.integration.test.ts`.
- [ ] Confirm failures name the missing schema and behavior.

### Task 2: Implement Canonical Schema

- [ ] Add enums/tables/relations to the Drizzle source of truth.
- [ ] Add the next registered transaction-compatible migration.
- [ ] Apply it with `rtk pnpm migrate`.
- [ ] Regenerate schema documentation with the repository schema tooling.
- [ ] Re-run the schema and integration tests.

### Task 3: Add Failing Repository and tRPC Tests

- [ ] Test finger logging, latest/recent reads, server-derived effective load, climbing-detail logging, validation, user isolation, and cache invalidation.
- [ ] Run `rtk pnpm test:unit -- packages/server/src/repositories/climbing-training-log-repository.test.ts packages/server/src/routers/climbing.test.ts`.
- [ ] Confirm the tests fail for the missing public behavior.

### Task 4: Implement Repository and tRPC Boundaries

- [ ] Add Zod-validated protected procedures and repository transactions.
- [ ] Preserve imported aggregate climbing behavior while deriving manual attempt summaries from child rows.
- [ ] Re-run focused unit and real-Postgres integration tests.

### Task 5: Add Failing MCP Tests and Tool

- [ ] Test an `activity:read` finger-loading tool schema, scope, date filtering, and server-returned effective loads.
- [ ] Run `rtk pnpm test:unit -- packages/server/src/mcp/route.test.ts`.
- [ ] Implement the tool through the canonical repository and update `docs/mcp.md`.

### Task 6: Add Failing Web and Mobile UI Tests

- [ ] Test fast defaults, repeat-last presetting, add/remove climbing attempts, submitted payloads, pending state, and specific server errors.
- [ ] Run `rtk pnpm test:unit -- packages/web/src/components/FingerLoadingLog.test.tsx packages/web/src/components/ClimbingAttemptLog.test.tsx`.
- [ ] Run `rtk pnpm test:mobile -- packages/mobile/components/FingerLoadingLog.test.tsx packages/mobile/components/ClimbingAttemptLog.test.tsx`.
- [ ] Confirm failures precede implementation.

### Task 7: Implement Dual-Platform UI and Stories

- [ ] Add web and mobile components, wire tRPC mutations/queries, and expose them from the existing climbing/training surfaces.
- [ ] Add default, loading, empty/no-previous-session, and significant-variant stories for each new component.
- [ ] Re-run focused web/mobile tests and Storybook builds.

### Task 8: Final Verification and Shipping

- [ ] Run `rtk pnpm lint`.
- [ ] Run `rtk pnpm tsc --noEmit`.
- [ ] Run `rtk pnpm --dir packages/server tsc --noEmit`.
- [ ] Run `rtk pnpm --dir packages/web tsc --noEmit`.
- [ ] Run `rtk pnpm test`.
- [ ] Run `rtk pnpm test:integration`.
- [ ] Run `rtk pnpm storybook:web -- --test`.
- [ ] Run `rtk pnpm storybook:mobile -- --test`.
- [ ] Commit, push, open a PR with `Fixes #2246`, monitor CI/reviews, address feedback, and merge when required checks permit.
