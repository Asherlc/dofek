# HealthKit Module

This module provides the iOS-native HealthKit bridge used by the mobile app to:

- request HealthKit authorization
- query quantity/workout/sleep/category samples
- query workout routes (GPS points)
- query daily aggregate statistics
- incrementally query samples and deletions with a native-persisted opaque anchor
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
expired update ID, HealthKit sample type, and monotonic callback age to Sentry
if JavaScript never responds. JavaScript logs the start and completion of each
query, upload batch, and post-sync callback with its duration and item context.
This is a failure boundary, not a successful sync signal; the next HealthKit
delivery remains eligible to retry the same data. Apple's background-delivery
contract requires calling the observer completion handler only after processing
the new data finishes:
<https://developer.apple.com/documentation/healthkit/executing-observer-queries>
and
<https://developer.apple.com/documentation/healthkit/hkhealthstore/enablebackgrounddelivery(for:frequency:withcompletion:)>.

## HealthKit Prerequisites

HealthKit must be configured in `app.json` entitlements:

- `com.apple.developer.healthkit`
- `com.apple.developer.healthkit.background-delivery`

## Incremental Anchored Queries

`queryAnchoredSamples(typeIdentifier)` keeps `HKQueryAnchor` entirely inside
the native module. The module securely archives the successful query's returned
anchor in `UserDefaults`, restores it for the next query of that type, and does
not expose or accept fabricated numeric anchor values in JavaScript. Apple
documents `HKQueryAnchor` as conforming to `NSSecureCoding`:
<https://developer.apple.com/documentation/healthkit/hkqueryanchor>.

## Local Validation

From repo root:

- `pnpm test:mobile -- packages/mobile/app/providers/index.test.tsx`
- `pnpm test:mobile -- packages/mobile/lib/health-kit-sync.test.ts`
- `pnpm test:mobile -- packages/mobile/lib/background-health-kit-sync.test.ts`

## Physical-Device Observer Validation

For changes to background observer delivery, complete this acceptance check on
a physical iPhone with a Release build:

1. Grant HealthKit read access, background the app, lock the device, and create
   or import a sample for an observed HealthKit type.
2. Confirm the native update ID and sample type reach JavaScript, then verify
   that the query, upload, post-sync callback, and overall observer logs include
   monotonic durations and item context.
3. Verify JavaScript acknowledges the update ID before the 25-second native
   expiration and that no `com.dofek.healthkit-observer` expiration event is
   reported.
4. Repeat with multiple sample types delivered together and confirm every
   update ID is completed exactly once after the coalesced sync.

Apple requires the observer completion handler to run after the app finishes
processing the delivered data:
<https://developer.apple.com/documentation/healthkit/executing-observer-queries>.

## Common Failure Modes

- Entitlement missing: native authorization request throws with HealthKit entitlement text.
- Running on unsupported device/environment: `isAvailable()` false and status `unavailable`.
- Permission drift after adding new types: `getRequestStatus()` returns `shouldRequest`.
- `com.apple.healthkit` code 5 is `errorAuthorizationNotDetermined`, an expected
  observer-registration state for types whose permission prompt has not
  completed. Record an informational breadcrumb and complete that observer
  callback without reporting an exception; continue reporting unexpected
  observer errors with the operation and sample type attached. Apple documents
  the code and required authorization flow:
  <https://developer.apple.com/documentation/healthkit/hkerror/code/errorauthorizationnotdetermined>.
- `com.apple.healthkit` code 6 is `errorDatabaseInaccessible`, a transient query
  failure while protected HealthKit data is unavailable on a locked device:
  <https://developer.apple.com/documentation/healthkit/hkerror/code/errordatabaseinaccessible>.
- Observer sync failure: JavaScript captures the error in Sentry, reports an
  unsuccessful batch to the native bridge, and then completes every callback
  exactly once because HealthKit's callback itself has no success parameter.
