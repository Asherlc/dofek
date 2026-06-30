# Technical Debt Cleanup Implementation Plan
**Goal:** Remove stale exports and split oversized files without changing product behavior.
**Architecture:** Treat this as behavior-preserving cleanup. Start with static tooling regressions, then split one oversized module at a time while running the focused tests after every move.
**Tech Stack:** TypeScript, Knip, Vitest, Storybook, Drizzle schema modules, React, React Native/Expo.
## File Structure
- Modify root package exports and `knip.json`: remove stale package export/config drift.
- Split `src/db/schema.ts` into focused schema modules, then update callers to import concrete modules directly without keeping a re-export shim.
- Split `packages/mobile/app/settings.tsx` into focused Settings components.
- Split `packages/web/src/pages/ProviderDetailPage.tsx` into provider detail components.
- Add or update Storybook stories for every touched component under `packages/web/src/components/` and `packages/mobile/components/`.
### Task 1: Root Exports And Knip Drift
**Files:**
- Modify: `package.json`
- Modify: `knip.json`
- Test: Knip command output
- [ ] **Step 1 (RED): Capture the failing static check**
```bash
pnpm knip
```
Expected: FAIL with the current stale exports or Knip configuration drift called out in the output.
- [ ] **Step 2 (GREEN): Remove only stale export/config entries**
Edit `package.json` exports and `knip.json` so Knip no longer reports unused exported entrypoints or invalid config. Do not remove source files in this task unless Knip proves the file is unreachable and no package imports it.
- [ ] **Step 3 (GREEN): Verify Knip**
```bash
pnpm knip
```
- [ ] **Step 4 (REFACTOR): Commit the root export cleanup**
```bash
git add package.json knip.json
git commit -m "chore: clean stale package exports"
```
### Task 2: Split Database Schema Modules
**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/db/schema/clinical.ts`
- Create: `src/db/schema/providers.ts`
- Create: `src/db/schema/activity.ts`
- Create: `src/db/schema/nutrition.ts`
- Test: existing schema/import users
- [ ] **Step 1 (RED): Add the failing clinical schema module contract test**
Create `src/db/schema/clinical.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import { allergyIntolerance, condition, medication, medicationDoseEvent } from "./clinical.ts";
describe("clinical schema module", () => {
  it("exports clinical tables from the dedicated module", () => {
    expect(medication).toBeDefined();
    expect(medicationDoseEvent).toBeDefined();
    expect(condition).toBeDefined();
    expect(allergyIntolerance).toBeDefined();
  });
});
```
- [ ] **Step 2 (RED): Run the schema module test and verify the expected failure**
```bash
pnpm vitest run --project unit src/db/schema/clinical.test.ts
```
Expected: FAIL because `src/db/schema/clinical.ts` does not exist.
- [ ] **Step 3 (GREEN): Move the clinical schema group**
Move the clinical tables first: `medication`, `medicationDoseEvent`, `condition`, and `allergyIntolerance` into `src/db/schema/clinical.ts`. Keep exported symbol names identical. Update existing imports to use `src/db/schema/clinical.ts` or the package-specific concrete module path directly; do not keep `src/db/schema.ts` as a re-export shim.
- [ ] **Step 4 (GREEN): Verify clinical imports**
```bash
pnpm vitest run --project unit src/db/schema/clinical.test.ts src/providers/apple-health/import.test.ts
pnpm tsc --noEmit
```
- [ ] **Step 5 (REFACTOR): Move remaining cohesive schema groups**
Move provider/account tables into `providers.ts`, activity/sensor tables into `activity.ts`, and food/nutrition tables into `nutrition.ts`. Preserve all exported names and table definitions exactly. Replace callers with imports from the concrete schema module that owns each table; do not add barrel files or compatibility re-export layers.
- [ ] **Step 6 (GREEN): Verify schema size and tests**
```bash
wc -l src/db/schema.ts src/db/schema/clinical.ts src/db/schema/providers.ts src/db/schema/activity.ts src/db/schema/nutrition.ts
pnpm vitest run --project unit src/db/schema/clinical.test.ts src/providers/apple-health/import.test.ts packages/server/src/routers/provider-detail.test.ts
pnpm tsc --noEmit
```
Expected: every TypeScript schema file is under 1000 lines and all checks pass.
- [ ] **Step 7 (REFACTOR): Commit the schema module split**
```bash
git add src/db/schema.ts src/db/schema/clinical.ts src/db/schema/clinical.test.ts src/db/schema/providers.ts src/db/schema/activity.ts src/db/schema/nutrition.ts
git commit -m "refactor: split database schema modules"
```
### Task 3: Split Mobile Settings
**Files:**
- Modify: `packages/mobile/app/settings.tsx`
- Create: `packages/mobile/components/settings/AccountSection.tsx`
- Create: `packages/mobile/components/settings/ProviderSection.tsx`
- Create: `packages/mobile/components/settings/PersonalizationSection.tsx`
- Create: component tests and stories for created components
- [ ] **Step 1 (REFACTOR): Capture current line count and baseline tests**
```bash
wc -l packages/mobile/app/settings.tsx
pnpm vitest run --project mobile packages/mobile/app/settings.test.tsx
```
Expected: line count is more than 1000 and tests pass before refactor.
- [ ] **Step 2 (RED): Add the failing AccountSection test**
Create `packages/mobile/components/settings/AccountSection.test.tsx`:
```typescript
import { fireEvent, render, screen } from "@testing-library/react-native";
import { describe, expect, it, vi } from "vitest";
import { AccountSection } from "./AccountSection.tsx";
describe("AccountSection", () => {
  it("renders account actions and calls the supplied callbacks", () => {
    const onChangePassword = vi.fn();
    const onSignOut = vi.fn();
    render(
      <AccountSection
        email="athlete@example.com"
        isSaving={false}
        errorMessage={null}
        onChangePassword={onChangePassword}
        onSignOut={onSignOut}
      />,
    );
    expect(screen.getByText("athlete@example.com")).toBeTruthy();
    fireEvent.press(screen.getByText("Change password"));
    fireEvent.press(screen.getByText("Sign out"));
    expect(onChangePassword).toHaveBeenCalledOnce();
    expect(onSignOut).toHaveBeenCalledOnce();
  });
});
```
- [ ] **Step 3 (RED): Run the AccountSection test and verify the expected failure**
```bash
pnpm vitest run --project mobile packages/mobile/components/settings/AccountSection.test.tsx
```
Expected: FAIL because `AccountSection.tsx` does not exist.
- [ ] **Step 4 (GREEN): Extract AccountSection and stories**
Create `AccountSection.tsx` for password/account controls currently embedded in settings. Add `AccountSection.stories.tsx` exports named `Default`, `Loading`, and `Error`, where `Error` passes `errorMessage="Unable to save account changes"`.
- [ ] **Step 5 (GREEN): Verify AccountSection**
```bash
pnpm vitest run --project mobile packages/mobile/components/settings/AccountSection.test.tsx packages/mobile/app/settings.test.tsx
```
- [ ] **Step 6 (RED): Add failing ProviderSection and PersonalizationSection tests**
Create `ProviderSection.test.tsx` proving a seeded provider row renders `"Garmin"` and calls `onOpenProvider("garmin")` when pressed. Create `PersonalizationSection.test.tsx` proving the unit preference label renders `"Distance units"` and calls `onUnitsChange("metric")` when the metric option is pressed.
```bash
pnpm vitest run --project mobile packages/mobile/components/settings/ProviderSection.test.tsx packages/mobile/components/settings/PersonalizationSection.test.tsx
```
Expected: FAIL because the extracted components do not exist.
- [ ] **Step 7 (GREEN): Extract ProviderSection and PersonalizationSection**
Move provider connection controls into `ProviderSection.tsx` and personalization/unit controls into `PersonalizationSection.tsx`. Add `ProviderSection.stories.tsx` exports named `Default`, `Loading`, and `Empty`. Add `PersonalizationSection.stories.tsx` exports named `Default`, `Metric`, and `Imperial`. Keep navigation and tRPC hooks owned by the screen unless moving a hook reduces props without changing behavior.
- [ ] **Step 8 (GREEN): Verify mobile settings split**
```bash
wc -l packages/mobile/app/settings.tsx packages/mobile/components/settings/AccountSection.tsx packages/mobile/components/settings/ProviderSection.tsx packages/mobile/components/settings/PersonalizationSection.tsx
pnpm vitest run --project mobile packages/mobile/app/settings.test.tsx packages/mobile/components/settings/AccountSection.test.tsx packages/mobile/components/settings/ProviderSection.test.tsx packages/mobile/components/settings/PersonalizationSection.test.tsx
pnpm storybook:mobile:build
```
Expected: every touched TypeScript component file is under 1000 lines and all checks pass.
- [ ] **Step 9 (REFACTOR): Commit the mobile settings split**
```bash
git add packages/mobile/app/settings.tsx packages/mobile/components/settings/AccountSection.tsx packages/mobile/components/settings/AccountSection.test.tsx packages/mobile/components/settings/AccountSection.stories.tsx packages/mobile/components/settings/ProviderSection.tsx packages/mobile/components/settings/ProviderSection.test.tsx packages/mobile/components/settings/ProviderSection.stories.tsx packages/mobile/components/settings/PersonalizationSection.tsx packages/mobile/components/settings/PersonalizationSection.test.tsx packages/mobile/components/settings/PersonalizationSection.stories.tsx
git commit -m "refactor: split mobile settings screen"
```
### Task 4: Split Web Provider Detail
**Files:**
- Modify: `packages/web/src/pages/ProviderDetailPage.tsx`
- Create: `packages/web/src/components/provider-detail/ProviderRecordsPanel.tsx`
- Create: `packages/web/src/components/provider-detail/ProviderLogsPanel.tsx`
- Create: `packages/web/src/components/provider-detail/ProviderActionsPanel.tsx`
- Create: component tests and stories for created components
- [ ] **Step 1 (REFACTOR): Capture current line count and baseline tests**
```bash
wc -l packages/web/src/pages/ProviderDetailPage.tsx
pnpm vitest run --project unit packages/web/src/pages/ProviderDetailPage.test.tsx
```
Expected: line count is more than 1000 and tests pass before refactor.
- [ ] **Step 2 (RED): Add the failing ProviderRecordsPanel test**
Create `packages/web/src/components/provider-detail/ProviderRecordsPanel.test.tsx` with tests named:
- `renders provider records and filter controls`: render a seeded record `{ type: "activities", externalId: "activity-1", status: "imported" }`, expect `"activities"` and `"activity-1"`, change the type filter to `"sleep"`, and expect `onTypeFilterChange("sleep")`.
- `renders provider records empty state`: render an empty record list and expect `"No provider records found."`.
Expected RED failure: `ProviderRecordsPanel.tsx` does not exist.
- [ ] **Step 3 (RED): Run the ProviderRecordsPanel test and verify the expected failure**
```bash
pnpm vitest run --project unit packages/web/src/components/provider-detail/ProviderRecordsPanel.test.tsx
```
Expected: FAIL because the extracted component does not exist.
- [ ] **Step 4 (GREEN): Extract ProviderRecordsPanel**
Move record table rendering and filters into `ProviderRecordsPanel.tsx`. Add `ProviderRecordsPanel.stories.tsx` exports named `Default`, `Loading`, and `Empty`.
- [ ] **Step 5 (GREEN): Verify records extraction**
```bash
pnpm vitest run --project unit packages/web/src/components/provider-detail/ProviderRecordsPanel.test.tsx packages/web/src/pages/ProviderDetailPage.test.tsx
```
- [ ] **Step 6 (RED): Add failing logs and actions panel tests**
Create `ProviderLogsPanel.test.tsx` proving a seeded sync log renders `"activities"`, `"done"`, and `"12 records"`. Create `ProviderActionsPanel.test.tsx` proving a connected provider renders `"Sync"` and `"Full sync"`, calls `onSync`, and calls `onFullSync`.
```bash
pnpm vitest run --project unit packages/web/src/components/provider-detail/ProviderLogsPanel.test.tsx packages/web/src/components/provider-detail/ProviderActionsPanel.test.tsx
```
Expected: FAIL because the extracted components do not exist.
- [ ] **Step 7 (GREEN): Extract logs and actions panels**
Move sync history into `ProviderLogsPanel.tsx` and sync/disconnect controls into `ProviderActionsPanel.tsx`. Add `ProviderLogsPanel.stories.tsx` exports named `Default`, `Loading`, and `Empty`. Add `ProviderActionsPanel.stories.tsx` exports named `Connected`, `Disconnected`, `Syncing`, and `Error`. Keep route params and page-level data fetching in `ProviderDetailPage.tsx` unless an existing hook already owns them.
- [ ] **Step 8 (GREEN): Verify web provider detail split**
```bash
wc -l packages/web/src/pages/ProviderDetailPage.tsx packages/web/src/components/provider-detail/ProviderRecordsPanel.tsx packages/web/src/components/provider-detail/ProviderLogsPanel.tsx packages/web/src/components/provider-detail/ProviderActionsPanel.tsx
pnpm vitest run --project unit packages/web/src/pages/ProviderDetailPage.test.tsx packages/web/src/components/provider-detail/ProviderRecordsPanel.test.tsx packages/web/src/components/provider-detail/ProviderLogsPanel.test.tsx packages/web/src/components/provider-detail/ProviderActionsPanel.test.tsx
pnpm storybook:web:build
```
Expected: every touched TypeScript component file is under 1000 lines and all checks pass.
- [ ] **Step 9 (REFACTOR): Commit the provider detail split**
```bash
git add packages/web/src/pages/ProviderDetailPage.tsx packages/web/src/components/provider-detail/ProviderRecordsPanel.tsx packages/web/src/components/provider-detail/ProviderRecordsPanel.test.tsx packages/web/src/components/provider-detail/ProviderRecordsPanel.stories.tsx packages/web/src/components/provider-detail/ProviderLogsPanel.tsx packages/web/src/components/provider-detail/ProviderLogsPanel.test.tsx packages/web/src/components/provider-detail/ProviderLogsPanel.stories.tsx packages/web/src/components/provider-detail/ProviderActionsPanel.tsx packages/web/src/components/provider-detail/ProviderActionsPanel.test.tsx packages/web/src/components/provider-detail/ProviderActionsPanel.stories.tsx
git commit -m "refactor: split provider detail page"
```
### Task 5: Final Static Verification
**Files:**
- Verify all touched files
- [ ] **Step 1 (GREEN): Run full cleanup checks**
```bash
pnpm knip
pnpm lint
pnpm test:unit
pnpm test:mobile
pnpm tsc --noEmit
pnpm storybook:web:build
pnpm storybook:mobile:build
```
- [ ] **Step 2 (REFACTOR): Commit final story or import fixes**
```bash
git add package.json knip.json src/db/schema.ts src/db/schema packages/mobile/app/settings.tsx packages/mobile/components/settings packages/web/src/pages/ProviderDetailPage.tsx packages/web/src/components/provider-detail
git commit -m "chore: finish technical debt cleanup checks"
```
