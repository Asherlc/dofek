# WHOOP Android app inspection

<!-- cspell:words aapt apksigner healthconnect jadx rawdata rearchitect workmanager xmltree -->

This November 22, 2026 snapshot records how the WHOOP Android app connects to
the strap, saves data, and schedules uploads. The app version and local code
identifiers below provide starting points for inspecting a later release.

## Artifact

| Field | Value |
| --- | --- |
| Package | `com.whoop.android` |
| Version | 5.479.1, build 686121 |
| Variant | Arm64, Android 10+, base APK and three splits |
| Bundle SHA-256 | `94dabecb436c79095ec4daaba4ed3f88bb14e8d971d167061192ac3a6e7a7680` |
| Base APK signer SHA-256 | `4ff1dac8482cce1e121eb197969f8634ba3408ee16a17197d4bbfcdb6db9c8e2` |
| Tools | Android SDK Build Tools 35.0.0 and JADX 1.5.5 |

The bundle hash matched the mirror listing. Android's signature verifier
validated the base APK, reported WHOOP Inc. as the signer, and identified a
Google source stamp. The manifest confirmed the package and version.
[Package listing and hashes](https://www.apkmirror.com/apk/whoop/whoop/whoop-5-479-1-release/whoop-5-479-1-2-android-apk-download/) ·
[WHOOP's Google Play listing](https://play.google.com/store/apps/details?id=com.whoop.android).

## Strap connection

- The manifest registers `WhoopSyncService` as a `connectedDevice` foreground
  service. Its action handler has separate foreground requests for Bluetooth
  and uploads. It keeps the notification while either request is active and
  leaves foreground mode when both clear. The build also contains
  `BleWhoopStrapService`, with a feature-flag-controlled reconnect branch.
  [Android foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types#connected-device).
- The retained WHOOP iOS Bluetooth capture shows the app requesting the
  strap's data range, offloading history in chunks, and acknowledging each
  chunk before the strap advances its checkpoint. The capture establishes
  this behavior for stored R18 records. WHOOP says the strap can retain up
  to 14 days of unsynced data. [Packet capture notes](whoop-ble-protocol.md#historical-offload-checkpoint) ·
  [WHOOP catch-up support](https://whoop.my.site.com/whoopsupport/s/article/Why-is-my-WHOOP-Catching-Up?language=en_US).

## Raw data storage and uploads

- `RawDataDao_Impl` writes packet payloads to the Room database. Rows carry
  a timestamp, strap ID, hardware and firmware metadata, packet revision,
  and a local ID. `NewRawDataUploaderImpl` reads bounded groups by revision,
  routes supported revisions through the corresponding uploader, and sends
  gzip-encoded bodies. The packing helper starts a new body once the
  accumulated input reaches its default two-million-byte threshold. The
  repository deletes the selected packets after the group uploads
  successfully. The uploader also records per-revision outcomes and elapsed
  minutes since its previous attempt.
- `RawDataUploadScheduler` defines two Android WorkManager jobs for
  `RawDataUploadWorker`. The periodic job requests a 15-minute interval and
  keeps existing scheduled work. The one-time job replaces unfinished work
  of the same name. Both require a connected network and configure linear retry
  backoff with a 10-second initial delay. Android decides actual execution
  times given job constraints and system state.
  [WorkManager timing and backoff](https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work) ·
  [Unique work policies](https://developer.android.com/develop/background-work/background-tasks/persistent/how-to/manage-work#unique-work).
- The general `DataSyncWorker` and raw upload worker have separate entry
  points. `DataSyncWorkDatabase` records job IDs, trigger sources, and
  outcome timestamps. The general worker has a feature-flag-controlled
  strap sync rate-limiting branch. `UploadPipelineGate` serializes calls
  that pass through it when its separate flag is enabled. This build's
  runtime flag assignments remain unverified.

## Other background work

The app's periodic scheduler also registers jobs for device configuration,
widget updates, firmware events, diagnostics, and GPS uploads. The Health
Connect integration has its own permissions UI and data models. Power
diagnostics listen for Android's power-save changes and record whether
battery optimization applies to the app. These are additional paths to check
when attributing background runtime to strap sync.

## Evidence in the decompiled package

Java paths are relative to the JADX `sources/` directory for this build.
Read the manifest directly from the base APK.

| Finding | Inspection point |
| --- | --- |
| Foreground and Bluetooth lifecycle | `AndroidManifest.xml`, `com/whoop/service/sync/WhoopSyncService.java`, `com/whoop/service/rearchitect/BleWhoopStrapService.java` |
| Raw upload scheduling | `jz0/d.java`, `com/whoop/workmanager/a.java`. The enum mappings are in `oc/a.java`, `oc/k.java`, `oc/l.java`, and `oc/w.java`. |
| Raw packet persistence and upload | `com/whoop/data/local/room/dao/persistent/RawDataDao_Impl.java`, `com/whoop/dataSyncService/rawdata/RawDataUploadWorker.java`, `jz0/b.java`, `jz0/a.java` and `jz0/c.java` for packing, `ue2/d.java` for cleanup |
| General sync and upload gating | `com/whoop/dataSyncService/workmanager/DataSyncWorker.java`, `com/whoop/dataSyncService/room/DataSyncWorkDatabase_Impl.java`, `nz0/f.java` |
| Health Connect permissions and power diagnostics | `com/whoop/healthconnect/view/HealthConnectFragment.java`, `ux2/w.java` |

To reproduce the inspection, verify the bundle's hash, extract `base.apk`,
and run `apksigner verify --print-certs base.apk`. Inspect the manifest with
`aapt2 dump xmltree base.apk --file AndroidManifest.xml`. Decode the bytecode
with `jadx --no-res --output-dir jadx-output base.apk`. Where JADX cannot
reconstruct a coroutine, use its simple decompilation mode on the individual
class and follow the branches and enum values directly. The full JADX pass
reported 422 errors, so findings here use readable methods or the relevant
linear instructions.

## Relevance to Dofek

Dofek already persists Bluetooth samples in a native queue and submits
bounded batches. Dofek's direct and file-backed paths can overlap for the
same batch. A physical-iPhone power trace can show whether that overlap
causes repeated network transfers and whether delaying bulk history would
improve battery use. The Android schedule is useful as a comparison for
separating capture from upload. WHOOP's current iOS cloud scheduling and
comparative battery use remain unmeasured. [Dofek upload design](../packages/mobile/modules/whoop-ble/README.md) ·
[Apple Power Profiler](https://developer.apple.com/documentation/xcode/measuring-your-app-s-power-use-with-power-profiler).
