# Sync Action Hierarchy TDD Plan

**Goal:** Make routine recent sync the clear primary action while protecting
full-history sync with an accurate explanation, confirmation, and end-to-end
single-flight behavior on web and mobile.

**Behavior:** People can start a recent seven-day sync directly, understand that
full history requests all history each provider makes available, cancel the
full-history confirmation first, and follow provider progress or exact errors
without accidentally starting duplicate work.

**Scope:** Cover the bulk sync actions on the web and mobile provider screens,
shared action semantics and copy, and lifecycle-scoped deduplication for an
initial full-history provider job. Preserve individual-provider actions,
provider-specific sync implementations, checkpoint request identities, and
existing reconciliation behavior.

**Docs:** [Issue #2178](https://github.com/Asherlc/dofek/issues/2178),
[BullMQ simple-mode deduplication](https://docs.bullmq.io/guide/jobs/deduplication),
[provider metadata package](../../../packages/providers-meta/README.md),
[web package](../../../packages/web/README.md),
[mobile package](../../../packages/mobile/README.md).

---

## Current Evidence

- Web renders `Sync All` and `Full Sync All` with equal visual weight and only
  disables them while the trigger mutation is pending, so they become
  actionable again while returned jobs are still being polled.
- Mobile renders the same two actions side by side and disables them through
  local job polling, but a bulk trigger failure is captured without displaying
  its exact message.
- `sinceDays: 7` becomes a bounded recent calendar window. Omitting the range
  creates an epoch-to-now full window for every connected, configured,
  sync-capable provider.
- Provider activity writes update matching records. A completed authoritative
  activity-list fetch reconciles its exact window, which may hide an activity
  removed upstream; it does not erase or rebuild unrelated Dofek data.
- Existing request-query job IDs deduplicate identical pending requests, but an
  initial full sync has moving end/cursor values and can therefore receive a
  different request key on rapid repeat submission.
- BullMQ simple-mode deduplication retains a deduplication identifier only while
  its job is incomplete and releases it on completion or failure. This matches
  the required initial-operation lifecycle without persistent custom state.

## Test Strategy

- Unit: prove shared recent/full semantics and accessible copy; prove only
  user-triggered initial full jobs receive a lifecycle deduplication key while
  checkpoint continuations retain distinct request identities.
- Integration: exercise BullMQ against Redis to prove pending initial full jobs
  coalesce and completion/failure releases the lifecycle key for a later
  legitimate full sync.
- Web: prove recent-primary hierarchy, full-history explanation, cancel-first
  initial focus, Escape cancellation, whole-job disabled/progress state, exact
  trigger errors, and accessible action names.
- Mobile: prove the equivalent hierarchy and copy, cancel-first presentation,
  Android/iOS modal close handling, whole-job disabled/progress state, exact
  trigger errors, and accessible action names.
- Stories/runtime: add default, confirmation, syncing, and error stories for
  both focused controls; build both Storybooks and inspect responsive web and
  mobile rendering.

## File Structure

- Create: `packages/providers-meta/src/sync-actions.ts` and its colocated unit
  test for the canonical action contract.
- Modify: `packages/providers-meta/package.json` to export the isolated
  `sync-actions` entry point.
- Modify: `src/jobs/sync-request-job.ts` and its colocated test for initial
  full-operation BullMQ deduplication.
- Create: `src/jobs/sync-request-job.integration.test.ts` for real Redis
  lifecycle behavior.
- Create: `packages/web/src/components/SyncAllControls.tsx`, test, and stories.
- Modify: `packages/web/src/components/DataSourcesPanel.tsx` and its test/story
  integration.
- Create: `packages/mobile/app/providers/sync-all-controls.tsx`, test, and
  stories.
- Modify: `packages/mobile/app/providers/index.tsx`, styles, and screen tests.

## Tasks

### Task 1: Add Shared Contract and Queue Tests

**Files:**

- Create: `packages/providers-meta/src/sync-actions.test.ts`
- Modify: `src/jobs/sync-request-job.test.ts`
- Create: `src/jobs/sync-request-job.integration.test.ts`

- [ ] Write failing tests for the seven-day routine contract and layman-readable
  full-history range, request-cost, update/reconciliation, and non-erasure copy.
- [ ] Write failing tests that pending initial full jobs carry the same
  lifecycle deduplication ID per provider/user, ordinary recent jobs retain
  request-level deduplication, and checkpoint continuations do not reuse the
  initial full-operation ID.
- [ ] Run `rtk pnpm vitest run packages/providers-meta/src/sync-actions.test.ts src/jobs/sync-request-job.test.ts`.
- [ ] Confirm failures identify only the missing shared contract and
  deduplication behavior.

### Task 2: Implement Shared Contract and Queue Guard

**Files:**

- Create: `packages/providers-meta/src/sync-actions.ts`
- Modify: `packages/providers-meta/package.json`
- Modify: `src/jobs/sync-request-job.ts`

- [ ] Add the smallest typed shared action contract used by both platforms.
- [ ] Add BullMQ simple-mode deduplication only to initial full-history jobs,
  keyed by provider and user.
- [ ] Leave checkpoint continuations on their existing request-query IDs.
- [ ] Re-run the focused tests and confirm they pass.
- [ ] Run the Redis-backed integration test through the repository integration
  harness and confirm pending jobs coalesce while completion and failure each
  release the key.

### Task 3: Add Failing Web Interaction Tests

**Files:**

- Create: `packages/web/src/components/SyncAllControls.test.tsx`
- Modify: `packages/web/src/components/DataSourcesPanel.test.tsx`

- [ ] Assert one primary recent action and one lower-emphasis full-history
  action with explicit accessible names.
- [ ] Assert full-history explanation and confirmation are required.
- [ ] Assert Cancel is first and initially focused, Escape closes the dialog,
  and focus returns to the full-history trigger.
- [ ] Assert mutation and active/polled job states disable both actions and
  expose progress guidance.
- [ ] Assert the exact bulk trigger `error.message` is visible.
- [ ] Run the focused web tests and confirm expected failures.

### Task 4: Implement Web Hierarchy and Stories

**Files:**

- Create: `packages/web/src/components/SyncAllControls.tsx`
- Create: `packages/web/src/components/SyncAllControls.stories.tsx`
- Modify: `packages/web/src/components/DataSourcesPanel.tsx`
- Modify: `packages/web/src/components/DataSourcesPanel.stories.tsx`

- [ ] Implement the focused controls with the existing modal primitive.
- [ ] Keep controls disabled from trigger start through active job completion.
- [ ] Preserve provider-card progress while adding group progress/error
  visibility.
- [ ] Add default, confirmation, syncing, and error stories.
- [ ] Re-run focused web tests until green.

### Task 5: Add Failing Mobile Interaction Tests

**Files:**

- Create: `packages/mobile/app/providers/sync-all-controls.test.tsx`
- Modify: `packages/mobile/app/providers/index.test.tsx`

- [ ] Assert parity with the web hierarchy, descriptions, and accessible names.
- [ ] Assert Cancel is first and modal request-close/back cancels without
  starting work.
- [ ] Assert mutation and active/polled job states disable both actions and
  expose progress guidance.
- [ ] Assert the exact bulk trigger `error.message` is visible.
- [ ] Run the focused mobile tests and confirm expected failures.

### Task 6: Implement Mobile Hierarchy and Stories

**Files:**

- Create: `packages/mobile/app/providers/sync-all-controls.tsx`
- Create: `packages/mobile/app/providers/sync-all-controls.stories.tsx`
- Modify: `packages/mobile/app/providers/index.tsx`
- Modify: `packages/mobile/app/providers/styles.ts`
- Modify: `packages/mobile/app/providers/index.stories.tsx`

- [ ] Implement the focused controls with the React Native modal primitive.
- [ ] Keep controls disabled from trigger start through active job completion.
- [ ] Preserve provider-card progress while adding group progress/error
  visibility.
- [ ] Add default, confirmation, syncing, and error stories.
- [ ] Re-run focused mobile tests until green.

### Task 7: Final Verification

- [ ] Run focused shared, queue, web, and mobile tests.
- [ ] Run `rtk pnpm lint`.
- [ ] Run `rtk pnpm tsc --noEmit`.
- [ ] Run package-scoped web and mobile typechecks.
- [ ] Run `rtk pnpm storybook:web:build`.
- [ ] Run `rtk pnpm storybook:mobile:build`.
- [ ] Inspect responsive web and mobile stories for focus, hierarchy,
  wrapping, progress, and error presentation.
- [ ] Push the branch, open a PR with `Fixes #2178`, monitor all required checks
  and review threads, address actionable feedback, and merge.
