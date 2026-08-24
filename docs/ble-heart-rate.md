# Bluetooth Heart-Rate Monitors

Dofek connects to any standard Bluetooth Low Energy heart-rate strap (Polar H10,
Wahoo TICKR, Garmin HRM, Coospo, etc.) during activity recording, streams live
beats-per-minute for the UI, and stores heart rate + heart-rate variability into
the metric stream.

Unlike the WHOOP strap integration (a reverse-engineered proprietary protocol —
see [whoop-ble-protocol.md](./whoop-ble-protocol.md)), this uses the **public,
standardized** Bluetooth SIG Heart Rate Service, so it works with any conformant
monitor and requires no vendor account.

## GATT profile

| Item | Assigned number | Notes |
|---|---|---|
| Heart Rate Service | `0x180D` | Advertised by the strap; scanned for by the app. |
| Heart Rate Measurement characteristic | `0x2A37` | `Notify`. One notification per reading (~1 Hz). |

Sources: Bluetooth SIG [Heart Rate Service 1.0](https://www.bluetooth.com/specifications/specs/heart-rate-service-1-0/)
and the [GATT Specification Supplement](https://www.bluetooth.com/specifications/specs/gatt-specification-supplement/)
(Heart Rate Measurement, §3.1), and the [Assigned Numbers](https://www.bluetooth.com/specifications/assigned-numbers/)
document for the 16-bit UUIDs.

### Heart Rate Measurement layout (0x2A37)

Little-endian. Parsed in `BleHeartRateMeasurementParser` (Swift):

- **byte 0 — Flags**
  - bit 0: Heart Rate Value Format (`0` = `UInt8`, `1` = `UInt16`)
  - bits 1–2: Sensor Contact Status
  - bit 3: Energy Expended present
  - bit 4: R-R Interval(s) present
- **Heart Rate Value**: `UInt8` or `UInt16` depending on flag bit 0.
- **Energy Expended** (optional, flag bit 3): `UInt16` — skipped (a derived
  cumulative value, not raw data we store).
- **R-R Intervals** (optional, flag bit 4): zero or more `UInt16`, each in units
  of **1/1024 second**. Converted to milliseconds as `round(raw * 1000 / 1024)`.

A single notification may carry several R-R intervals.

## Data path

```
Strap ──BLE notify (0x2A37)──▶ BleHeartRateModule (iOS)
                                 ├─ emits onHeartRateMeasurement (live bpm for the UI)
                                 └─ buffers samples (peek / confirm-drain)
                                        │
                    on activity save    ▼
   heart-rate-recording-service ──▶ trpc bleHeartRateSync.pushSamples
                                        │
                                        ▼
        metric stream (provider ble_heart_rate, sourceType "ble")
          ├─ channel heart_rate     (bpm)
          └─ channel rr_interval_ms  (one row per R-R interval)
```

- The native buffer uses the same **peek → upload → confirm-drain** pattern as the
  WHOOP module, so a failed upload leaves samples in place for retry.
- Zero-bpm readings (emitted before the strap detects skin contact) are dropped
  server-side and never stored.
- Heart rate is stored on the existing `heart_rate` channel and R-R intervals on
  `rr_interval_ms` (`src/db/sensor-channels.ts`) — no new schema.

## Provider

`ble_heart_rate` is a **mobile push provider** (`@dofek/providers/push-providers`),
labelled "Heart Rate Monitor (Bluetooth)". Like `whoop_ble`, data arrives from the
iOS app rather than a server-side pull job.

## Permissions

`packages/mobile/app.json` declares `NSBluetoothAlwaysUsageDescription` for
connecting to Bluetooth heart-rate monitors. `bluetooth-central` is listed under
`UIBackgroundModes` so streaming continues while recording in the background.

## Device management and diagnostics

The Settings **Bluetooth Devices** catalog shows Dofek's app-managed devices:
the standard heart-rate monitors that this app has successfully added, plus the
separate WHOOP entry. It is deliberately not a view of every Bluetooth device
iOS knows, has paired, or can currently discover. Adding a standard monitor
scans for the Bluetooth SIG Heart Rate Service and saves that monitor's
peripheral identifier in Dofek's local registry. Forgetting a monitor removes
only that local registry entry; it does not change system Bluetooth pairing.

For a saved standard monitor, reconnecting asks Core Bluetooth to resolve that
specific identifier with
[`CBCentralManager.retrievePeripherals(withIdentifiers:)`](https://developer.apple.com/documentation/corebluetooth/cbcentralmanager/retrieveperipherals(withidentifiers:)).
Apple's separate
[`retrieveConnectedPeripherals(withServices:)`](https://developer.apple.com/documentation/corebluetooth/cbcentralmanager/retrieveconnectedperipherals(withservices:))
API reports currently connected peripherals matching supplied services; it is
not a durable device registry and is not used to populate the app-managed list.

Each standard monitor has an independent Core Bluetooth session. Accordingly,
multiple conformant Heart Rate Service monitors can be connected and monitored
at the same time; disconnecting one by its device ID leaves the others active.
The legacy no-argument disconnect action intentionally stops every active
standard-monitor session.

The list exposes each device's own connection state. Its detail screen exposes
native diagnostics for that same device: latest BPM, latest R-R intervals,
timestamp of the latest measurement, and buffered-sample count. These values
update from native device-state events after connection transitions and Heart
Rate Measurement notifications. WHOOP remains a distinct device kind because
its proprietary protocol and diagnostics differ; the catalog reports its own
connected/disconnected state and IMU/realtime buffer counts without treating it
as a standard Heart Rate Service monitor.

## Physical-device acceptance

Swift and TypeScript tests validate parser, buffer, registry, catalog, and UI
contracts, but they cannot verify the Bluetooth radio lifecycle. The iOS
Simulator is not evidence of BLE hardware behavior; Apple describes Core
Bluetooth as the framework for communicating with Bluetooth Low Energy devices
on Apple platforms in its [Core Bluetooth documentation](https://developer.apple.com/documentation/corebluetooth).

Before release approval, test the exact build on a physical iPhone with two
standard heart-rate monitors: connect both, confirm both remain independently
connected after one disconnects, verify list and detail diagnostics change
after notifications, add another monitor from Settings, and confirm WHOOP is
visible with the correct connected/disconnected status. Record the iPhone and
monitor hardware, iOS version, build identifier, and observed result in the PR
description. Do not represent a Simulator run as BLE radio validation.
