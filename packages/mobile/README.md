# dofek-mobile

The mobile app for Dofek. Built with Expo and React Native, with native Swift modules for HealthKit and WHOOP BLE synchronization.

## Core Features

- **HealthKit Sync**: Background synchronization of health and fitness metrics from iOS using `BackgroundRefreshModule` which registers `BGAppRefreshTask`.
- **WHOOP BLE Sync**: High-resolution sensor data capture (IMU - accelerometer + gyroscope) from WHOOP straps via `WhoopBleModule`.
  Reported heart rate is uploaded independently of beat-interval availability,
  as supported by WHOOP's [research FAQ, page 4](https://sensorlab.arizona.edu/sites/default/files/2023-05/WHOOP%20Unite%20Research%20FAQs_0.pdf#page=4).
  The [native module reference](modules/whoop-ble/README.md) describes the buffered
  fields and fractional clock conversion.
- **Bluetooth Heart-Rate Monitors**: Pair in Settings and passively upload live
  heart rate + R-R intervals from any standard Bluetooth heart-rate strap via
  `BleHeartRateModule`, using the Bluetooth SIG [Heart Rate Service](https://www.bluetooth.com/specifications/specs/heart-rate-service-1-0/)
  (`0x180D`) / Heart Rate Measurement (`0x2A37`) GATT profile. See
  `../../docs/ble-heart-rate.md`.
- **Activity History**: Displays workouts and GPS routes imported from Apple
  Health and connected providers.
- **Passive Motion Sync**: Core Motion and WatchMotion provide background motion
  synchronization from iPhone and Apple Watch sensors.
- **Mobile Dashboard**: Simplified mobile-first health and recovery tracking with SVG-based charts (`react-native-svg`).
- **Nutrition history**: Read-only nutrition history, totals, source resolution, and analytics.

## Offline startup

After a successful sign-in or online session restore, the app saves the verified
user alongside the session in [SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/).
Subsequent launches restore that local session before contacting the server, so
navigation and Bluetooth sample collection can start without internet access.
Session verification runs in the background and repeats on foregrounding or
reconnection through the existing [network lifecycle](lib/mobile-query-lifecycle.ts).
A rejected session clears local authentication; connection failures preserve it.
Sign-out and account deletion remove the saved identity.

First-time sign-in, and the first online restore after upgrading from a version
that saved only the token, need internet to establish the saved identity.
Bluetooth uploads retain unconfirmed samples during connection failures; see the
[WHOOP buffer contract](modules/whoop-ble/README.md) and
[heart-rate buffer implementation](modules/ble-heart-rate/ios/BleHeartRateSampleBuffer.swift).
These sample buffers remain in memory and do not survive process termination.

## Project Structure

Activity-list cards use the stored cycling modality to show training stats instead
of distance and elevation for indoor and virtual rides, including reported zeros.
The [metric strip](components/ActivityMetricStrip.tsx) and activity accessibility
labels use the [shared cycling classification](../training/src/endurance-types.ts).

The [activity detail screen](<app/activity/[id].tsx>) also hides distance for
indoor and virtual cycling. Cycling details display server-computed mechanical
Energy Output in kJ from the selected power source, including measured zero.
The [activity API](../server/src/routers/activity.ts) supplies work and power
coverage; the screen labels coverage below 99% as “Partial power data” and
keeps the previous output visible while the selected source refreshes.

The [Activities list](<app/(tabs)/activities.tsx>) uses
[ActivityMapTile](components/ActivityMapTile.tsx) to show a full-width 16:9 map
below each activity's details when location data is available, matching the
readable map panels on the [web Activities list](../web/src/components/ActivityCardContent.tsx).
Activities without a recorded GPS track can show climbing-source locations;
source points retain Climb/Area and provider attribution without creating a
route or implying distance/elevation measurements. The
[calendar repository](../server/src/repositories/activities-calendar-repository.ts)
projects map geometry on the server, and recorded GPS takes precedence.
The [GPS-route preview](../../docs/screenshots/mobile-activity-route.png) and
[climbing-location preview](../../docs/screenshots/mobile-activity-climbing.png)
show the [Activities stories](<app-stories/(tabs)/activities.stories.tsx>) at a
390-pixel browser viewport.

Activity details show downloaded photos in [ActivityImages](components/ActivityImages.tsx),
with tappable thumbnails, captions, source labels, and a full-screen
[native Modal](https://reactnative.dev/docs/modal). Cards without a map show the
first downloaded photo through [ActivityPhotoPreview](components/ActivityPhotoPreview.tsx);
recorded routes, climbing locations, and processing maps retain precedence.
The [shared query policy](../training/src/activity-images.ts) refreshes signed
image URLs while visible and discards inactive image queries. The
[mobile persistence boundary](lib/mobile-query-persistence.ts) excludes queries
marked `persist: false`, following TanStack's
[query dehydration filter](https://tanstack.com/query/latest/docs/framework/react/reference/hydration#dehydrate).
Cached photos remain visible during refresh errors, and photo load failures
offer a refresh action in the activity detail.

Activity and training maps reserve space and show “Processing map…” while server geometry,
preview images, or native map rendering are pending. Lists poll while any map's
geometry is processing. Preview images become ready only after every tile
reports a successful [Image `onLoad`](https://reactnative.dev/docs/image#onload);
native overview and compact maps show the processing panel until
[`onMapReady`](https://github.com/react-native-maps/react-native-maps/blob/master/docs/mapview.md#events),
then retain the native renderer's
[`loadingEnabled` indicator](https://github.com/react-native-maps/react-native-maps/blob/master/docs/mapview.md#props)
while its initial map rendering completes.
Existing previews remain visible during background refreshes, and map failures
retain their error state.

Activity details show climbing logs and same-day attachment suggestions for
climbing activities. Cards group under Area headings and show published
display grades, concise attempt counts, pitch labels, and server-derived rock labels
through the [shared grouping helper](../training/src/climbing-log-groups.ts) and
[card](components/ClimbingLogEntryCard.tsx). Provider records
use server columns and filters, fetch the selected log's complete graph, and
retain cached rows during refresh errors. Their
[detail viewer](components/ClimbingLogEntryDetails.tsx) shows source links,
published and reported grade collections, known attempt facts, and notes.
Coordinates, internal references, and raw provider payloads are omitted from this
viewer. Labels match web through [shared formatters](../format/src/climbing-log.ts).
See the
[canonical response contract](../server/src/contracts/climbing-log-contracts.ts).

Activity-detail climbing entries and suggestions use
[ClimbingLogEntryBreakdown](./components/ClimbingLogEntryBreakdown.tsx) and
[ClimbingLogEntryCard](./components/ClimbingLogEntryCard.tsx). Their source-location
inputs share the web client's [coordinate and provenance types](../training/src/climbing-map.ts).
Each Area occupies a block with one heading above its cards. Small blocks share
rows, while larger blocks wrap their cards internally. The breakdown uses
[`onLayout`](https://reactnative.dev/docs/view#onlayout) to keep card widths
consistent across blocks as the container resizes.
Area rows and card rows use flexible cells to preserve their columns at fractional
widths, covered by the [fractional-width regression stories](./components/ClimbingLogEntryBreakdown.stories.tsx).
[RouteMap](./components/RouteMap.tsx) renders source dots independently of the
recorded GPS route and supports compact tick maps. The overview supports panning
and zooming; compact maps do not intercept touches. A unique point opens its log
details immediately; coincident locations show a counted marker with source-location
labels. Selecting it lists every log by climb name,
including repeated names, without an entry-number heading. The
[shared marker grouping](../training/src/climbing-map.ts) preserves source coordinates
and log identities; the count renders inside a
[custom native marker](https://github.com/react-native-maps/react-native-maps/blob/master/docs/marker.md).
Selection opens the exact log's
[record modal](./components/providers/provider-record-detail-modal.tsx) and
highlights its card, including repeated names at the same point. The
[activity tests](./app-tests/activity/[id].test.tsx) cover closing and reopening
the same occurrence. Colocated Storybook stories
exercise exact Climb points, containing-Area points, missing GPS, and attachment
states. The activity screen supplies each log's server-projected location to
overview and compact maps even without a recorded GPS route. The
[server projection](../server/src/repositories/climbing-activity-log-entry-repository.ts)
uses a source Climb point or its nearest containing Area with coordinates;
labels identify the source and distinguish Area from Climb locations.
Unattached suggestions have their own compact source-location maps. The complete
log and attempt graph follows the [canonical response contract](../server/src/contracts/climbing-log-contracts.ts).

The [Training route](<app/(tabs)/strain.tsx>) requests
`mobileDashboard.trainingV2` using the combined climbing progression
[output contract](../server/src/contracts/mobile-dashboard-contracts.ts).
The [server router](../server/src/routers/mobile-dashboard.ts) retains the original
`mobileDashboard.training` lane-array response for older app versions. The route
coordinates query states and delegates climbing payload validation, grade cards,
and Hangboarding display to [ClimbingTrainingCard](./components/ClimbingTrainingCard.tsx),
with focused tests and stories beside the component.

Training also compares one repeated GPS route at a time through
[RouteComparisonCard](./components/RouteComparisonCard.tsx). The
[shared response contract](../training/src/route-comparison.ts) supplies pace,
attempt counts, and activity timestamps; the [SVG chart](./components/RouteComparisonChart.tsx)
shows faster pace higher and preserves same-day attempts as separate observations.
Its [accessible data disclosure](./components/AccessibleChart.tsx) lists exact
attempt values and opens each activity, following the
[WAI disclosure pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/).

The [climbing strengths profile](components/ClimbingStrengths.tsx) has its own
`climbing.strengths` query using the current training dates and climbing filters.
The [strengths chart](components/ClimbingStrengthsChart.tsx) offers Styles with the server-computed grade-adjusted radar and Progress with monthly send rates. Wall angle, Hold type, and observed source tag categories apply to all tabs, with no grade picker or format menu. The radar places the context-specific same-grade baseline at zero; results outside its dashed outline are stronger and those inside weaker. It needs three scored styles; smaller samples remain accessible through the exact-value disclosure. Progress combines grades and says that changes may reflect difficulty mix. The existing page-wide filters define one selected view. The [server aggregation](../server/src/services/climbing-strengths.ts) supplies one panel per breakdown dimension, retaining context-specific grade baselines. Selecting a chart point or exact-value row reveals source climbs, with zeros, unknown outcomes, missing observations and limited known-result samples distinct. Exact-value controls use [React Native accessibility roles and state](https://reactnative.dev/docs/accessibility) through [AccessibleChart](components/AccessibleChart.tsx).

Page-wide filters show a compact type/setting summary. Filters opens a [native modal](https://reactnative.dev/docs/modal) with independent checkbox groups for every filter; each All checkbox selects or clears its group and exposes partial selections with the [WAI mixed checkbox state](https://www.w3.org/WAI/ARIA/apg/patterns/checkbox/). Type includes Bouldering, Lead, Top rope, Follow, and Unroped, replacing the overlapping kind/method selectors. The broader Discipline selector is omitted. Attempt scope, Solo status, Protection used, and Route protection stay under More filters with the same checkbox style. The [shared server projection](../server/src/repositories/climbing-rock-observations.ts) matches any selected value within each group and intersects groups; Whole climb remains the default scope, with both scopes selectable explicitly.

Values and source-climb details use the [server-computed contract](../training/src/climbing-strengths.ts). The card offers the current training period or All time through the [Training route](<app/(tabs)/strain.tsx>), preserving its explicit end date and access restrictions in the [server query](../server/src/routers/climbing.ts).
Unknown angle units remain
unclassified, while known degrees retain their recorded numeric labels.
Source categories retain provider attribution and use the same server-computed
profiles as angle and hold breakdowns. Details show grouped recorded tags,
including unfamiliar labels, through the
[shared presentation helper](../training/src/climbing-tag-presentation.ts).
Catalogue tags stay inside their reference disclosure and do not affect
strengths, as defined by the [source coverage contract](../../docs/climbing-trait-coverage.md).
The [Training route](<app/(tabs)/strain.tsx>) includes its existing local date
anchor in the query key, validates restored responses with the shared schema,
and labels retained data while it refreshes. Successful attachment actions
invalidate strengths alongside the affected climbing detail queries; see the
[attachment picker](components/ClimbingLogAttachment.tsx).

The [grade progression chart](components/ClimbingGradeProgressionChart.tsx) shows
one grade stack per period across all types and settings selected by the page
filters. The [server projection](../server/src/repositories/climbing-grade-progression.ts)
pools the selected observations before computing sends per distinct climbing day,
so a day shared by types or settings counts once. The
[shared contract and labels](../training/src/climbing-progression.ts) keep display
grade scales distinct and qualify identical labels from different scales. The
[repository](../server/src/repositories/climbing-repository.ts) continues to apply
the user's saved grade preferences before pooling.

[ClimbingLocationMapCard](./components/ClimbingLocationMapCard.tsx) uses the same
Training dates and climbing filters to render [server-computed clusters](../training/src/climbing-location-map.ts).
Larger circles split into individual climb locations as the map zooms; repeated
logs at one coordinate stay selectable together, with their grade, date, source,
location scope, and activity link. Its native map preserves the viewport during
refreshes and uses the cross-platform region API to zoom into clusters; the
[native map camera documentation](https://github.com/react-native-maps/react-native-maps/blob/master/docs/mapview.md#types)
distinguishes MapKit altitude from Google Maps zoom values.

Unattached logs in the selected location list offer **Attach to activity**.
The [activity picker](components/ClimbingLogAttachment.tsx) shows eligible
climbing and hiking activity groups on the log's date, including their local
start time and source. Attachment keeps the original log date and refreshes
the affected climbing and activity queries. Loading, no same-day activity,
lookup errors, and attachment errors have separate states; cancellation does
not attach a log. The shared [server association gate](../server/src/repositories/climbing-log-entry-associator.ts)
enforces the same-day rule for both clients.

- `app/`: Expo Router screens (file-based routing). Keep this route-only; Expo documents `app` as route-exclusive and non-route files there can be treated as routes: <https://docs.expo.dev/router/basics/core-concepts/#6-non-navigation-components-live-outside-the-srcapp-directory>.
- `app-tests/`: Vitest tests for Expo Router screens.
- `app-stories/`: Storybook stories for Expo Router screens.
- `app-fixtures/`: Shared fixtures for route tests and route stories.
- `components/`: React Native UI components (SVG-based charts).
- `modules/`: Native Swift modules:
  - `background-refresh`: iOS background task registration.
  - `whoop-ble`: Specialized WHOOP IMU streaming.
  - `ble-heart-rate`: Standard Bluetooth heart-rate monitor (GATT Heart Rate Service).
  - `health-kit`: Apple Health integration.
  - `core-motion`: iOS motion data access.
- `lib/`: Shared logic, tRPC client, and background sync workers.
- `targets/`: Native watchOS extension (DofekWatch).

## Development

Native builds and OTA updates use Expo's automatic `fingerprint` runtime
policy, including the Watch sources configured in `fingerprint.config.js`.
New native interfaces receive a different runtime so older installations keep
their compatible JavaScript; see [Expo runtime compatibility](https://docs.expo.dev/eas-update/runtime-versions/).
Follow the [OTA release and recovery runbook](../../docs/mobile-ota-recovery.md)
to stage updates on already-built binaries and recover an affected runtime.

```bash
cd packages/mobile
pnpm start
```

### iOS Simulator development build

This app contains custom Swift modules, so generate the native Xcode project
and use a development client rather than relying on Expo Go. The `ios/`
directory is generated by Expo prebuild and ignored by Git, following Expo's
[Continuous Native Generation](https://docs.expo.dev/workflow/continuous-native-generation/)
workflow. Expo also documents the local iOS Simulator setup and the
development-build workflow:
<https://docs.expo.dev/workflow/ios-simulator/> and
<https://docs.expo.dev/build-reference/simulators/>.

From `packages/mobile`, load the required environment and check dependency
compatibility before regenerating the native project, following
[Expo's upgrade guide](https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/):

```bash
pnpm tsx ../../scripts/with-env.ts -- pnpm expo install --check
```

1. Load the required `EXPO_PUBLIC_*` build values from Infisical, then generate
   a fresh native project:

   ```bash
   pnpm tsx ../../scripts/with-env.ts -- pnpm prebuild
   ```

2. Boot a simulator and build the `Dofek` scheme from
   `ios/Dofek.xcworkspace` for `iphonesimulator` with Xcode or `xcodebuild`.
   `app.config.js` requires `EXPO_PUBLIC_SENTRY_DSN` while prebuild generates
   the native Sentry configuration.
3. Start Metro for the development client with the same environment:

   ```bash
   pnpm tsx ../../scripts/with-env.ts -- pnpm expo start --dev-client --localhost \
     --private-key-path /secure/path/to/private-key.pem
   ```

4. Install and launch the built `.app`, then verify that a real application
   screen renders before beginning UI exploration. A running process that is
   still showing the Expo development launcher is not an app-level validation.

The native binary embeds `certs/certificate.pem`, so Metro must sign the
development manifest with the corresponding private key. The private key is
intentionally ignored by Git and must come from approved secret storage; never
copy it into the repository or logs. Expo's code-signing guide explains why the
certificate is committed while the private key remains secret:
<https://docs.expo.dev/eas-update/code-signing/>.

The iOS Simulator cannot exercise Bluetooth, accelerometer, gyroscope, or other
device-only hardware. Use it for navigation, rendering, API/error states, and
software-only flows; use physical devices for BLE and motion validation. Expo
lists current simulator hardware limitations here:
<https://docs.expo.dev/workflow/ios-simulator/#limitations>.

### Signed Release simulator audit

Use an embedded Release bundle when the goal is to audit production-like app UI
without Metro. The command below uses local ad-hoc signing so keychain-backed
SecureStore remains available without a distribution identity:

```bash
EXPO_PUBLIC_SERVER_URL=http://127.0.0.1:3100 \
EXPO_PUBLIC_SENTRY_DSN=https://public-key@sentry.example/project-id \
  pnpm prebuild

EXPO_PUBLIC_SERVER_URL=http://127.0.0.1:3100 \
EXPO_PUBLIC_SENTRY_DSN=https://public-key@sentry.example/project-id \
SENTRY_DISABLE_AUTO_UPLOAD=true \
xcodebuild -quiet \
  -workspace ios/Dofek.xcworkspace \
  -scheme Dofek \
  -configuration Release \
  -destination 'platform=iOS Simulator,id=<SIMULATOR_UDID>' \
  -derivedDataPath .context/ReleaseAuditDerivedData \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY=- \
  DEVELOPMENT_TEAM= \
  PROVISIONING_PROFILE_SPECIFIER= \
  build
```

`pnpm prebuild` regenerates the ignored `ios/` directory from `app.json`, config
plugins, native modules, and targets. Do not treat generated Xcode files as
checked-in source or edit them as the durable fix for native configuration.

Do not add a global `-sdk iphonesimulator`: the generated `Dofek` scheme also
contains the watchOS app, and the destination is sufficient to select the iOS
Simulator for the main target. Do not use `CODE_SIGNING_ALLOWED=NO`, because an
unsigned audit artifact lacks the keychain entitlements SecureStore needs. Do
not override `INFOPLIST_FILE` globally; doing so drops the main target's declared
background modes.

Install and launch the resulting
`.context/ReleaseAuditDerivedData/Build/Products/Release-iphonesimulator/Dofek.app`,
then complete the SecureStore acceptance check below before inspecting any
other UI. A successful build or process launch is not an audit-ready result.
Expo's local production-build guide is the upstream reference for using
Release configuration locally:
<https://docs.expo.dev/guides/local-app-production/>.

#### Required SecureStore acceptance check

Use an isolated local API stack with password authentication enabled and a
simulator reserved for this audit. Start with a simulator whose contents have
been erased; deleting and reinstalling the app is not sufficient because
SecureStore uses the iOS keychain, whose values can persist across an app
uninstall for the same bundle identifier:
<https://docs.expo.dev/versions/latest/sdk/securestore/#data-persistence>.
Only erase a simulator after confirming that no other workspace uses its UDID.

Use XcodeBuildMCP for the simulator lifecycle and native accessibility
snapshots. The repository pins its setup in
[`docs/mcp.md`](../../docs/mcp.md#local-xcodebuildmcp). Before the first build,
run, or test action, inspect and set the session defaults to the generated
workspace, `Dofek` scheme, `Release` configuration, reserved simulator UDID,
`com.dofek.app` bundle identifier, and `.context/ReleaseAuditDerivedData`.
Then:

1. Install the exact `Dofek.app` produced by the command above and launch it
   with XcodeBuildMCP. Retain the launch log path returned by the tool.
2. Capture a native accessibility snapshot showing the signed Release app's
   login screen.
3. Through the production password UI, create a fresh, uniquely named audit
   account. Do not inject a session token or seed client storage. Account
   creation calls the production session-save path that writes the returned
   token to SecureStore.
4. Wait for the UI to settle, then capture a native accessibility snapshot of
   the authenticated onboarding screen.
5. Hard-stop `com.dofek.app` with XcodeBuildMCP. This must terminate the app
   process, not merely background it, so the in-memory token cache cannot
   satisfy the next launch.
6. Launch the same installed artifact again, wait for the UI to settle, and
   capture a new native accessibility snapshot. It must show an authenticated
   screen such as onboarding or the `Today` tab, not the login screen.
7. Inspect both XcodeBuildMCP launch logs and the isolated server logs. There
   must be no SecureStore, keychain, missing-entitlement, or session-bootstrap
   error.

The post-termination authenticated screen is the required read proof:
`AuthProvider` restores the session token and saved user through SecureStore,
then verifies the session with the server in the background. Repeat the
hard-stop and relaunch with internet unavailable to verify that local session
restoration still reaches the app. Check the server logs separately for the
online verification request. Static signature
inspection can support the evidence:

```bash
APP=.context/ReleaseAuditDerivedData/Build/Products/Release-iphonesimulator/Dofek.app
SIMULATED_ENTITLEMENTS=.context/ReleaseAuditDerivedData/Build/Intermediates.noindex/Dofek.build/Release-iphonesimulator/Dofek.build/Dofek.app-Simulated.xcent

codesign --verify --deep --strict --verbose=2 "$APP"
plutil -extract application-identifier raw "$SIMULATED_ENTITLEMENTS"
otool -l "$APP/Dofek" | grep -A3 'sectname __entitlements'
```

For this ad-hoc Simulator destination, Xcode reports
`ENTITLEMENTS_DESTINATION=__entitlements` and embeds the generated simulated
entitlements in the Mach-O `__TEXT,__entitlements` section. Consequently,
`codesign -d --entitlements :- "$APP"` can display an empty dictionary even
when the installed Simulator executable contains the application identifier;
do not use that output alone to diagnose a missing entitlement. Apple's Mach-O
overview documents the segment and section structure:
<https://developer.apple.com/library/archive/documentation/Performance/Conceptual/CodeFootprint/Articles/MachOOverview.html>.
Apple also documents that an app identifier supplies the default keychain
access group:
<https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps>.

Static inspection cannot replace the write, hard-stop, relaunch, and read
sequence. Treat the artifact as **not audit-ready** if registration reports a
keychain error, the relaunched app returns to login, either native snapshot is
missing, or the logs contain a SecureStore/keychain failure. Record the
simulator UDID, artifact path, simulated-entitlement output, both authenticated
snapshot results, and app/server log paths with the audit evidence.

### Physical-device release gate

The signed Simulator audit validates production-like UI and software-only
flows, but it does not exercise Dofek's physical-device acceptance scenarios.
Apple explicitly requires a device for
[HealthKit observer background delivery](https://developer.apple.com/documentation/healthkit/executing-observer-queries)
and a physical iPhone and Watch for its
[Watch Connectivity transfer sample](https://developer.apple.com/documentation/watchconnectivity/transferring-data-with-watch-connectivity);
the remaining matrix exercises the real hardware boundaries documented by
[Core Bluetooth](https://developer.apple.com/documentation/corebluetooth),
[Core Motion](https://developer.apple.com/documentation/coremotion), and
[AVFoundation camera authorization](https://developer.apple.com/documentation/avfoundation/requesting-authorization-to-capture-and-save-media).
Before App Store submission or production approval, run the
[iOS physical-device release audit](../../docs/ios-physical-device-release-audit.md)
against the exact TestFlight build using the dedicated synthetic-only account
and hardware described there.

## Dependency pins

The workspace retains exact-version [release-age exclusions](https://pnpm.io/settings/dependency-resolution#minimumreleaseageexclude)
for the approved SDK dependency tree.

- `@react-native-async-storage/async-storage@2.2.0` — Expo SDK 58 pins this
  version in its [native dependency matrix](https://api.expo.dev/v2/sdks/58.0.0/native-modules).
  AsyncStorage 3.x breaks iOS builds on recent Expo SDKs; see
  [expo/expo#43757](https://github.com/expo/expo/issues/43757).
- `react-native-maps@1.29.11` — the [stable release](https://github.com/react-native-maps/react-native-maps/releases/tag/v1.29.11)
  uses Fabric with React Native 0.81.1 or newer, matching this app's React Native
  0.88 dependency ([upstream compatibility table](https://github.com/react-native-maps/react-native-maps/blob/v1.29.11/README.md#compatibility)).
  Expo 58.0.14 recommends this version in its
  [native dependency matrix](https://github.com/expo/expo/blob/expo%4058.0.14/packages/expo/bundledNativeModules.json).
  The tested native pin remains listed in Expo's documented
  [`expo.install.exclude`](https://docs.expo.dev/more/expo-cli/#configuring-dependency-validation)
  setting. The existing Expo check validates the remaining SDK-managed
  packages. Maps upgrades require a fresh native binary, its fingerprint-derived
  runtime, and the signed simulator audit: route, Start/Finish pins, elevation
  hover/release, navigation/remount, and session restoration after restart
  ([native runtime compatibility](https://docs.expo.dev/eas-update/runtime-versions/)).

## Testing

- **Component tests**: `pnpm test:mobile` from the repo root (Vitest mobile project)
- **Native modules**: Swift tests in `modules/<name>/Tests/` (XCTest)
- **Apple diagnostic privacy**: `pnpm tsx scripts/test-apple-auth-diagnostics.ts`
  from the repository root compiles the installed production Swift helper with
  a Foundation fixture and executes classification, redaction, underlying-error,
  and non-retention checks. The existing iOS Native Build job runs this before
  prebuild and the Release archive; see the [runner](../../scripts/test-apple-auth-diagnostics.ts)
  and [workflow](../../.github/workflows/build-mobile.yml).

### Native runtime compatibility

Runtime **1.13** adds WHOOP capture timestamps, buffer counters and retained
diagnostic checkpoints to the native bridge. It includes runtime 1.12's reported
WHOOP BPM and fractional timestamp fixes; see the
[WHOOP module contract](modules/whoop-ble/README.md).
Existing runtime 1.13 and earlier binaries retain their compatible updates.
Current releases use Expo's automatic fingerprint policy; native changes
require a new binary with the resulting runtime, following Expo's
[runtime compatibility guidance](https://docs.expo.dev/eas-update/runtime-versions/).

The current stable [Expo SDK 58](https://expo.dev/changelog/sdk-58)
native dependency set uses Expo 58.0.20, Expo Router 58.0.27, Expo Updates
58.0.18, React Native 0.88.0, and React Native SVG 15.16.0, pinned in
[package.json](./package.json). The
[Expo dependency matrix](https://github.com/expo/expo/blob/expo%4058.0.20/packages/expo/bundledNativeModules.json)
and the [lockfile](../../pnpm-lock.yaml) define the corresponding SDK-managed
versions, including the updated native Modules Core and JSI packages.
Validate SDK-managed versions with
`pnpm tsx ../../scripts/with-env.ts -- pnpm expo install --check` from this package, following Expo's
[dependency validation guidance](https://docs.expo.dev/more/expo-cli/#configuring-dependency-validation).
The native dependency set also includes ExpoNetwork, the pnpm patch to
`expo-apple-authentication@58.0.2`, and `react-native-maps@1.29.11`.

Runtime 1.12 retains the HealthKit authorization-not-determined classification
introduced in 1.10, with the stable code consumed by anchored sync. A type awaiting authorization leaves
its anchor unchanged and does not stop other observed types from syncing;
unexpected query errors still fail. Apple documents this state as
[`errorAuthorizationNotDetermined`](https://developer.apple.com/documentation/healthkit/hkerror/code/errorauthorizationnotdetermined).
Native patch releases can change executable code and ABI contracts; the
[Modules Core ABI change](https://github.com/expo/expo/pull/51823) is one
example. Fingerprinting derives a new runtime for the changed native inputs;
build and release that binary before testing updates against its interface.
Follow the [release and recovery runbook](../../docs/mobile-ota-recovery.md).
Use [pnpm patch/patch-commit](https://pnpm.io/cli/patch-commit) when updating the
patch, then rerun the native regression and existing Release archive job.

The SVG 15.16.0 dependency patch separates its Android tap-sound binding from
the web module graph. It preserves the native press behavior introduced by
[upstream PR 3016](https://github.com/software-mansion/react-native-svg/pull/3016)
and uses React Native's documented
[generic/web and `.native` module resolution](https://reactnative.dev/docs/platform-specific-code#native-specific-extensions-ie-sharing-code-with-nodejs-and-web).
After changing SVG or its patch, run `pnpm check:svg-platform` from this package,
verify mobile Storybook development and static export, and run the native
Release archive. The check exercises strict web bundling and native press
behavior; it does not replace a native build or device validation.

Sentry React Native 8.29.0 and the separate watch Swift package use Cocoa 9.30.0.
The [binary podspec](./plugins/Sentry.podspec.json) pins its release URL and
SHA256 from Sentry's [Swift package manifest](https://github.com/getsentry/sentry-cocoa/blob/9.30.0/Package.swift).
The RNSentry package patch declares this CocoaPod dependency, and Expo's
[extraPods configuration](https://docs.expo.dev/versions/latest/sdk/build-properties/#extraiospoddependency)
registers the podspec. CocoaPods selects the platform slice and exports the
[vendored framework](https://guides.cocoapods.org/syntax/podspec.html#vendored_frameworks)
to the local Swift modules consuming RNSentry. The patch uses a single
CocoaPods framework link with inherited `-ObjC` retention for Objective-C
categories ([Apple QA1490](https://developer.apple.com/library/archive/qa/qa1490/_index.html))
and Swift metadata ([Swift compiler guidance](https://forums.swift.org/t/linker-flag-objc-force-loads-swift-libraries/47466/3)).
When upgrading Sentry, update the React Native package patch and binary
podspec together, then verify all native consumers and the Release archive.

The [Apple patch](../../patches/expo-apple-authentication@58.0.2.patch) preserves
Expo's authorization exception mapping and cancellation. Other authorization
errors carry only an allowlisted NSError domain, numeric code, and optional
immediate underlying domain/code. Unknown domains become `other`; native
descriptions and userInfo are discarded. Expo's
[exception cause formatting](https://github.com/expo/expo/blob/main/packages/expo-modules-core/ios/Core/Exceptions/Exception.swift)
and [JavaScript error bridge](https://github.com/expo/expo/blob/main/packages/expo-modules-jsi/apple/Sources/ExpoModulesJSI/Runtime/Values/JavaScriptError.swift)
transport the safe marker in the error message. The login boundary parses it
into safe telemetry and presents a readable sign-in error, while preserving
server error messages and silent user cancellation. See the
[JavaScript diagnostic boundary](./lib/apple-auth-diagnostics.ts) and
[Expo Apple authentication behavior](https://docs.expo.dev/versions/latest/sdk/apple-authentication/).
These diagnostics do not establish the cause of historical Apple failures;
device sign-in validation remains separate from helper tests and archive validation.

Query persistence records allowlisted failure categories/codes and aggregate
attempted-write counts and UTF-8 byte measurements per persister lifetime.
Persistence-specific attributes contain no cache keys, user IDs, health values,
tokens, or original native messages. The shared telemetry context separately
adds authenticated identity and runtime versions as described below. The pinned
AsyncStorage conversion drops NSError codes, so
known fixed storage messages also map to safe categories; other failures stay
`unknown`. Read/remove and deserialization rejections retain their original
identity, and write failures are captured through TanStack's retry callback
without adding retries. The provider's error callback also reports failures
after parsing, including hydration, with a generic safe classification because
the callback supplies no error argument. A lower-boundary failure can produce
both its detailed safe report and this generic fallback. See
[TanStack persistence restoration](https://tanstack.com/query/latest/docs/framework/react/plugins/persistQueryClient#persistqueryclientprovider),
the [persistence boundary](./lib/mobile-query-persistence.ts),
[AsyncStorage conversion](https://github.com/react-native-async-storage/async-storage/blob/v2.2.0/packages/default-storage/src/helpers.ts),
and [TanStack async persister](https://tanstack.com/query/latest/docs/framework/react/plugins/createAsyncStoragePersister).
The 5 MiB cap measures `TextEncoder` UTF-8 output, matching the
[Encoding Standard](https://encoding.spec.whatwg.org/#interface-textencoder).

## Mobile Telemetry

The [shared telemetry boundary](./lib/telemetry.ts) adds canonical `userId` while
authenticated, plus `appVersion`, native `appBuild`, `assetsVersion`,
`runtimeVersion`, and a JavaScript-lifetime `runtimeId` to emitted logs and
errors. Caller attributes cannot replace that identity or version context.
The [authentication state](./lib/auth-context.tsx) sets or clears it when the
user changes; Sentry identity and PostHog identity follow the same boundary.
These identifiers support correlation across logs and requests, following
[OpenTelemetry's context model](https://opentelemetry.io/docs/concepts/context-propagation/).
Pending HTTP diagnostics retain a session guard and cannot attach an old request
to a replacement account. Unexpected failures from retired WHOOP work use
`retiredLifetime=true` and remain visible without an account or replacement route
in Sentry and OTLP; they do not create a PostHog exception bound to the new user.
Sentry breadcrumbs omit account IDs, and PostHog resets restore the shared
runtime properties. These boundaries are covered by the
[telemetry regressions](./lib/telemetry.test.ts) and
[transport regressions](./lib/trpc-fetch.test.ts).

WHOOP diagnostics connect native capture/buffer snapshots, per-stream workers,
upload batches, HTTP responses, and server broker publication without logging
sensor values. A retained native checkpoint contains metadata only, has unknown
prior-account provenance, and cannot restore samples. See the
[WHOOP diagnostic procedure](../../docs/whoop-ble-protocol.md#diagnosing-capture-upload-and-visibility)
for fields, filters, raw/serving checks, and interpretation limits.

`lib/telemetry.ts` always reports exceptions to Sentry via `EXPO_PUBLIC_SENTRY_DSN`.
Exceptions also include the current Expo Router pathname in Sentry, PostHog, and
OTLP context. UUID and numeric path segments are normalized to `:id`, so route
context identifies the screen without copying record identifiers into telemetry.
Production PostHog error autocapture is limited to uncaught exceptions and
unhandled rejections; handled application failures go through the shared
`captureException` path so they retain the same route and source context.

Release startup tracing samples the `Mobile Startup` lifecycle and Sentry's
native `App Start` span. The lifecycle attributes time to the Expo
Updates launch, JavaScript bootstrap, authentication restore, splash dismissal,
and deferred native-service bootstrap. It also emits the same phase durations
as structured `app-startup` logs for local Release audits and OTLP correlation.
Call `Sentry.appLoaded()` only after the splash is dismissed so the native app
start measurement ends at the first interactive screen, as described by
[Sentry's React Native custom instrumentation guidance](https://docs.sentry.io/platforms/react-native/tracing/instrumentation/custom-instrumentation/).
The native OTA duration comes from
[`Updates.launchDuration`](https://docs.expo.dev/versions/latest/sdk/updates/#updateslaunchduration).

The 2026-07-29 signed Release audit kept the production `ON_LOAD` and 5,000 ms
fallback policy. Three force-stop launches reached the interactive login screen
in 713, 968, and 660 ms; a clean reinstall took 864 ms. OTA launch was the
largest phase at 632–942 ms, while JavaScript, authentication, and splash
dismissal were each at most 11 ms. Because no controlled launch approached the
configured fallback, that audit made no launch-policy change. See the
[incident baseline](../../docs/production-incident-baseline.md#2026-07-29-ios-cold-start-delay-could-not-be-reproduced-with-phase-telemetry)
for that historical evidence.

A follow-up signed Release audit on 2026-08-02 reproduced the delayed path on a
dedicated iOS 26.5 Simulator: three force-stop launches took 7.13, 7.12, and
6.98 seconds to reach JavaScript. The instrumented third launch attributed
5,015.36 ms to Expo OTA launch, versus 9 ms for JavaScript bootstrap, 6 ms for
authentication restore, 4 ms for splash dismissal, and 0 ms for deferred
services. Native/Sentry breadcrumbs showed a successful `/manifest` response
followed by 43 assets, including a 9,429,201-byte Hermes bundle, while the
generated `Expo.plist` still set `EXUpdatesLaunchWaitMs` to 5,000 ms.

The production policy now keeps signed OTA checks and `ON_LOAD`, but sets
`updates.fallbackToCacheTimeout` to `0`. Expo defines this value as the launch
wait before falling back to the cached update and documents that an update
downloaded after the wait is applied on the next launch:
[Expo Updates configuration](https://docs.expo.dev/versions/latest/sdk/updates/).
This keeps network update delivery off the current launch's critical path while
preserving code-signature verification. See the
[follow-up incident baseline](../../docs/production-incident-baseline.md#2026-08-02-ios-cold-start-blocked-by-expo-ota-launch-wait)
for the evidence and validation.

To export mobile OpenTelemetry logs to Axiom, set this public env var in Infisical (`prod`):

- `EXPO_PUBLIC_OTEL_ENDPOINT` (for example, `https://api.axiom.co/v1/logs`)

If the collector requires headers, set `EXPO_PUBLIC_OTEL_HEADERS` (for example, `Authorization=Bearer <token>,x-axiom-dataset=<dataset>`). Expo embeds `EXPO_PUBLIC_*` values in the client bundle, so only use write-only ingest credentials here (https://docs.expo.dev/guides/environment-variables/#reading-environment-variables-from-env-files).

Mobile workflows load secrets from Infisical via GitHub OIDC ([`load-infisical-secrets`](../../.github/actions/load-infisical-secrets/action.yml)). Runtime env vars loaded into the app bundle:

- `EXPO_PUBLIC_SENTRY_DSN`
- `EXPO_PUBLIC_SENTRY_RELEASE` (native release metadata, set by the iOS archive workflow)
- `EXPO_PUBLIC_SENTRY_DIST` (native distribution metadata, set by the iOS archive workflow)
- `EXPO_PUBLIC_OTEL_ENDPOINT`
- `EXPO_PUBLIC_OTEL_HEADERS` (optional)

Workflow-only secrets loaded by iOS and OTA workflows ([iOS](../../.github/workflows/deploy-ios.yml), [OTA](../../.github/workflows/deploy-ota.yml)):

- `SENTRY_AUTH_TOKEN` (iOS and OTA sourcemap uploads)
- `EXPO_TOKEN` (OTA workflows)
- `EXPO_APP_ID` (PR channel setup links previews to the existing Expo project;
  [preview workflow](../../.github/workflows/mobile-preview-ota.yml))

The shared Infisical action fails when a requested secret is missing, so keep this list aligned with each workflow's `keys` block ([source](../../.github/actions/load-infisical-secrets/action.yml)).

Use a dedicated write-only ingest token for mobile OTEL headers if the collector needs authentication. Do not reuse broad admin/read tokens.

Workflow key requirements:

- `.github/workflows/build-mobile.yml`: `EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_OTEL_ENDPOINT`, `EXPO_PUBLIC_OTEL_HEADERS`
- `.github/workflows/deploy-ios.yml`: `SENTRY_AUTH_TOKEN`, `EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_OTEL_ENDPOINT`, `EXPO_PUBLIC_OTEL_HEADERS`
- `.github/workflows/deploy-ota.yml`: `EXPO_TOKEN`, `SENTRY_AUTH_TOKEN`, `EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_OTEL_ENDPOINT`, `EXPO_PUBLIC_OTEL_HEADERS`
- `.github/workflows/mobile-preview-ota.yml`: `EXPO_APP_ID`, `EXPO_TOKEN`, `EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_OTEL_ENDPOINT`, `EXPO_PUBLIC_OTEL_HEADERS`

Source-map and release correlation:

- The signed iOS archive sets both the Sentry upload variables and the
  `EXPO_PUBLIC_*` runtime variables from the same deployed commit and generated
  build number. The Sentry Expo integration uploads the map from that exact
  native archive during the Xcode build; EAS Build likewise uploads source maps
  automatically ([Expo's Sentry guide](https://docs.expo.dev/guides/using-sentry/)).
- The production OTA workflow pins EOAS 2.3.22 and passes its `--dumpSourcemap`
  option, passes the same commit release into the published JavaScript runtime,
  and makes the export emit the Hermes source maps; that final `dist` directory
  is uploaded with
  `sentry-expo-upload-sourcemaps`. See [EOAS's publishing implementation](https://github.com/axelmarciano/expo-open-ota/tree/main/eoas), [Expo OTA Sentry guidance](https://docs.expo.dev/guides/using-sentry/), and [Expo Hermes source maps](https://docs.expo.dev/guides/using-hermes/).
- Keep native archive uploads and OTA uploads separate: an OTA map must be
  uploaded from the export that produced the published update, while native
  symbols belong to the archive build.

The activities screen leads with the shared rounded-outline activity icon.
The [source disclosure](components/ActivitySourceDisclosure.tsx) sits after the
activity content and map, inside the same card. Its source row expands into
propagation branches and doubles as the primary root, avoiding a repeated source
name. Separate copies from the same provider retain their own branches;
unconnected records retain separate roots. Dofek remains implicit.
See the [Activities screen](<app/(tabs)/activities.tsx>).

The [activity detail header](components/activity/ActivityDetailHeader.tsx) uses
the same disclosure inside the existing header, retaining its activity identity
and removal notice. Its single [Sources disclosure](components/ActivitySourceDisclosure.tsx)
groups provider ancestry and reported device/sensor facts, following the
[WAI disclosure pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/).
Expanding Sources reveals recording-device facts at the device root and reported
equipment as children of the reporting provider. Unmatched records retain their
own provider branch through the [shared projection](../providers-meta/src/activity-source-hardware.ts).
Hardware refresh
errors keep their retry action visible while collapsed, and cached facts remain
available. Sources remains reachable for hardware, loading, and error states
even without source-tree records; an empty tree with no metadata or query state
omits the source row. The [detail route](<app/activity/[id].tsx>) keeps the other
detail content. Removed source records remain visible without actionable URLs,
and unresolved trees with records remain expandable.

Both clients render the [shared source-tree contract](../providers-meta/src/activity-source-tree.ts)
from the [server projection](../server/src/models/activity-source-tree.ts).
Only retained origin evidence connects source records; metric priorities do not
establish ancestry. Recording-app/device metadata can identify an earlier source
without claiming its record is available.

The [activity response decoder](types/api.ts) normalizes omitted primary-type
metadata to `null`, using a [Zod default](https://zod.dev/api#defaults) while
retaining a required nullable field in parsed records. Older responses during
rolling deployments can therefore use the representative activity type for an
unnamed activity. Supplied primary titles and types keep precedence in the
[activity card](components/ActivityCard.tsx); unrelated required response fields
remain validated.

The [persisted query contract](lib/mobile-query-persistence.ts) invalidates older
calendar and detail responses without source trees before restoring activity data, covered
by the [upgrade regression](lib/mobile-query-persistence.test.tsx).

The inline source button has its own 44-point touch target, independent of the
card's navigation or selection action. Its expanded accessibility state follows
the [WAI disclosure pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/),
using React Native's [Pressable](https://reactnative.dev/docs/pressable) and
[accessibility state](https://reactnative.dev/docs/accessibility#accessibilitystate).

## Activity metric sources

Activity views offer independent [source controls](components/activity/ActivityMetricSourcePicker.tsx)
for heart rate, power, speed, cadence, and elevation. Provider logos, short device
names where needed, and attribution icons keep the controls and chooser concise.
Unknown sources retain identifying text; accessible names retain the complete
source wording using React Native's [accessibility labels](https://reactnative.dev/docs/accessibility#accessibilitylabel).
Each control preselects its existing priority winner
without an Auto option. Choices distinguish providers and devices and apply
only to the current view; saved priorities are unchanged. Heart-rate and power
zones follow their respective selected sources.

The [shared source presentation](../providers-meta/src/activity-metric-source.ts)
supplies the compact name and attribution without client-side label parsing.
The [cache hydration regression](lib/mobile-query-persistence.test.tsx) covers
discarding persisted source lists from the preceding response contract.

`activity.metricSources` lists available sources in the owned activity window,
including standalone recordings and canonical member activities. `activity.stream`
accepts a `sources` map; zone endpoints accept their metric's source ID.
The [source repository](../server/src/repositories/activity-metric-sources-repository.ts) retains zero power, speed, and cadence samples
and negative elevations, excludes invalid heart-rate samples, and preserves
activity ownership and stream downsampling.

The [metric and elevation charts](components/activity/ActivityDetailCharts.tsx)
position observations by elapsed time and evaluate continuity independently for
each metric. Sparse observations retain markers; dense recordings show lines
with markers on touch. Scrubbing selects the nearest measured observation by
time and retains its original timeline index for the map.
The [shared presentation policy](../training/src/activity-chart-series.ts) defines
the cadence-based gap rule used by both clients. This follows the distinction
between [differing reporting intervals and missing observations](https://www.datawrapper.de/academy/patchy-data).
The `IndependentMetricTimelines` and `SparseReadings` stories show both cases.
