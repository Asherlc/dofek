# Apple Health OOP Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace duplicated Apple Health authorization and sync wiring with a focused OOP integration boundary.

**Architecture:** Add a mobile Apple Health provider module with an authorization state value object, authorization service, sync service, provider model, and hook wrapper. Existing screens keep their UI components but consume the model instead of interpreting native HealthKit state directly.

**Tech Stack:** TypeScript, React hooks, Vitest, existing Expo HealthKit native module, existing tRPC client, existing `syncHealthKitToServer()`.

---

## File Structure

- Create `packages/mobile/lib/apple-health-provider.ts`: OOP classes and hook for Apple Health authorization, provider display state, and sync delegation.
- Create `packages/mobile/lib/apple-health-provider.test.ts`: colocated unit tests for value object, services, model, and hook-facing behavior.
- Modify `packages/mobile/app/providers/index.tsx`: use `useAppleHealthProviderModel()` for Apple Health card, connect, and sync.
- Modify `packages/mobile/app/providers/use-provider-detail-actions.ts`: use `useAppleHealthProviderModel()` for Apple Health display and actions.
- Modify `packages/mobile/app/_layout.tsx`: use `AppleHealthAuthorizationService` for foreground re-auth prompting.
- Modify `packages/mobile/lib/useAutoSync.ts`: use `AppleHealthSyncService` for Apple Health sync.
- Modify `packages/mobile/lib/background-health-kit-sync.ts`: use `AppleHealthSyncService` for background sync.
- Update existing tests that mock HealthKit/tRPC expectations to target the shared model behavior.

## Tasks

### Task 1: Add Apple Health Provider Module Tests

**Files:**
- Create: `packages/mobile/lib/apple-health-provider.test.ts`
- Create: `packages/mobile/lib/apple-health-provider.ts`

- [ ] Write failing tests for `AppleHealthAuthorizationState`:
  - marker false + request status `unnecessary` is connected
  - marker false + request status `shouldRequest` is not connected
  - marker true + request status `shouldRequest` needs permission update
  - unavailable cannot attempt sync

- [ ] Write failing tests for `AppleHealthAuthorizationService`:
  - `resolve()` calls native availability, marker, and request status
  - `requestPermissions()` returns refreshed state

- [ ] Write failing tests for `AppleHealthSyncService`:
  - constructs the native adapter and sync client
  - delegates to `syncHealthKitToServer()` with `syncRangeDays` and `onProgress`

- [ ] Run:
  `rtk pnpm vitest run packages/mobile/lib/apple-health-provider.test.ts`
  Expected: fail because the module does not exist yet.

### Task 2: Implement Apple Health Provider Module

**Files:**
- Modify: `packages/mobile/lib/apple-health-provider.ts`
- Test: `packages/mobile/lib/apple-health-provider.test.ts`

- [ ] Implement `AppleHealthAuthorizationState`, `AppleHealthAuthorizationService`, `AppleHealthSyncService`, `AppleHealthProviderModel`, and `useAppleHealthProviderModel()`.
- [ ] Run:
  `rtk pnpm vitest run packages/mobile/lib/apple-health-provider.test.ts`
  Expected: pass.

### Task 3: Replace Provider List Apple Health Glue

**Files:**
- Modify: `packages/mobile/app/providers/index.tsx`
- Modify: `packages/mobile/app/providers/index.test.tsx`
- Test: `packages/mobile/app/providers/index.test.tsx`

- [ ] Replace local `healthKitPermissionStatus` and `healthKitEverAuthorized` state with `useAppleHealthProviderModel()`.
- [ ] Route Apple Health connect/sync actions through `AppleHealthProviderModel`.
- [ ] Run:
  `rtk pnpm vitest run packages/mobile/app/providers/index.test.tsx`
  Expected: pass.

### Task 4: Replace Provider Detail Apple Health Glue

**Files:**
- Modify: `packages/mobile/app/providers/use-provider-detail-actions.ts`
- Modify: `packages/mobile/app/providers/[id].test.tsx`
- Test: `packages/mobile/app/providers/[id].test.tsx`

- [ ] Replace local Apple Health authorization state and manual sync-client construction with `useAppleHealthProviderModel()`.
- [ ] Run:
  `rtk pnpm vitest run 'packages/mobile/app/providers/[id].test.tsx'`
  Expected: pass.

### Task 5: Replace Layout, Auto-Sync, and Background Sync Wiring

**Files:**
- Modify: `packages/mobile/app/_layout.tsx`
- Modify: `packages/mobile/app/_layout.cleanup.test.tsx`
- Modify: `packages/mobile/lib/useAutoSync.ts`
- Modify: `packages/mobile/lib/useAutoSync.test.ts`
- Modify: `packages/mobile/lib/background-health-kit-sync.ts`
- Modify: `packages/mobile/lib/background-health-kit-sync.test.ts`

- [ ] Use `AppleHealthAuthorizationService` for foreground re-auth in `_layout.tsx`.
- [ ] Use `AppleHealthSyncService` in auto-sync and background sync.
- [ ] Run:
  `rtk pnpm vitest run packages/mobile/app/_layout.cleanup.test.tsx packages/mobile/lib/useAutoSync.test.ts packages/mobile/lib/background-health-kit-sync.test.ts`
  Expected: pass.

### Task 6: Final Verification

**Files:**
- All modified files.

- [ ] Run:
  `rtk pnpm vitest run packages/mobile/lib/apple-health-provider.test.ts packages/mobile/app/providers/index.test.tsx 'packages/mobile/app/providers/[id].test.tsx' packages/mobile/app/_layout.cleanup.test.tsx packages/mobile/lib/background-health-kit-sync.test.ts packages/mobile/lib/useAutoSync.test.ts packages/mobile/lib/health-kit-sync.test.ts`
- [ ] Run:
  `rtk pnpm biome check packages/mobile/lib/apple-health-provider.ts packages/mobile/lib/apple-health-provider.test.ts packages/mobile/app/providers/index.tsx packages/mobile/app/providers/index.test.tsx 'packages/mobile/app/providers/[id].test.tsx' packages/mobile/app/providers/use-provider-detail-actions.ts packages/mobile/app/_layout.tsx packages/mobile/app/_layout.cleanup.test.tsx packages/mobile/lib/background-health-kit-sync.ts packages/mobile/lib/background-health-kit-sync.test.ts packages/mobile/lib/useAutoSync.ts packages/mobile/lib/useAutoSync.test.ts`
- [ ] Run:
  `rtk pnpm --filter dofek-mobile typecheck`
- [ ] Commit implementation changes.
