# Apple Health Food Write-Back Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mobile writes direct Dofek food entries back to Apple Health as dietary calories, protein, carbohydrates, and fat.

**Architecture:** The server exposes a protected food query filtered to `provider_id = 'dofek'`. Mobile reconciles those entries to HealthKit using a local fingerprint ledger, deleting old Dofek-written samples before rewriting changed entries. The HealthKit native module exposes one general dietary writer plus a delete method keyed by HealthKit sync identifiers.

**Tech Stack:** TypeScript, tRPC, Vitest, Expo React Native, Swift HealthKit, expo-secure-store.

---

### Task 1: Server Dofek Food Export

**Files:**
- Modify: `packages/server/src/repositories/food-repository.ts`
- Modify: `packages/server/src/routers/food.ts`
- Test: `packages/server/src/routers/food.integration.test.ts`

- [x] **Step 1: Write failing router tests**

Add tests proving `food.healthKitWriteBackEntries` returns server-filtered Dofek entries and rejects non-date input.

Run: `pnpm vitest packages/server/src/routers/food.integration.test.ts -t healthKitWriteBackEntries`
Expected: FAIL because the procedure does not exist.

- [x] **Step 2: Implement repository query and router procedure**

Add a `FoodRepository.healthKitWriteBackEntries(startDate, endDate)` method that selects confirmed rows from `fitness.v_food_entry_with_nutrition` where `user_id` matches and `provider_id = 'dofek'`. Return only `id`, `date`, `food_name`, `calories`, `protein_g`, `carbs_g`, and `fat_g`.

Run: `pnpm vitest packages/server/src/routers/food.integration.test.ts -t healthKitWriteBackEntries`
Expected: PASS.

### Task 2: Mobile Write-Back Sync

**Files:**
- Create: `packages/mobile/lib/health-kit-food-writeback.ts`
- Test: `packages/mobile/lib/health-kit-food-writeback.test.ts`

- [x] **Step 1: Write failing mobile sync tests**

Cover initial writes, skipping existing fingerprints, changed-entry delete-and-rewrite, absent nutrient skipping, and Sentry reporting for write failures.

Run: `pnpm test:mobile -- packages/mobile/lib/health-kit-food-writeback.test.ts`
Expected: FAIL because the module does not exist.

- [x] **Step 2: Implement mobile sync**

Implement `syncDofekFoodToHealthKit()` with injected tRPC client, HealthKit adapter, and storage adapter. Persist a JSON ledger in SecureStore keyed by food entry id. Compute fingerprints from date, calories, protein, carbs, and fat.

Run: `pnpm test:mobile -- packages/mobile/lib/health-kit-food-writeback.test.ts`
Expected: PASS.

### Task 3: HealthKit Native Writer

**Files:**
- Modify: `packages/mobile/modules/health-kit/index.ts`
- Modify: `packages/mobile/modules/health-kit/ios/HealthKitTypes.swift`
- Modify: `packages/mobile/modules/health-kit/ios/HealthKitModule.swift`
- Test: `packages/mobile/modules/health-kit/Tests/HealthKitTypesTests.swift`

- [x] **Step 1: Write failing Swift helper test**

Add a test that supported dietary identifiers resolve and unsupported quantity identifiers return nil.

Run: `cd packages/mobile/modules/health-kit && swift test --filter HealthKitTypesTests`
Expected: FAIL because the helper does not exist.

- [x] **Step 2: Implement Swift helper and native methods**

Add a helper that resolves only writable dietary quantity identifiers. Add `writeDietarySamples(samples)` and `deleteDietarySamples(syncIdentifiers)` to `HealthKitModule.swift`. Written samples include `HKMetadataKeySyncIdentifier`, `HKMetadataKeySyncVersion`, Dofek food entry metadata, nutrient type metadata, and fingerprint metadata.

Run: `cd packages/mobile/modules/health-kit && swift test --filter HealthKitTypesTests`
Expected: PASS.

### Task 4: Mobile Wiring

**Files:**
- Modify: `packages/mobile/lib/useAutoSync.ts`
- Modify: `packages/mobile/lib/useAutoSync.test.ts`
- Modify: `packages/mobile/app/providers/index.tsx`
- Test: `packages/mobile/app/providers/index.test.tsx`

- [x] **Step 1: Write failing wiring tests**

Update auto-sync tests to expect Dofek food write-back after HealthKit sync when HealthKit is available and authorized. Update provider screen tests to expect the Apple Health manual sync path to invoke food write-back.

Run: `pnpm test:mobile -- packages/mobile/lib/useAutoSync.test.ts packages/mobile/app/providers/index.test.tsx`
Expected: FAIL because write-back is not wired.

- [x] **Step 2: Wire write-back**

Call `syncDofekFoodToHealthKit()` after successful HealthKit sync in `useAutoSync` and after manual HealthKit sync in provider UI. Surface manual write-back progress through the existing Apple Health progress text.

Run: `pnpm test:mobile -- packages/mobile/lib/useAutoSync.test.ts packages/mobile/app/providers/index.test.tsx`
Expected: PASS.

### Task 5: Docs and Final Verification

**Files:**
- Modify: `docs/apple-health.md`

- [x] **Step 1: Document write-back behavior**

Add a concise section explaining that mobile writes direct Dofek food entries to Apple Health and excludes provider-synced nutrition.

- [x] **Step 2: Run required checks**

Run:

```bash
pnpm lint
pnpm test:changed
pnpm tsc --noEmit
cd packages/server && pnpm tsc --noEmit
cd packages/web && pnpm tsc --noEmit
cd packages/mobile && pnpm tsc --noEmit
cd packages/mobile/modules/health-kit && swift test --filter HealthKitTypesTests
```

Expected: all commands exit 0.
