# Apple Health Subsource Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show Apple Health upstream app names like `Strong (via Apple Health)` on activity detail pages and document where that subsource comes from.

**Architecture:** Extend the server `ActivityDetail` shape with a nullable `subsource` field derived from `fitness.v_activity.raw->>'sourceName'`, then format the detail-page header label in web and mobile from that server-provided value. Keep the change narrow: no schema changes, no client-side JSON parsing, and no behavior changes for non-Apple Health activities.

**Tech Stack:** TypeScript, Vitest, tRPC, React, React Native, Drizzle SQL, Markdown docs

---

### Task 1: Add server-side subsource field

**Files:**
- Modify: `packages/server/src/repositories/activity-repository.ts`
- Modify: `packages/server/src/models/activity.ts`
- Test: `packages/server/src/repositories/activity-repository.test.ts`
- Test: `packages/server/src/models/activity.test.ts`
- Test: `packages/server/src/routers/activity.test.ts`

- [ ] **Step 1: Write the failing tests**
- [ ] **Step 2: Run the server tests to verify they fail for missing `subsource`**
- [ ] **Step 3: Select `a.raw->>'sourceName'` in the repository and expose `subsource` through `ActivityDetail`**
- [ ] **Step 4: Run the server tests to verify they pass**

### Task 2: Render `Strong (via Apple Health)` on detail pages

**Files:**
- Modify: `packages/web/src/pages/ActivityDetailPage.tsx`
- Modify: `packages/web/src/pages/ActivityDetailPage.test.tsx`
- Modify: `packages/mobile/app/activity/[id].tsx`
- Modify: `packages/mobile/app/activity/[id].test.tsx`

- [ ] **Step 1: Write failing web and mobile detail-page tests for Apple Health subsources**
- [ ] **Step 2: Run those tests to verify they fail**
- [ ] **Step 3: Add a small header-label formatter that prefers `subsource (via Apple Health)` for Apple Health only**
- [ ] **Step 4: Run the web and mobile tests to verify they pass**

### Task 3: Document the Apple Health nuance

**Files:**
- Modify: `docs/apple-health.md`

- [ ] **Step 1: Add a short note that some Apple Health workouts preserve upstream app names in `raw.sourceName`, and that this does not include per-exercise Strong data**
- [ ] **Step 2: Run a quick doc sanity check in the diff**

### Task 4: Verify the whole change set

**Files:**
- Modify: `docs/apple-health.md`
- Modify: `packages/server/src/repositories/activity-repository.ts`
- Modify: `packages/server/src/repositories/activity-repository.test.ts`
- Modify: `packages/server/src/models/activity.ts`
- Modify: `packages/server/src/models/activity.test.ts`
- Modify: `packages/server/src/routers/activity.test.ts`
- Modify: `packages/web/src/pages/ActivityDetailPage.tsx`
- Modify: `packages/web/src/pages/ActivityDetailPage.test.tsx`
- Modify: `packages/mobile/app/activity/[id].tsx`
- Modify: `packages/mobile/app/activity/[id].test.tsx`

- [ ] **Step 1: Run the focused Vitest commands for server, web, and mobile**
- [ ] **Step 2: Review the final diff for scope and wording**
