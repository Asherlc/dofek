# Remove Remaining Manual Health Inputs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make nutrition and journal data provider-ingestion-only by removing every first-party input path.

**Architecture:** Remove input controls and their dedicated client/server support instead of disabling them. Retain read-only queries and provider ingestion. Remove the Slack integration as a complete bounded subsystem and drop its storage with a forward migration.

**Tech Stack:** TypeScript, React, React Native/Expo, tRPC, Drizzle SQL migrations, Vitest, pnpm.

## Global Constraints

- Preserve provider-originated ingestion and existing raw data.
- Remove typed, Quick Add, barcode, AI meal, journal, and Slack entry paths completely; do not hide them behind flags or fallbacks.
- Update web and iOS together for all user-visible nutrition changes.
- Keep all tests colocated and remove tests for deleted behavior.
- Run `pnpm lint`, `pnpm test:changed`, `pnpm tsc --noEmit`, and the server and web TypeScript checks before each push.
- Reuse the canonical upstream implementations from `dcf84aa86`, `ca4674507`, and `21b5d1745` without broadening scope.

---

### Task 1: Remove first-party nutrition logging

**Files:**
- Modify: `packages/web/src/pages/NutritionPage.tsx`, `packages/web/src/components/FoodEntryRow.tsx`, `packages/web/src/components/MealSection.tsx`
- Modify: `packages/mobile/app/(tabs)/food.tsx`, `packages/mobile/app/(tabs)/index.tsx`, `packages/mobile/components/FoodEntryCard.tsx`, `packages/mobile/components/MealSection.tsx`
- Delete: `packages/web/src/components/AddFoodModal.tsx` and colocated test/story; `packages/mobile/app/food/`; `packages/mobile/components/BarcodeScanner.tsx`; manual-entry-only nutrition utilities and their tests
- Modify: the affected web/mobile tests, stories, package manifests, HealthKit food write-back code, and nutrition/mobile/docs references

**Interfaces:**
- Consumes: read-only `trpc.food.byDateV2` and `trpc.nutrition.summary` queries.
- Produces: nutrition screens with no call to `food.create`, `food.delete`, `food.analyzeItemsWithAi`, or input-route navigation.

- [ ] **Step 1: Write failing read-only UI assertions**

In `packages/web/src/pages/NutritionPage.test.tsx` and `packages/mobile/app/(tabs)/food.test.tsx`, assert the screens do not render input controls while retaining existing entries:

```tsx
expect(screen.queryByText(/add food|quick add|log with ai/i)).not.toBeInTheDocument();
expect(screen.getByText("Imported meal")).toBeInTheDocument();
```

- [ ] **Step 2: Run the targeted tests and verify the assertions fail because current controls render**

Run: `pnpm vitest run packages/web/src/pages/NutritionPage.test.tsx "packages/mobile/app/(tabs)/food.test.tsx"`

Expected: failure identifying a rendered manual food control.

- [ ] **Step 3: Apply the canonical food-logging deletion**

Apply upstream commit `dcf84aa86` with its complete, deletion-only file set. Confirm the resulting clients retain query rendering and provider attribution but remove manual food entry, AI parsing/confirmation, barcode scanning, and HealthKit food write-back.

- [ ] **Step 4: Run targeted tests and verify the read-only assertions pass**

Run: `pnpm vitest run packages/web/src/pages/NutritionPage.test.tsx "packages/mobile/app/(tabs)/food.test.tsx"`

Expected: pass; no manual nutrition control remains in either platform screen.

- [ ] **Step 5: Commit the food-input removal**

```bash
git commit -m "feat: remove first-party food logging"
```

### Task 2: Remove Slack food logging and persisted Slack integration data

**Files:**
- Delete: `packages/server/src/slack/`, Slack OAuth routes, Slack repositories, client integration panels, related tests, and Slack-specific scripts
- Modify: `packages/server/src/index.ts`, settings/auth/account-erasure code, provider metadata, deployment configuration, package manifests, and documentation
- Create: `drizzle/0088_remove_slack_storage.sql`
- Modify: `drizzle/meta/_journal.json`

**Interfaces:**
- Consumes: the removal in Task 1, so no food logger depends on Slack.
- Produces: no Slack OAuth, bot, settings panel, worker startup, credential storage, or food-write path; migration removes Slack-only tables.

- [ ] **Step 1: Write a failing server registration test**

In `packages/server/src/index.test.ts`, assert server initialization has no Slack route or bot initialization:

```ts
expect(mockedSlackRoute).not.toHaveBeenCalled();
expect(mockedSlackBotStart).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run the server registration test and verify it fails because Slack is registered**

Run: `pnpm vitest run packages/server/src/index.test.ts`

Expected: failure showing Slack startup or route registration was called.

- [ ] **Step 3: Apply the canonical Slack deletion and migration**

Apply upstream commit `ca4674507`. Retain its forward migration `0088_remove_slack_storage.sql`; do not replace it with application-level cleanup or a disabled integration.

- [ ] **Step 4: Run the Slack migration and targeted server tests**

Run: `pnpm migrate`

Run: `pnpm vitest run packages/server/src/index.test.ts packages/server/src/index.integration.test.ts`

Expected: migration succeeds and server initialization has no Slack registration.

- [ ] **Step 5: Commit the Slack removal**

```bash
git commit -m "feat: remove Slack food logging"
```

### Task 3: Remove manual journal-entry UI

**Files:**
- Delete: `packages/web/src/components/AddJournalEntryModal.tsx` and colocated test/story
- Modify: `packages/web/src/components/JournalPanel.tsx` and its test/story
- Modify: `packages/web/src/components/test-helpers/TimeRangeSelectorConsumers.tsx`

**Interfaces:**
- Consumes: read-only `trpc.journal.entries` query.
- Produces: journal display with no `journal.create` call and no add-entry control.

- [ ] **Step 1: Write a failing journal-panel assertion**

In `packages/web/src/components/JournalPanel.test.tsx`, assert journal entries render but the creation control does not:

```tsx
expect(screen.getByText("Imported journal entry")).toBeInTheDocument();
expect(screen.queryByRole("button", { name: /add entry/i })).not.toBeInTheDocument();
```

- [ ] **Step 2: Run the journal-panel test and verify it fails because the control exists**

Run: `pnpm vitest run packages/web/src/components/JournalPanel.test.tsx`

Expected: failure finding the Add Entry button.

- [ ] **Step 3: Apply the canonical journal UI deletion**

Apply upstream commit `21b5d1745`. Keep the read-only journal query and existing entry rendering; remove only the creation modal, its import/state, control, tests, and story coverage.

- [ ] **Step 4: Run the journal-panel test and verify it passes**

Run: `pnpm vitest run packages/web/src/components/JournalPanel.test.tsx`

Expected: pass; imported entries remain visible without an Add Entry control.

- [ ] **Step 5: Commit the journal input removal**

```bash
git commit -m "feat: remove journal input UI"
```

### Task 4: Verify the final deletion boundary

**Files:**
- Modify: only test or documentation files if verification reveals stale manual-input references.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: a provider-ingestion-only repository without stale first-party health-input references.

- [ ] **Step 1: Search for first-party input identifiers**

Run:

```bash
rg -n 'AddFoodModal|food/analyzeItemsWithAi|food\.create|food\.quickAdd|SlackIntegrationPanel|AddJournalEntryModal' packages src docs
```

Expected: no production first-party input path; retained provider-domain mentions must be reviewed individually.

- [ ] **Step 2: Run the required pre-push checks**

Run:

```bash
pnpm lint
pnpm test:changed
pnpm tsc --noEmit
cd packages/server && pnpm tsc --noEmit
cd packages/web && pnpm tsc --noEmit
```

Expected: every command exits zero.

- [ ] **Step 3: Commit only verification-driven cleanup**

```bash
git commit -m "test: verify manual health inputs are removed"
```

