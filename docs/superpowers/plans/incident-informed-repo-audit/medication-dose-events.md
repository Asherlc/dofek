# Medication Dose Events Implementation Plan
**Goal:** Ingest and display raw medication dose events using the existing `fitness.medication_dose_event` table without adding derived medication summaries.
**Architecture:** Keep storage provider-agnostic and raw. Add Apple Health dose-event ingestion from the existing HealthKit bridge, expose a small server read router, and render equivalent web/mobile list surfaces.
**Tech Stack:** TypeScript, Swift HealthKit bridge, Drizzle, tRPC, Zod, Vitest, React, React Native/Expo.
## File Structure
- Modify `src/providers/apple-health/import.ts`: insert `medicationDoseEvent` rows from HealthKit dose-event payloads.
- Modify `src/providers/apple-health/import.test.ts`: cover dose-event mapping and idempotent upsert.
- Create `packages/server/src/routers/medication-dose-events.ts`: authenticated list endpoint.
- Create `packages/server/src/routers/medication-dose-events.test.ts`.
- Modify `packages/server/src/router.ts`: mount `medicationDoseEvents`.
- Create `packages/web/src/components/MedicationDoseEventsPanel.tsx`, `packages/web/src/components/MedicationDoseEventsPanel.test.tsx`, and `packages/web/src/components/MedicationDoseEventsPanel.stories.tsx`.
- Modify `packages/web/src/pages/SettingsPage.tsx` or the existing health-data page chosen for medications: render the panel.
- Create `packages/mobile/components/MedicationDoseEventsPanel.tsx`, `packages/mobile/components/MedicationDoseEventsPanel.test.tsx`, and `packages/mobile/components/MedicationDoseEventsPanel.stories.tsx`.
- Modify `packages/mobile/app/settings.tsx`: render the mobile panel.
### Task 1: Apple Health Dose Event Ingestion
**Files:**
- Modify: `src/providers/apple-health/import.ts`
- Test: `src/providers/apple-health/import.test.ts`
- [ ] **Step 1 (RED): Add the failing ingestion test**
Add:
```typescript
it("imports medication dose events as raw provider records", async () => {
  const files = [
    {
      name: "MedicationDoseEvent-001.json",
      content: JSON.stringify({
        uuid: "dose-1",
        startDate: "2026-06-29T15:30:00.000Z",
        endDate: "2026-06-29T15:30:00.000Z",
        logStatus: 1,
        medicationConceptIdentifier: "rxnorm-123",
        medicationDisplayName: "Metformin 500 mg",
      }),
    },
  ];
  await importAppleHealthExport({
    db: mockDb,
    files,
    providerId: "apple_health",
    userId: "user-1",
  });
  const doseEventBatch = allValuesCalls.find((values) =>
    values.some((value) => value.medicationName === "Metformin 500 mg"),
  );
  expect(doseEventBatch).toEqual([
    expect.objectContaining({
      externalId: "dose-1",
      medicationName: "Metformin 500 mg",
      medicationConceptId: "rxnorm-123",
      doseStatus: "taken",
      recordedAt: new Date("2026-06-29T15:30:00.000Z"),
      providerId: "apple_health",
      userId: "user-1",
    }),
  ]);
});
```
- [ ] **Step 2 (RED): Run the ingestion test and verify the expected failure**
```bash
pnpm vitest run --project unit src/providers/apple-health/import.test.ts --testNamePattern "medication dose events"
```
Expected: FAIL because Apple Health import does not insert `medicationDoseEvent` rows.
- [ ] **Step 3 (GREEN): Implement dose-event parsing and insert**
Import `medicationDoseEvent` from `src/db/schema.ts`. Parse dose payloads into raw rows with `providerId`, `userId`, `externalId`, `medicationName`, `medicationConceptId`, `doseStatus`, `recordedAt`, `sourceName`, and `raw`. Map known HealthKit log statuses to stable strings such as `taken` and `skipped`; preserve the original payload in `raw`.
- [ ] **Step 4 (GREEN): Run ingestion tests**
```bash
pnpm vitest run --project unit src/providers/apple-health/import.test.ts
```
- [ ] **Step 5 (REFACTOR): Commit Apple Health dose-event ingestion**
```bash
git add src/providers/apple-health/import.ts src/providers/apple-health/import.test.ts
git commit -m "feat: import medication dose events"
```
### Task 2: Medication Dose Event Router
**Files:**
- Create: `packages/server/src/routers/medication-dose-events.ts`
- Create: `packages/server/src/routers/medication-dose-events.test.ts`
- Modify: `packages/server/src/router.ts`
- [ ] **Step 1 (RED): Add the failing router test**
Create `packages/server/src/routers/medication-dose-events.test.ts`:
```typescript
import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";
import { medicationDoseEventsRouter } from "./medication-dose-events.ts";
const createCaller = createTestCallerFactory(medicationDoseEventsRouter);
describe("medicationDoseEventsRouter", () => {
  it("lists dose events for the current user only", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([
                {
                  id: "event-1",
                  providerId: "apple_health",
                  medicationName: "Metformin 500 mg",
                  medicationConceptId: "rxnorm-123",
                  doseStatus: "taken",
                  recordedAt: new Date("2026-06-29T15:30:00.000Z"),
                  sourceName: "Apple Health",
                },
              ]),
            })),
          })),
        })),
      })),
    };
    const caller = createCaller({ db, userId: "user-1", timezone: "UTC" });
    const result = await caller.list({ limit: 25 });
    expect(result.events).toEqual([
      {
        id: "event-1",
        providerId: "apple_health",
        medicationName: "Metformin 500 mg",
        medicationConceptId: "rxnorm-123",
        doseStatus: "taken",
        recordedAt: "2026-06-29T15:30:00.000Z",
        sourceName: "Apple Health",
      },
    ]);
  });
});
```
- [ ] **Step 2 (RED): Run the router test and verify the expected failure**
```bash
pnpm vitest run --project unit packages/server/src/routers/medication-dose-events.test.ts
```
Expected: FAIL because the router does not exist.
- [ ] **Step 3 (GREEN): Implement the router**
Add a `list` protected query with input `{ limit?: number }`, capped at 100. Select from `medicationDoseEvent` where `userId === ctx.userId`, order by `recordedAt` descending, and return raw event rows only. Do not add summaries, daily totals, adherence percentages, or derived counts.
- [ ] **Step 4 (GREEN): Mount the router and run tests**
```bash
pnpm vitest run --project unit packages/server/src/routers/medication-dose-events.test.ts packages/server/src/router.test.ts
```
- [ ] **Step 5 (REFACTOR): Commit the medication dose router**
```bash
git add packages/server/src/routers/medication-dose-events.ts packages/server/src/routers/medication-dose-events.test.ts packages/server/src/router.ts
git commit -m "feat: expose medication dose events"
```
### Task 3: Web And Mobile Surfaces
**Files:**
- Create: `packages/web/src/components/MedicationDoseEventsPanel.tsx`
- Create: `packages/web/src/components/MedicationDoseEventsPanel.test.tsx`
- Create: `packages/web/src/components/MedicationDoseEventsPanel.stories.tsx`
- Modify: `packages/web/src/pages/SettingsPage.tsx`
- Create: `packages/mobile/components/MedicationDoseEventsPanel.tsx`
- Create: `packages/mobile/components/MedicationDoseEventsPanel.test.tsx`
- Create: `packages/mobile/components/MedicationDoseEventsPanel.stories.tsx`
- Modify: `packages/mobile/app/settings.tsx`
- [ ] **Step 1 (RED): Add concrete web and mobile rendering tests**
Create `packages/web/src/components/MedicationDoseEventsPanel.test.tsx` with a test named `renders medication dose events from the server`. Mock `medicationDoseEvents.list` to return one event with `medicationName: "Metformin 500 mg"`, `doseStatus: "taken"`, `providerId: "apple_health"`, and `sourceName: "Apple Health"`. Expected RED failure: the component file does not exist yet.
Required web assertions:
```typescript
expect(screen.getByText("Metformin 500 mg")).toBeInTheDocument();
expect(screen.getByText("Taken")).toBeInTheDocument();
expect(screen.getByText("Apple Health")).toBeInTheDocument();
```
Create `packages/mobile/components/MedicationDoseEventsPanel.test.tsx` with a test named `renders medication dose events from the server on mobile`. Use the same mocked event fixture. Expected RED failure: the component file does not exist yet.
Required mobile assertions:
```typescript
expect(screen.getByText("Metformin 500 mg")).toBeTruthy();
expect(screen.getByText("Taken")).toBeTruthy();
expect(screen.getByText("Apple Health")).toBeTruthy();
```
- [ ] **Step 2 (RED): Run UI tests and verify the expected failures**
```bash
pnpm vitest run --project unit packages/web/src/components/MedicationDoseEventsPanel.test.tsx
pnpm vitest run --project mobile packages/mobile/components/MedicationDoseEventsPanel.test.tsx
```
Expected: FAIL because the components do not exist.
- [ ] **Step 3 (GREEN): Implement panels and concrete stories**
Render a plain chronological list from `medicationDoseEvents.list`. Include loading, empty, and error states. Display `error.message` when the query fails. Do not calculate adherence or daily medication summaries in the client.
Create `MedicationDoseEventsPanel.stories.tsx` on both web and mobile with exact named exports:
```typescript
export const Default = makeStory([{ medicationName: "Metformin", doseDisplay: "500 mg", status: "taken", provider: "Apple Health" }]);
export const Loading = makeLoadingStory();
export const Empty = makeEmptyStory("No medication dose events synced yet.");
export const Error = makeErrorStory("Medication dose events failed to load.");
```
The `Default` story must show `"Metformin 500 mg"`, `"Taken"`, and `"Apple Health"`. The `Error` story must render the provided server/client error message verbatim.
- [ ] **Step 4 (GREEN): Add panels to settings surfaces**
Render web and mobile panels in the existing settings surfaces so both platforms have parity in the same PR.
- [ ] **Step 5 (GREEN): Run verification**
```bash
pnpm vitest run --project unit packages/web/src/components/MedicationDoseEventsPanel.test.tsx
pnpm vitest run --project mobile packages/mobile/components/MedicationDoseEventsPanel.test.tsx packages/mobile/app/settings.test.tsx
pnpm storybook:web:build
pnpm storybook:mobile:build
pnpm tsc --noEmit
```
- [ ] **Step 6 (REFACTOR): Commit medication dose event surfaces**
```bash
git add packages/web/src/components/MedicationDoseEventsPanel.tsx packages/web/src/components/MedicationDoseEventsPanel.test.tsx packages/web/src/components/MedicationDoseEventsPanel.stories.tsx packages/web/src/pages/SettingsPage.tsx packages/mobile/components/MedicationDoseEventsPanel.tsx packages/mobile/components/MedicationDoseEventsPanel.test.tsx packages/mobile/components/MedicationDoseEventsPanel.stories.tsx packages/mobile/app/settings.tsx
git commit -m "feat: show medication dose events"
```
