# Bluetooth Heart-Rate Monitors

Dofek connects to any standard Bluetooth Low Energy heart-rate strap (Polar H10,
Wahoo TICKR, Garmin HRM, Coospo, etc.) from **Settings → Data Sources**, streams
live beats-per-minute for connection status, and stores heart rate + heart-rate
variability into the metric stream independently of activity recording.

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
             authenticated sync lifecycle    ▼
 background-ble-heart-rate-sync ──▶ trpc bleHeartRateSync.pushSamples
                                        │
                                        ▼
        metric stream (provider ble_heart_rate, sourceType "ble")
          ├─ channel heart_rate     (bpm)
          └─ channel rr_interval_ms  (one row per R-R interval)
```

- The native buffer uses the same **peek → upload → confirm-drain** pattern as the
  WHOOP module, so a failed upload leaves samples in place for retry. The mobile
  app drains on authenticated startup, foreground transitions, every 30 seconds
  while active, and iOS background-refresh wakeups.
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
`UIBackgroundModes` so an established connection can continue delivering
notifications while the app is in the background.
