# Activity Training Stress Unavailable State TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven development before implementation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ambiguous dash on compact activity cards with a server-authored Training Stress Score unavailable state that names the missing prerequisite.

**Behavior:** The activity calendar API returns a discriminated stat: an available score has a formatted value, while an unavailable score has an actionable server-authored reason. Web and iOS render the same status, label, value, and reason without deriving metric availability.

**Scope:** Update the existing calendar repository and API contract, compact activity-card rendering on web and iOS, tests, Storybook states, and server contract documentation. Keep the nullable numeric `tss` field for existing consumers and do not change score formulas or activity-detail behavior.

**Docs:** [Issue #2121](https://github.com/Asherlc/dofek/issues/2121)

---

## Current Evidence

- `formatActivityStats()` always returns `{ label: "Training Stress Score", value: "—" }` when `computeActivityTss()` returns `null`.
- Web `ActivityCardContent` and mobile `ActivityMetricStrip` render the returned `stats` array directly, producing the audited broken-looking compact-card state.
- The server already has every input needed to identify whether duration, power/functional threshold power, or heart-rate/maximum-heart-rate data prevents calculation.

## Test Strategy

- Unit: repository tests cover available scores and each unavailable prerequisite reason, including invalid duration and invalid heart-rate baselines.
- API boundary: router tests accept both discriminated variants and reject malformed metric payloads through Zod.
- UI/mobile/web parity: web and mobile tests verify server-provided unavailable text, suppress the dash, and expose the reason to accessibility queries.
- Storybook: web and mobile stories include an unavailable activity state.

## File Structure

- Modify: `packages/server/src/repositories/activities-calendar-repository.test.ts` - define the expected server availability contract and reasons.
- Modify: `packages/server/src/repositories/activities-calendar-repository.ts` - compute the discriminated result and format server-authored prerequisite reasons.
- Modify: `packages/server/src/routers/calendar.test.ts` - verify API-boundary normalization and rejection.
- Modify: `packages/server/src/routers/calendar.ts` - validate the discriminated stat contract.
- Modify: `packages/server/README.md` - document the calendar activity-stat contract.
- Modify: `packages/web/src/components/ActivityCardContent.test.tsx` - cover available and unavailable compact-card rendering.
- Modify: `packages/web/src/components/ActivityCardContent.tsx` - render the returned metric variant.
- Modify: `packages/web/src/components/ActivityCardContent.stories.tsx` - show the unavailable state.
- Add: `packages/mobile/components/ActivityMetricStrip.test.tsx` - cover iOS parity and unavailable reason rendering.
- Add: `packages/mobile/components/ActivityMetricStrip.tsx` - render the returned metric variant.
- Modify: `packages/mobile/app/(tabs)/activities.tsx` - compose the focused metric-strip component.
- Modify: `packages/mobile/app/(tabs)/activities.stories.tsx` - show the unavailable state.

## Tasks

### Task 1: Add Failing Server Contract Tests

**Files:**
- Modify: `packages/server/src/repositories/activities-calendar-repository.test.ts`
- Modify: `packages/server/src/routers/calendar.test.ts`

- [ ] Write failing tests for available and unavailable discriminated stats.
- [ ] Cover missing/invalid duration, power, functional threshold power, average heart rate, and maximum heart rate inputs.
- [ ] Run `rtk pnpm test -- --run packages/server/src/repositories/activities-calendar-repository.test.ts packages/server/src/routers/calendar.test.ts`.
- [ ] Confirm the tests fail because the current contract still emits an em dash.

### Task 2: Add Failing Web and Mobile Parity Tests

**Files:**
- Modify: `packages/web/src/components/ActivityCardContent.test.tsx`
- Add: `packages/mobile/components/ActivityMetricStrip.test.tsx`

- [ ] Write failing tests that require the server-authored unavailable label and reason.
- [ ] Assert the compact cards no longer render the ambiguous em dash for unavailable training stress.
- [ ] Run `rtk pnpm test -- --run packages/web/src/components/ActivityCardContent.test.tsx packages/mobile/components/ActivityMetricStrip.test.tsx`.
- [ ] Confirm the tests fail against the old string-pair contract.

### Task 3: Implement the Minimal Server Contract

**Files:**
- Modify: `packages/server/src/repositories/activities-calendar-repository.ts`
- Modify: `packages/server/src/routers/calendar.ts`

- [ ] Return a discriminated calculation result and exact missing-prerequisite reason.
- [ ] Keep score calculation formulas unchanged.
- [ ] Validate both stat variants with Zod at the API boundary.
- [ ] Run `rtk pnpm test -- --run packages/server/src/repositories/activities-calendar-repository.test.ts packages/server/src/routers/calendar.test.ts`.
- [ ] Confirm the server tests pass.

### Task 4: Render the Contract on Both Clients

**Files:**
- Modify: `packages/web/src/components/ActivityCardContent.tsx`
- Modify: `packages/web/src/components/ActivityCardContent.stories.tsx`
- Add: `packages/mobile/components/ActivityMetricStrip.tsx`
- Modify: `packages/mobile/app/(tabs)/activities.tsx`
- Modify: `packages/mobile/app/(tabs)/activities.stories.tsx`

- [ ] Render available values and unavailable server-authored reasons without client-side metric inference.
- [ ] Preserve map-card distance/elevation behavior.
- [ ] Add unavailable Storybook states on both platforms.
- [ ] Run `rtk pnpm test -- --run packages/web/src/components/ActivityCardContent.test.tsx packages/mobile/components/ActivityMetricStrip.test.tsx`.
- [ ] Confirm the parity tests pass.

### Task 5: Document and Verify

**Files:**
- Modify: `packages/server/README.md`

- [ ] Document the server-owned activity-stat availability contract.
- [ ] Run `rtk pnpm lint`.
- [ ] Run `rtk pnpm tsc --noEmit`.
- [ ] Run `rtk pnpm --dir packages/server tsc --noEmit`.
- [ ] Run `rtk pnpm --dir packages/web tsc --noEmit`.
- [ ] Run `rtk pnpm test`.
- [ ] Build web and mobile Storybook catalogs.
- [ ] Commit, push, open a PR with `Fixes #2121`, audit feedback, monitor CI, and merge after every required check passes.
