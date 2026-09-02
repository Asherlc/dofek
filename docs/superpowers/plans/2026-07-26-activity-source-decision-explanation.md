# Activity Source Decision Explanation TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation. If executing this plan task-by-task, also use superpowers:executing-plans or superpowers:subagent-driven-development as appropriate. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** On multi-source activities, show users which record became primary and why priority/deduplication chose it, with identical web and mobile copy.

**Behavior:** `activity.byId` returns a `sourceDecision` object when an activity has two or more source links. The object includes source count, the primary source label, and a concise server-authored explanation. Web and mobile activity detail render the same “How sources were combined” card from that payload. Single-source activities omit the card (`sourceDecision` is `null`).

**Scope:**
- Included: server domain model + `Activity.toDetail()`, web and mobile activity detail UI, colocated unit tests and Storybook stories.
- Non-goals: schema/dbt changes, changing provider priority, a dedicated Trust Center page, processing-status/freshness/history surfaces, “why did this number change?”, or per-metric source contribution.

**Docs:** [Data Trust Center roadmap outcome](../../roadmap.md) (origin/main), `packages/server/src/models/activity.ts`, `packages/server/src/models/activity-source-attribution.ts`, `packages/web/src/pages/ActivityDetailPage.tsx`, `packages/mobile/app/activity/[id].tsx`, `docs/superpowers/plans/2026-07-03-activity-source-attribution-domain-model.md`.

---

## Current Evidence

- Analytics and Postgres views already pick a canonical member by provider/device priority and preserve every matched member in `source_external_ids` / `member_activity_ids`.
- Server already exposes typed `sourceLinks` (label, URL, memberActivityId, absence) via `ActivitySourceAttribution`.
- Web and mobile list those sources on activity detail, but neither explains which record is primary or why.
- Roadmap outcome to complete for this slice: “Explain source conflicts and the priority or deduplication decision that resolved them.”
- No schema change is required; the decision can be derived from existing `providerId`/`subsource` + `sourceLinks`.

## Test Strategy

- Unit: `ActivitySourceDecision` builds explanation for multi-source activities, returns `null` for zero/one source, uses the primary source’s display label, and keeps explanation text server-owned.
- Unit: `Activity.toDetail()` includes `sourceDecision` when applicable.
- UI/web: activity detail renders the card for multi-source fixtures and hides it for single-source.
- UI/mobile: same assertions for parity.
- Stories: default multi-source card and single-source (hidden) coverage for the reusable web component.

## File Structure

- Create: `packages/server/src/models/activity-source-decision.ts` — domain model that derives the user-facing decision from primary source + source links.
- Create: `packages/server/src/models/activity-source-decision.test.ts` — failing-first unit tests.
- Modify: `packages/server/src/models/activity.ts` — attach `sourceDecision` on `ActivityDetail` / `toDetail()`.
- Modify: `packages/server/src/models/activity.test.ts` — assert `sourceDecision` serialization.
- Create: `packages/web/src/components/ActivitySourceDecisionCard.tsx` (+ `.test.tsx`, `.stories.tsx`) — render-only card.
- Modify: `packages/web/src/pages/ActivityDetailPage.tsx` (+ test/stories) — mount the card when `sourceDecision` is present.
- Create: `packages/mobile/app/activity/ActivitySourceDecisionCard.tsx` (+ tests via activity detail) — mobile parity card.
- Modify: `packages/mobile/app/activity/[id].tsx` (+ test) — mount the card when `sourceDecision` is present.
- Modify: `docs/roadmap.md` — check off the completed Data Trust Center outcome after syncing Product Strategy from origin/main if needed.

## Tasks

### Task 1: Add Failing Server Domain Tests

**Files:**
- Create: `packages/server/src/models/activity-source-decision.test.ts`
- Modify: `packages/server/src/models/activity.test.ts`

- [x] Write tests proving multi-source activities produce `{ sourceCount, primarySourceLabel, explanation }`.
- [x] Write tests proving zero/one source links produce `null`.
- [x] Write `toDetail()` assertions including `sourceDecision`.
- [x] Run `rtk pnpm vitest run packages/server/src/models/activity-source-decision.test.ts packages/server/src/models/activity.test.ts`.
- [x] Confirm failures are for the missing model/field, not fixture mistakes.

### Task 2: Implement Server Domain Model

**Files:**
- Create: `packages/server/src/models/activity-source-decision.ts`
- Modify: `packages/server/src/models/activity.ts`

- [x] Implement `ActivitySourceDecision.fromSources(...)` (or equivalent) that returns `null` unless there are at least two source links.
- [x] Primary label comes from the matching source link when present, otherwise from provider lookup / `providerSourceLabel`.
- [x] Explanation states that source priority selected the primary record and that missing details may come from other matched sources. Keep jargon out of the user-facing string.
- [x] Attach `sourceDecision` on `Activity.toDetail()`.
- [x] Re-run the Task 1 commands and confirm they pass.

### Task 3: Add Failing Web And Mobile Parity Tests

**Files:**
- Create: `packages/web/src/components/ActivitySourceDecisionCard.test.tsx`
- Modify: `packages/web/src/pages/ActivityDetailPage.test.tsx`
- Modify: `packages/mobile/app/activity/[id].test.tsx`

- [x] Assert the card shows heading “How sources were combined”, source count, primary label, and explanation.
- [x] Assert activity detail hides the card when `sourceDecision` is `null`.
- [x] Mirror the multi-source show / single-source hide assertions on mobile.
- [x] Run `rtk pnpm vitest run packages/web/src/components/ActivitySourceDecisionCard.test.tsx packages/web/src/pages/ActivityDetailPage.test.tsx`.
- [x] Run `rtk pnpm test:mobile -- app/activity/[id].test.tsx`.
- [x] Confirm failures are for missing UI, not mock shape errors.

### Task 4: Implement Web And Mobile Cards

**Files:**
- Create: `packages/web/src/components/ActivitySourceDecisionCard.tsx`
- Create: `packages/web/src/components/ActivitySourceDecisionCard.stories.tsx`
- Modify: `packages/web/src/pages/ActivityDetailPage.tsx` (+ stories as needed)
- Create: `packages/mobile/app/activity/ActivitySourceDecisionCard.tsx`
- Create: `packages/mobile/app/activity/ActivitySourceDecisionCard.stories.tsx`
- Modify: `packages/mobile/app/activity/[id].tsx`
- Modify: `packages/mobile/app/activity/styles.ts` as needed

- [x] Clients only render server-provided fields; do not recompute priority or explanation text.
- [x] Place the card near existing source attribution / absence banners on both platforms.
- [x] Re-run Task 3 tests and confirm they pass.

### Task 5: Final Verification

- [x] Run `rtk pnpm lint`.
- [x] Run `rtk pnpm tsc --noEmit`, `rtk pnpm --dir packages/server tsc --noEmit`, `rtk pnpm --dir packages/web tsc --noEmit`.
- [x] Run the focused unit/mobile tests above (or `rtk pnpm test` / `rtk pnpm test:mobile` for broader coverage).
- [x] Mark the completed roadmap checkbox for this outcome when Product Strategy content is present.
- [x] Commit, push, open PR against `main`, and monitor CI/review comments.
