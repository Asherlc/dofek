# Health Report Share Link Expiry TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation. If executing this plan task-by-task, also use superpowers:executing-plans or superpowers:subagent-driven-development as appropriate. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make web and mobile health-report share links expire by default (7 days), with an explicit 7/30/90-day choice that reaches `healthReport.generate`.

**Behavior:** Sharing a weekly or monthly report defaults to a 7-day link. The user can choose 7, 30, or 90 days before creating the link. The chosen duration is sent as `expiresInDays`. Success copy (web) and the native share payload (mobile) communicate the server-returned `expiresAt`.

**Scope:**
- Included: `HealthReportShareButton` on web and mobile, colocated tests, Storybook stories, focused sharing docs.
- Non-goals: domain selection, revoke UI, annual/narrative reports, analytics/dbt changes, weekly/monthly report repository changes (avoid overlap with PR #2038).

**Docs:**
- `docs/health-report-sharing.md`
- Server contract: `packages/server/src/routers/health-report.ts` (`expiresInDays` 1–90, nullable)

---

## Current Evidence

- Server already accepts `expiresInDays` and stores `expiresAt` (`packages/server/src/routers/health-report.ts`, repository `generate`).
- Web and mobile share buttons mutate with the report input only — they omit `expiresInDays`, so Zod defaults to `null` (permanent links).
- Shared Reports on web already displays `expiresAt` when present; mobile cannot manage existing links (out of scope).

## Test Strategy

- Unit: web and mobile share-button component tests assert default duration, selectable durations, mutate payload, and expiry messaging.
- Integration: none required — server expiry path is already covered.
- UI/mobile/web parity: identical default (7) and option set (7/30/90); both communicate server `expiresAt`.

## File Structure

- Create: `docs/superpowers/plans/2026-07-26-health-report-share-expiry.md` — this plan
- Create: `docs/health-report-sharing.md` — product/ops notes for share-link expiry
- Modify: `packages/web/src/components/HealthReportShareButton.{tsx,test.tsx,stories.tsx}`
- Modify: `packages/mobile/components/HealthReportShareButton.{tsx,test.tsx,stories.tsx}`

## Tasks

### Task 1: Add Failing Web Tests

**Files:**
- Modify: `packages/web/src/components/HealthReportShareButton.test.tsx`

- [x] Extend the tRPC mock so `onSuccess` receives `expiresAt`.
- [x] Assert Share defaults to `expiresInDays: 7` and success text mentions the formatted expiry.
- [x] Assert choosing 30 or 90 days sends that value in `mutate`.
- [x] Run `rtk pnpm vitest run packages/web/src/components/HealthReportShareButton.test.tsx --project unit`.
- [x] Confirm the tests fail for the expected reason (missing expiry controls / payload).

### Task 2: Implement Web Share Expiry

**Files:**
- Modify: `packages/web/src/components/HealthReportShareButton.tsx`
- Modify: `packages/web/src/components/HealthReportShareButton.stories.tsx`

- [x] Add 7/30/90 day controls defaulting to 7; merge `expiresInDays` into `mutate`.
- [x] On success, show link-copied status that includes `formatDateMedium(report.expiresAt)`.
- [x] Update Storybook mock `expiresAt` and keep Default/Disabled stories.
- [x] Run the web test command above and confirm it passes.

### Task 3: Add Failing Mobile Tests

**Files:**
- Modify: `packages/mobile/components/HealthReportShareButton.test.tsx`

- [x] Extend the mock with `expiresAt`.
- [x] Assert default `expiresInDays: 7` and Share payload includes expiry text.
- [x] Assert choosing 30 or 90 days updates the mutate payload.
- [x] Run `rtk pnpm vitest run packages/mobile/components/HealthReportShareButton.test.tsx --project mobile`.
- [x] Confirm the tests fail for the expected reason.

### Task 4: Implement Mobile Share Expiry

**Files:**
- Modify: `packages/mobile/components/HealthReportShareButton.tsx`
- Modify: `packages/mobile/components/HealthReportShareButton.stories.tsx`

- [x] Mirror web: 7/30/90 controls, default 7, pass `expiresInDays`.
- [x] Include server-returned expiry in the native `Share.share` message.
- [x] Update Storybook mock `expiresAt`.
- [x] Run the mobile test command above and confirm it passes.

### Task 5: Docs and Final Verification

**Files:**
- Create: `docs/health-report-sharing.md`

- [x] Document default 7-day expiry, selectable durations, and that permanent links require omitting/null `expiresInDays` on the API only (clients always send a duration).
- [x] Run `rtk pnpm lint`, web/mobile/root typechecks, and the focused share-button tests.
- [x] Commit, push, open PR against `main`, monitor CI and review feedback.
