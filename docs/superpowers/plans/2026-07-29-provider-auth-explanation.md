# Provider Authorization Explanation TDD Plan

> **For agentic workers:** Implement the tasks in test-first order. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace raw provider sync-history authorization failures with an
actionable user explanation while preserving the underlying evidence in
diagnostics.

**Behavior:** Web and mobile provider details lead authorization failures with
“Authorization expired” and tell the user which provider to reconnect and which
data will resume. Raw data type, status, authentication reason, error text, and
log ID remain available through a closed Diagnostics disclosure.

**Scope:** Reuse the existing `providerDetail.logs` response without changing
the API or schema. Add one shared presentation model plus native web and mobile
renderers, tests, and Storybook stories. Do not change authentication,
reconnection, or sync behavior.

**Docs:** [Issue #2182](https://github.com/Asherlc/dofek/issues/2182),
[shared provider metadata](../../../packages/providers-meta/README.md),
[web application](../../../packages/web/README.md), and
[mobile application](../../../packages/mobile/README.md).

---

## Current Evidence

- `packages/web/src/pages/provider-detail-data.tsx` renders the raw
  `dataType`, `authFailureReason`, and sync-log `id` directly in the visible
  history table.
- `packages/mobile/app/providers/[id].tsx` renders the raw `dataType` and error
  text without an authorization-specific explanation.
- `providerDetail.logs` already returns the structured authentication reason,
  data type, sanitized error text, and log ID needed for both presentation and
  diagnostics.

## Test Strategy

- Shared unit tests: verify expired, failed-authorization, ordinary error, and
  successful-sync presentation from structured log fields.
- Web component tests: verify actionable authorization text leads and raw
  fields remain hidden until the native Diagnostics disclosure opens.
- Mobile component tests: verify the same content and explicit disclosure
  interaction.
- Screen integration tests: verify each provider-detail history renders the
  shared entry component with the provider name.
- Storybook: build paired authorization-expired stories for visual review.

## File Structure

- Create: `packages/providers-meta/src/sync-log-presentation.ts` and colocated
  test - shared user-facing sync-log interpretation.
- Modify: `packages/providers-meta/package.json` - expose the shared model.
- Create: paired `ProviderSyncHistoryEntry` components, tests, and stories in
  `packages/web/src/components/` and `packages/mobile/components/`.
- Modify: web and mobile provider-detail history renderers and their existing
  screen tests.

## Tasks

### Task 1: Add Failing Shared Presentation Tests

- [x] Add cases for expired authorization, failed authorization, a non-auth
  sync error, and success.
- [x] Run
  `rtk pnpm exec vitest run --project unit packages/providers-meta/src/sync-log-presentation.test.ts`.
- [x] Confirm failure is caused by the absent presentation model.

### Task 2: Implement the Shared Presentation Model

- [x] Implement the minimum structured mapping and export it from
  `@dofek/providers`.
- [x] Re-run the focused shared test and confirm it passes.

### Task 3: Add Failing Paired UI Tests

- [x] Add web and mobile component tests for the leading explanation and closed
  diagnostics.
- [x] Add one integration assertion to each existing provider-detail screen
  test.
- [x] Run the focused web and mobile test files.
- [x] Confirm failure is caused by the absent components and wiring.

### Task 4: Implement Paired UI and Stories

- [x] Render the shared presentation in both sync histories.
- [x] Keep raw identifiers and error detail behind Diagnostics.
- [x] Add paired Storybook stories for an expired Strength authorization.
- [x] Re-run focused tests and both Storybook builds.

### Task 5: Final Verification

- [ ] Run `rtk pnpm lint`.
- [x] Run `rtk pnpm tsc --noEmit`.
- [x] Run `rtk pnpm --dir packages/server tsc --noEmit`.
- [x] Run `rtk pnpm --dir packages/web tsc --noEmit`.
- [x] Run `rtk pnpm test`.
- [x] Run `rtk pnpm storybook:web:build`.
- [x] Run `rtk pnpm storybook:mobile:build`.
- [ ] Commit, push, open a PR with `Fixes #2182`, and monitor it through merge.
