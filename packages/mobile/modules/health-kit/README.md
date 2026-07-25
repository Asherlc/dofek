# HealthKit Module

This module provides the iOS-native HealthKit bridge used by the mobile app to:

- request HealthKit authorization
- query quantity/workout/sleep/category samples
- query workout routes (GPS points)
- query daily aggregate statistics
- enable background delivery + observer events
- write dietary energy

## Structure

- `index.ts`: TypeScript API exported to React Native code.
- `src/HealthKitModule.ts`: Expo native-module binding (`requireNativeModule("HealthKit")`).
- `ios/HealthKitModule.swift`: Main Swift module implementation.
- `ios/HealthKitTypes.swift`: Canonical HealthKit read/write type sets.
- `ios/HealthKitQueries.swift`: Shared date/unit/query helpers.
- `Tests/`: Swift unit tests for query/type helpers.

## App Integration

- Provider UI/connect flow: `packages/mobile/app/providers/index.tsx`
- Sync pipeline: `packages/mobile/lib/health-kit-sync.ts`
- Background sync bootstrap: `packages/mobile/lib/background-health-kit-sync.ts`

## Background Observer Completion

Each native observer delivery receives a unique update ID. The native module
retains HealthKit's completion callback while JavaScript debounces the delivery
for 500 ms, runs one coalesced sync, and reports the batch result through
`completeObserverUpdates`. Re-registration, JavaScript teardown, and Expo module
destruction stop the queries and complete every callback still pending.

A native 25-second expiration completes an update exactly once and reports the
expired ID to Sentry if JavaScript never responds. This is a failure boundary,
not a successful sync signal; the next HealthKit delivery remains eligible to
retry the same data. Apple's background-delivery contract requires calling the
observer completion handler only after processing the new data finishes:
<https://developer.apple.com/documentation/healthkit/executing-observer-queries>
and
<https://developer.apple.com/documentation/healthkit/hkhealthstore/enablebackgrounddelivery(for:frequency:withcompletion:)>.

## HealthKit Prerequisites

HealthKit must be configured in `app.json` entitlements:

- `com.apple.developer.healthkit`
- `com.apple.developer.healthkit.background-delivery`

## Local Validation

From repo root:

- `pnpm test:mobile -- packages/mobile/app/providers/index.test.tsx`
- `pnpm test:mobile -- packages/mobile/lib/health-kit-sync.test.ts`
- `pnpm test:mobile -- packages/mobile/lib/background-health-kit-sync.test.ts`

## Common Failure Modes

- Entitlement missing: native authorization request throws with HealthKit entitlement text.
- Running on unsupported device/environment: `isAvailable()` false and status `unavailable`.
- Permission drift after adding new types: `getRequestStatus()` returns `shouldRequest`.
- Observer sync failure: JavaScript captures the error in Sentry, reports an
  unsuccessful batch to the native bridge, and then completes every callback
  exactly once because HealthKit's callback itself has no success parameter.
