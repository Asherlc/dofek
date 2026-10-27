# Remove iOS Manual Activity Recording

## Decision

Remove Dofek's user-initiated iOS GPS workout recorder completely. The app will
continue to display activities and routes imported from Apple Health and other
providers. Passive iPhone and Apple Watch motion collection, WatchConnectivity
file transfer, BLE heart-rate capture, and WHOOP synchronization remain in
scope as supported features.

## Scope

- Remove the Activities-tab **Record Activity** entry point and the Expo Router
  `/record` screen.
- Delete the recorder's client implementation: GPS location adapter, activity
  lifecycle/save coordinator, and the sensor services whose only consumer is
  manual recording.
- Remove the server-only `activityRecording.save` tRPC router and its tests.
- Remove the iOS foreground/background location permission strings, Expo
  Location plugin entry, and `location` background mode. Expo documents that
  background location configuration is specifically required for background
  location updates: <https://docs.expo.dev/versions/latest/sdk/location/#background-location-configuration>.
- Update the mobile README so it describes imported activity history rather
  than a recorder.

## Deliberate Non-Changes

- Keep the Activities tab, activity detail pages, route display, and activity
  deletion. They serve provider-imported data.
- Keep Apple Health workout and workout-route import. The HealthKit integration
  reads existing workout routes and is independent of recording new GPS
  samples.
- Keep background accelerometer sync, WatchConnectivity, watchOS recording
  sessions, BLE heart-rate support, and WHOOP BLE. These provide passive sensor
  collection and are not part of the manual workout recorder.
- Do not alter activity storage, migrations, or other activity routers; imported
  activities remain the canonical source for displayed history.

## Design

The mobile Activities screen remains the single activity-history entry point
but no longer offers manual creation. Deleting the `/record` route makes the
feature unreachable through both normal navigation and deep links.

The client removal is complete rather than cosmetic: the deleted screen is the
only consumer of the recording coordinator and its GPS adapter. Its associated
manual-recording sensor services are removed with their focused tests, while
the background services that independently collect/sync motion data remain.

The API removal follows the client deletion. `activityRecording.save` exists
only to persist manually-recorded activities and their sensor samples, so its
router registration, implementation, and tests are deleted. No compatibility
endpoint is retained.

Native configuration is reduced to the permissions that remaining app features
need. Removing Expo Location configuration also removes the iOS location usage
descriptions and background-location entitlement from generated native output;
the remaining Bluetooth and fetch modes continue to support their respective
native integrations.

## Verification

- Delete tests that exclusively cover the removed recorder; do not add tests
  whose only assertion is that the feature is absent.
- Run focused mobile and server tests affected by the deletions, then the
  repository's relevant lint, typecheck, and unit tiers.
- Verify the mobile activity-list tests still cover rendering provider-imported
  activities and routes.
- Run Expo prebuild/config validation so the generated iOS project accepts the
  reduced configuration.

## Out of Scope

Removing passive watchOS motion recording or imported activity history would be
a separate decision, because both retain independent product value and code
paths after this change.
