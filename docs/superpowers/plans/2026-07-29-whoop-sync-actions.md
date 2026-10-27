# WHOOP Sync Actions TDD Plan

**Goal:** Replace overlapping WHOOP cloud sync actions with one explicit date range and one Sync action on web and iOS.

**Behavior:** Connected WHOOP cloud detail screens default to the last seven calendar days through today, allow the start and end dates to be changed, reject inverted ranges, and submit the selected range through the existing `sinceDate`/`untilDate` sync contract.

**Scope:** Update WHOOP cloud provider detail only. Preserve other providers' current controls, Apple Health's device-local range contract, WHOOP Bluetooth push-only behavior, and the separately presented destructive data-deletion control.

**Docs:** [Issue #2181](https://github.com/Asherlc/dofek/issues/2181), [React controlled inputs](https://react.dev/reference/react-dom/components/input#controlling-an-input-with-a-state-variable), and [React Native community date/time picker](https://github.com/react-native-datetimepicker/datetimepicker).

---

## Current Evidence

- `packages/web/src/pages/ProviderDetailPage.tsx` renders four overlapping sync paths for WHOOP: a seven-day shortcut, full history, a days-back input, and an exact date range.
- `packages/mobile/app/providers/provider-detail-actions-card.tsx` renders both Sync and Full sync for WHOOP.
- The server already validates and accepts paired `sinceDate` and `untilDate` values in `packages/server/src/routers/sync.ts`.

## Test Strategy

- Web unit: verify WHOOP renders one Sync action with From/To controls, submits the selected exact range, and rejects an inverted range.
- Mobile unit: verify WHOOP renders accessible From/To date controls plus one Sync action, submits the selected exact range, and reports an inverted range without starting a sync.
- UI parity: preserve non-WHOOP controls and verify the WHOOP cloud behavior on both clients.

## File Structure

- Modify: `packages/web/src/pages/ProviderDetailPage.tsx` and its colocated test.
- Modify: `packages/mobile/app/providers/use-provider-detail-actions.ts` for exact-range sync state and submission.
- Modify: `packages/mobile/app/providers/provider-detail-actions-card.tsx` for the WHOOP range controls.
- Modify: `packages/mobile/app/providers/[id].tsx` and its colocated test to connect the WHOOP range state.
- Create: `packages/mobile/app/providers/provider-detail-actions-card.stories.tsx` for default, syncing, error, and WHOOP range variants.

## Tasks

### Task 1: Add Failing Tests

- [ ] Add web WHOOP layout, payload, and inverted-range tests.
- [ ] Add mobile WHOOP layout, payload, and inverted-range tests.
- [ ] Run `rtk pnpm test -- --run packages/web/src/pages/ProviderDetailPage.test.tsx packages/mobile/app/providers/[id].test.tsx`.
- [ ] Confirm failures identify the overlapping actions and missing exact-range mobile behavior.

### Task 2: Implement the Minimum Fix

- [ ] Render the existing web exact-date controls as WHOOP's sole routine sync control.
- [ ] Add mobile WHOOP start/end date controls using the existing date-time picker dependency.
- [ ] Submit paired `sinceDate` and `untilDate` values from both clients.
- [ ] Preserve the existing non-WHOOP and destructive-data controls.
- [ ] Run `rtk pnpm test -- --run packages/web/src/pages/ProviderDetailPage.test.tsx packages/mobile/app/providers/[id].test.tsx`.

### Task 3: Final Verification

- [ ] Add Storybook coverage for the modified mobile action card.
- [ ] Run `rtk pnpm lint`.
- [ ] Run `rtk pnpm tsc --noEmit`, `rtk pnpm --dir packages/server tsc --noEmit`, and `rtk pnpm --dir packages/web tsc --noEmit`.
- [ ] Run `rtk pnpm test`.
- [ ] Commit, push, open a linked PR with `Fixes #2181`, monitor CI and reviews, and merge after all required checks pass.
