# @dofek/whoop-ble

Unofficial Expo iOS client for the reverse-engineered WHOOP strap Bluetooth Low
Energy protocol.

The package discovers bonded WHOOP straps, parses proprietary framed packets,
captures reported heart rate, real-time R-R intervals and inertial samples, and exposes connection
and orientation events through Expo Modules.

Additional background sensor records use the same durable native upload system.
Complete packets retain their capture identity, reception time and observed
device information. The server decodes capture-backed R18 temperature and retains
unverified optical layouts as raw records, following the
[protocol evidence boundaries](../../../../docs/whoop-ble-protocol.md#background-thermal-and-optical-records).
The WHOOP BLE provider detail screen shows uploaded temperature and raw records
on both clients. This does not start ECG capture or change persistent strap
configuration.

## Install

```sh
npx expo install @dofek/whoop-ble expo-modules-core
```

This package currently supports iOS 16.4 or later. It is not affiliated with,
endorsed by, or supported by WHOOP. The protocol is undocumented and may change
without notice.

Library development uses the same `expo-modules-core` version as the Dofek app.
Consumers supply the compatible runtime through their Expo SDK, following
Expo's [native library dependency guidance](https://docs.expo.dev/modules/existing-library/).

Protocol details and provenance are documented in
[`docs/whoop-ble-protocol.md`](../../../../docs/whoop-ble-protocol.md).
Native Swift applications can use the separately tagged
[WhoopBLE Swift package](https://github.com/Asherlc/whoop-ble-swift).

Buffered realtime samples expose `heartRateBpm` independently of `rrIntervalMs`.
WHOOP can report BPM when beat intervals are unavailable during movement; see
its [research FAQ, page 4](https://sensorlab.arizona.edu/sites/default/files/2023-05/WHOOP%20Unite%20Research%20FAQs_0.pdf#page=4).
Captured R18/R21 fractional clock words use 1/32768-second ticks, and buffer
timestamps use that scale; see the [capture-backed protocol reference](../../../../docs/whoop-ble-protocol.md).
The [serializer](ios/WhoopBleSampleSerializer.swift) preserves device time,
including early and future values. The [server filter](../../../server/src/routers/sample-validation.ts)
rejects future samples individually; an acknowledged batch removes those rows
from the queue too. Reported times determine sample identities.
Native changes require a new iOS build, following Expo's
[native development workflow](https://docs.expo.dev/workflow/customizing/).

This native module requires a development build; it does not run in Expo Go.
The consuming iOS app must provide `NSBluetoothAlwaysUsageDescription`.
Background capture additionally requires the `bluetooth-central` background
mode. See Expo's
[local app development guide](https://docs.expo.dev/guides/local-app-development/)
and Apple's
[`NSBluetoothAlwaysUsageDescription` documentation](https://developer.apple.com/documentation/bundleresources/information-property-list/nsbluetoothalwaysusagedescription).

## Usage

```ts
import {
  connect,
  findWhoop,
  configureUpload,
  flushUploads,
  startRealtimeHr,
} from "@dofek/whoop-ble";

// Supply the authenticated account and its current session from your app.
configureUpload({ userId, serverURL, token: sessionToken, headers: {} });
const device = await findWhoop();
if (device) {
  await connect(device.id);
  await startRealtimeHr();
  flushUploads();
}
```

The root module also exports connection-state diagnostics, IMU and optical
stream controls, orientation events, and reconnect support. The native
[transactional queue](ios/WhoopBleSampleStore.swift) is the canonical sample
store. The [uploader](ios/WhoopBleBackgroundUploader.swift) removes reserved
rows only after a valid server acknowledgment; failures retain the rows.
SQLite provides [atomic commits](https://sqlite.org/isolation.html).

Automatic reconnection keeps the Core Bluetooth connection request pending
while the strap is unavailable. Service discovery and notification subscription
have a ten-second deadline after Bluetooth connects; explicit `connect()` calls
retain a bounded wait. Foreground discovery and retry preserve an existing
pending connection. This follows Apple's
[pending connection behavior](https://developer.apple.com/documentation/corebluetooth/cbcentralmanager/connect(_:options:));
the [native handshake lifecycle](ios/WhoopBleConnectionManager+Handshake.swift) owns the
application deadlines and cancellation. A pending request alone does not prove
capture has resumed: check new data notifications and parsed sample timestamps.

Requested IMU capture survives unsuccessful automatic reconnect attempts and
resumes after notification readiness. Explicit Stop and Disconnect cancel
pending capture restoration, including when the strap is disconnected. The
[connection manager](ios/WhoopBleConnectionManager.swift) owns that intent;
the [disconnect transition](ios/WhoopBleConnectionManager+CoreBluetooth.swift)
preserves it only for automatic recovery, and the
[Expo stop handler](ios/WhoopBleModule.swift) applies cancellation even without
a command characteristic.

`getDataPathStats()` also exposes `lastKnownDeviceId`, capture timestamps, and a typed `buffers`
snapshot containing `bufferInstanceId`, `bufferCreatedAt`, `checkpointAt`,
`imu`, `realtime`, `sensorRecords`, `activeUploadCount`, `blockedUploadStreams`, and
`lastUploadError`. Stream counters describe persisted queue changes. The buffer
identity is the persisted account/server generation; it survives ordinary process
recreation. Creation/checkpoint times describe the current native uploader and
snapshot. Capture timestamps distinguish phone-observed notifications from the
strap's latest valid reported heart rate; see the [bridge contract](index.ts).

Captured samples are committed to [SQLite](ios/WhoopBleSampleStore.swift) before
scheduling delivery. Rows survive app recreation and are not evicted at the old
memory limits. Account changes and sign-out purge the old queue and cancel its
tasks; account erasure also retains its monotonic device cutoff. Queue files and
transport bodies are excluded from backups and use locked-device-accessible
[iOS file protection](https://developer.apple.com/documentation/foundation/fileprotectiontype/completeuntilfirstuserauthentication).

The [native uploader](ios/WhoopBleBackgroundUploader.swift) uses independent
500-sample batches for IMU and realtime streams. Sensor-record batches contain
at most 16 records and 262,144 encoded bytes, following the
[queue reservation limits](ios/WhoopBleSampleStore.swift).
Each stream uses its existing authenticated ingestion route.
Actual BLE arrivals coalesce scheduling checks to five seconds, and partial
batches become eligible after 30 seconds or a lifecycle flush. Submitted requests
use Apple's [background URLSession service](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background),
which requires file-backed uploads and controls actual delivery timing. Tokens
remain in application memory; iOS owns submitted request headers. After a restart,
native callbacks acknowledge existing batches without React; authenticated app
configuration supplies credentials for new work. Canonical mutation endpoints
must serve directly: Apple's background service follows redirects, and a
cross-origin final response is rejected as an acknowledgment.

`getDataPathStats().connectionDiagnostics` exposes the latest 64 native
connection events and a cumulative `overflowCount` for older events removed
from that bounded history. The [native connection journal](ios/WhoopBleConnectionDiagnostics.swift)
retains metadata in UserDefaults before JavaScript reporting: stable event IDs,
native occurrence times, native session and process identity, connection and
central-manager states, reconnect intent, and Bluetooth error domain/code/description.
It also records restoration and application handshake failures, distinguishing
those failures from an upstream Bluetooth disconnect. The history contains no
sensor samples, reads do not consume events, and account erasure clears it.
The [app diagnostics reporter](../../lib/whoop-ble-diagnostics.ts) sends each
unseen event through the existing logger when JavaScript takes a snapshot;
replays after restart retain the same event IDs and mark account provenance
unknown. This is diagnostic evidence, not proof of uninterrupted capture.

Changes to the native bridge require a new native build, as described in
[Expo's native development workflow](https://docs.expo.dev/workflow/customizing/).
The app uses the fingerprint runtime policy in [app.json](../../app.json),
following [Expo runtime compatibility guidance](https://docs.expo.dev/eas-update/runtime-versions/).
The
[diagnostic procedure](../../../../docs/whoop-ble-protocol.md#diagnosing-capture-upload-and-visibility)
describes correlation with upload and server events.

### Automatic recovery and queue diagnostics

Automatic collection retains reconnect intent after transient setup timeouts,
discovery errors, and notification subscription errors. It waits for the
cancelled peripheral's disconnect callback before reconnecting, following
[CoreBluetooth's cancellation contract](https://developer.apple.com/documentation/corebluetooth/cbcentralmanager/cancelperipheralconnection(_:)).
Explicit connection requests still reject with their typed error; explicit
Disconnect and structurally incompatible services remain terminal. Stop prevents
IMU restoration during recovery.

Queue counts use the sample store's existing transactional lifecycle counters.
Oldest and newest sample times use separate lookups through the stream/time
covering index, following SQLite's [covering-index](https://sqlite.org/queryplanner.html#covering_indexes)
and [MIN/MAX optimizations](https://sqlite.org/optoverview.html#the_min_max_optimization).
The index is created on the first open after a native upgrade. On the copied
October 30 incident queue (3,427,798 IMU rows and 39,411 realtime rows), that
open took 5.85 seconds on the investigation Mac; subsequent diagnostics plus
unlimited count took 0.04–0.38 ms. These measurements are not device latency
guarantees; see the [incident evidence](../../../../docs/production-incident-baseline.md#2026-10-30--whoop-recovery-and-queue-diagnostics-corrections).
Both corrections require a new native iOS build.

Upload acknowledgments find their reserved sample rows through a partial index
on non-null batch identities, rather than scanning the entire queued backlog.
Unreserved rows are excluded from this index, following SQLite's
[partial-index rules](https://www.sqlite.org/partialindex.html#queries_using_partial_indexes).
The [store](ios/WhoopBleSampleStore.swift) creates the index on the first open
after upgrading; that initial creation still scans existing rows once. The
[store regression tests](Tests/WhoopBleSampleStoreTests.swift) exercise an
acknowledgment with unrelated queued samples under a SQLite instruction budget.

## Native bridge tests

On macOS with Xcode and an installed iPhone Simulator runtime, run from
`packages/mobile`:

```sh
EXPO_PUBLIC_SENTRY_DSN=https://public-key@sentry.example/project-id pnpm prebuild --no-install
pnpm test:ios:bridge
```

The public DSN placeholder follows the app's
[local simulator setup](../../README.md#signed-release-simulator-audit).
The bridge suite runs the real Expo registration and JavaScript promise path in
a UIKit test host. CocoaPods generates its host and XCTest target from the
module's [test specification](https://guides.cocoapods.org/using/test-specs.html).
It uses Expo's official
[TestAppContext](https://github.com/expo/expo/tree/main/packages/expo-modules-test-core/ios/Runtime)
with a Hermes runtime and JavaScript scheduling. The runner installs source
Expo modules because that helper imports ExpoModulesCore with `@testable`.
This changes the generated local Pods installation; ordinary `pnpm prebuild`
regenerates the normal app project. No Metro server or authenticated account
is needed. The [test cases](ios/BridgeTests/WhoopBleModuleTests.swift) exercise
bridge state transitions; validate physical strap capture and background
Bluetooth delivery separately on a device.

The standalone `swift test` suite remains separate: its target excludes the Expo
bridge and the app-hosted tests, as declared in [Package.swift](Package.swift).
Its [peripheral callback regressions](Tests/WhoopBleConnectionManager+CoreBluetoothTests.swift)
exercise ownership, stale callbacks, cancellation and reconnect through the same
[peripheral interface](ios/WhoopBlePeripheralConnection.swift) used by the native
adapter. The adapter preserves the underlying peripheral's notification identity
across callbacks, and handshake deadlines retain their adapter until settlement.
These tests cover the manager's callback policy; physical strap capture and
background delivery still require a device, following Apple's
[CoreBluetooth background guidance](https://developer.apple.com/documentation/corebluetooth/core-bluetooth-background-processing-for-ios-apps).

The workspace's [React Native patch](../../../../patches/react-native@0.88.1.patch)
preserves build-flavor markers during [CocoaPods source cleanup](https://github.com/CocoaPods/CocoaPods/blob/1.16.2/lib/cocoapods/sandbox/pod_dir_cleaner.rb#L55).
This retains the configuration metadata needed to select Debug frameworks after
a Release archive and a test-dependency installation.

## Runtime, Stability, and Errors

- Node.js 22.14 or later is required by the package tooling.
- iOS 16.4 or later is required by the Expo pod.
- Connection and readiness failures reject with specific error codes and
  messages from the native module.
- WHOOP firmware updates may change the private protocol without notice.

## License and Contributions

Licensed under the [MIT License](LICENSE). Source is maintained in the
[Dofek repository](https://github.com/Asherlc/dofek/tree/main/packages/mobile/modules/whoop-ble).
Report issues or propose changes through
[GitHub](https://github.com/Asherlc/dofek/issues).
