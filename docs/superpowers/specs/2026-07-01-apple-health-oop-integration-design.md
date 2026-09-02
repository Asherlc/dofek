# Apple Health OOP Integration Design

## Goal

Centralize Apple Health mobile integration behind explicit domain objects so authorization state, provider UI state, re-authorization prompting, and sync wiring are no longer reinterpreted separately by provider list, provider detail, app layout, auto-sync, and background sync code.

## Scope

This refactor covers the mobile Apple Health integration only. It keeps the existing native HealthKit module, `syncHealthKitToServer()` pipeline, server mutations, and provider UI components. It replaces duplicated Apple Health-specific glue with OOP services and a React hook wrapper.

## Object Model

`AppleHealthAuthorizationState` is a value object. It stores `available`, `requestStatus`, and `hasCompletedAuthorizationFlow`, and exposes domain methods:

- `isConnected()`: true when HealthKit is available and either the local authorization marker is true or the current HealthKit request status is `unnecessary`.
- `needsPermissionUpdate()`: true when HealthKit is available, the user has completed the authorization flow before, and the current request status is `shouldRequest`.
- `canAttemptSync()`: true when HealthKit is available. Sync eligibility must not depend on the local marker.

`AppleHealthAuthorizationService` wraps native HealthKit authorization calls. It resolves the value object, requests permissions, and returns refreshed authorization state. Native `getRequestStatus()` remains responsible for repairing the local marker when status is `unnecessary`.

`AppleHealthSyncService` wraps native query adapter construction and tRPC sync-client construction. It exposes `sync({ syncRangeDays, onProgress })`, delegating actual ingestion behavior to `syncHealthKitToServer()`.

`AppleHealthProviderModel` composes authorization and sync services. It exposes UI/provider semantics:

- `toProviderCard()`
- `toDisplayProvider()`
- `connect()`
- `sync()`
- `shouldShowPermissionBanner()`

`useAppleHealthProviderModel()` is the React hook wrapper. It owns loading/refreshed authorization state and exposes a current model plus refresh/connect/sync actions for screens.

## Data Flow

Provider list and provider detail consume `useAppleHealthProviderModel()` instead of storing `healthKitPermissionStatus` and `healthKitEverAuthorized` directly. `_layout.tsx` uses `AppleHealthAuthorizationService` to decide whether to re-request newly added permissions. `useAutoSync` and `background-health-kit-sync` use `AppleHealthSyncService` for sync execution instead of constructing HealthKit adapters and tRPC clients inline.

## Error Handling

Authorization status checks capture unexpected errors through existing Sentry telemetry contexts. Permission request failures surface the native error message to the provider UI. Sync failures preserve existing handling, including the background-sync device-locked special case and normal Sentry reporting for unexpected failures.

## Testing

Add unit tests for `AppleHealthAuthorizationState`, `AppleHealthAuthorizationService`, and `AppleHealthSyncService`. Cover stale marker false plus request status `unnecessary`, marker true plus request status `shouldRequest`, unavailable HealthKit, permission request refresh, and sync-client delegation. Update provider list/detail/layout/auto-sync/background tests to assert they use the shared model behavior instead of duplicating authorization interpretation.

## Non-Goals

Do not change server provider registration, database schema, native HealthKit query behavior, `syncHealthKitToServer()` ingestion semantics, or generic provider UI components.
