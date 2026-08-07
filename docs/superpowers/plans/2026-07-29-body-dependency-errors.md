# Body Dependency Errors TDD Plan

> **For agentic workers:** Use the repository's `write-tests` workflow before implementation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace repeated body-data error boxes with one actionable page notice while keeping every independent query identity and usable cached or sibling data honest.

**Behavior:** Web shows one assertive summary with one labeled entry per failed query identity, compact non-assertive placeholders where cold failures leave a section unavailable, and all healthy or cached sections. Mobile shows the composite recovery/body query error once with retry, preserves processing status and cached data, and does not render false metric placeholders when no response exists.

**Scope:** Web Body overview and the equivalent mobile Recovery/body surface, their focused tests, and paired error stories. No server contract change, retry policy change, global error framework, message-text deduplication, or changes to #2085's Cycling/Strain surfaces.

**Docs:** [`packages/web/README.md`](../../../packages/web/README.md), [`packages/mobile/README.md`](../../../packages/mobile/README.md), and issue [#2142](https://github.com/Asherlc/dofek/issues/2142).

---

## Current Evidence

- `packages/web/src/pages/BodyPage.tsx` calls six independent query identities. A cold `bodyAnalytics.weightOverview` failure is rendered four times and also suppresses healthy resting-heart-rate status from `dailyMetrics.trends`.
- Cold failures in HRV, stress, SpO2/temperature, and insights reserve 120–250 pixel generic error regions.
- Cached web data is already retained during background errors and must remain visible.
- `packages/mobile/app/(tabs)/recovery.tsx` uses one composite `mobileDashboard.recovery` dependency. A cold failure currently renders no server error and falls through to metric cards containing placeholder values.
- Processing status is a separate mobile dependency and must remain independently visible.

## Test Strategy

- Unit/web page: reproduce repeated weight failures; assert one page alert and one labeled dependency entry per query identity; assert equal messages from different identities remain separate labeled entries; assert compact local states are non-assertive; assert a healthy health-status sibling remains visible; assert cached content survives a background failure; assert retry refetches only failed identities.
- Unit/mobile screen: assert a cold composite failure renders the exact server error once with retry and no false metric cards; assert processing status remains; assert cached content remains visible during a background failure.
- Stories: add a web Body unavailable-dependencies scenario and a mobile Recovery unavailable-data scenario.
- Integration: none; this is client query-state composition with mocked tRPC boundaries.

## File Structure

- Modify: `packages/web/src/pages/BodyPage.test.tsx` — web failure grouping, independence, cache, and retry regressions.
- Modify: `packages/web/src/pages/BodyPage.tsx` — page summary and compact localized states.
- Create: `packages/web/src/pages/BodyPage.stories.tsx` — reviewable multi-dependency failure scenario.
- Modify: `packages/mobile/app/(tabs)/recovery.test.tsx` — composite failure and cache regressions.
- Modify: `packages/mobile/app/(tabs)/recovery.tsx` — one actionable composite error state.
- Modify: `packages/mobile/app/(tabs)/recovery.stories.tsx` — reviewable composite failure scenario.

## Tasks

### Task 1: Add Failing Web Tests

- [ ] Extend the Body page query fixtures so each query identity can fail independently.
- [ ] Assert one page alert contains labeled exact errors without deduplicating identities by message.
- [ ] Assert `weightOverview` is represented once, compact local states are not alerts, and healthy trend status remains visible.
- [ ] Assert retries target failed identities and cached data remains visible.
- [ ] Run `rtk pnpm exec vitest --project unit --run packages/web/src/pages/BodyPage.test.tsx`.
- [ ] Confirm failures identify the current repeated/missing-state behavior.

### Task 2: Implement the Minimal Web Fix

- [ ] Build a labeled failure list directly from the six existing query identities.
- [ ] Render one retryable page notice, one compact local placeholder per unavailable group, and healthy/cached siblings.
- [ ] Do not deduplicate distinct query identities by error message.
- [ ] Run the focused web test and confirm it passes.

### Task 3: Add Failing Mobile Tests

- [ ] Model `mobileDashboard.recovery` error/refetch state in the existing screen test.
- [ ] Assert the exact server error appears once, retry is actionable, processing status remains, and false metric placeholders are absent.
- [ ] Assert cached recovery/body content remains visible during a background failure.
- [ ] Run `rtk pnpm exec vitest --project mobile --run 'packages/mobile/app/(tabs)/recovery.test.tsx'`.
- [ ] Confirm failures identify the current silent cold-error behavior.

### Task 4: Implement the Minimal Mobile Fix

- [ ] Render one retryable composite dependency notice for cold and background errors.
- [ ] Render the composite screen body only when response data exists; retain cached response data on background failures.
- [ ] Keep processing status and range controls independent.
- [ ] Run the focused mobile test and confirm it passes.

### Task 5: Add Paired Stories and Final Verification

- [ ] Add review-scenario error stories for web Body and mobile Recovery.
- [ ] Run focused web/mobile tests, changed tests, relevant typechecks, lint, and both Storybook builds.
- [ ] Run `rtk git diff --check`.
- [ ] Commit, push, open a PR containing `Fixes #2142`, link it from the issue, and monitor required checks and reviews through merge.
