# Bluetooth Device Management Design

## Goal

Give the iOS app one Settings flow for every Dofek-managed Bluetooth device:
the existing WHOOP strap and multiple standard Bluetooth heart-rate monitors.
Users can inspect each device's name, connection state, incoming data, and
buffered samples; connect another device; reconnect or disconnect one device;
and forget a device that is no longer used.

## Scope

- Support multiple concurrent standard Heart Rate Service (`0x180D`) monitors.
- Include the existing WHOOP BLE integration in the same device list while
  retaining its protocol-specific connection and streaming implementation.
- Persist an app-owned registry of standard heart-rate monitors. This means
  devices Dofek has connected to, not an attempted representation of every
  Bluetooth accessory paired in iOS Settings.
- Keep raw samples device-attributed and preserve the existing upload contract.

The scope deliberately excludes generic Bluetooth accessories, vendor-account
providers, and a server-side paired-device table. Pairing, radio state, and
local buffered data belong on the device.

## User Experience

Settings receives a **Bluetooth Devices** row. Its destination has two groups:

1. **WHOOP** has one row when discoverable or previously used by Dofek. The row
   shows the device name, connection/streaming state, latest available data
   summary, and buffered-data count.
2. **Heart-rate monitors** contains every monitor in the app registry. Each row
   shows the advertised name (or a stable unnamed fallback), connection state,
   most recent BPM and R-R receipt time when present, and buffered sample
   count.

The primary action, **Connect device**, scans for a standard Heart Rate Service
monitor and adds it without disconnecting an already ready monitor. Selecting a
row opens a device detail screen. Details show device identity, status,
incoming-data diagnostics, buffered data, and protocol-appropriate actions:
connect/reconnect, disconnect, and forget for standard monitors; WHOOP keeps
its existing connection/stream controls and is not forgotten through the
heart-rate registry.

## Architecture

```text
Settings Bluetooth Devices list
  ├─ WHOOP adapter ─────────────> WhoopBleModule / existing WHOOP manager
  └─ Heart-rate adapter ────────> BleHeartRateModule
                                      ├─ persisted device registry
                                      ├─ multi-peripheral connection manager
                                      └─ device-attributed sample buffer
```

The TypeScript public API for `ble-heart-rate` gains a device snapshot list and
per-device actions. A snapshot is the presentation contract: ID, display name,
connection state, most recent measurement metadata, and buffered count. Swift
owns registry persistence, Core Bluetooth lifecycle, and all mutation of this
state. It emits a device-state event after every relevant change so React Native
screens render current data without deriving metrics in the client.

`BleHeartRateConnectionManager` moves from one `connectedPeripheral` to a
per-peripheral session keyed by `CBPeripheral.identifier`. Scanning remains one
operation at a time, but discovering a monitor initiates another independent
connection handshake. Service discovery, notification readiness, timeout, and
disconnect callbacks stay scoped to that session. A failed session only affects
its own device.

The WHOOP module remains isolated. A small mobile adapter maps its existing
state, known device identity, current streaming diagnostics, and buffered
counts into the list's common presentation type. No WHOOP protocol parsing or
connection behavior is moved into the heart-rate module.

## Data Flow

Every standard-monitor measurement remains captured natively with its
peripheral ID. The native sample buffer already retains that attribution, and
the activity upload service already groups samples by device ID before calling
the server. The new UI consumes native device snapshots only; it does not
compute health metrics or aggregate raw samples.

For WHOOP, the adapter exposes only values the module already makes available:
connection/streaming state and buffer diagnostics. Protocol-specific realtime
data remains handled by the existing WHOOP background sync path.

## Error Handling

- Bluetooth unavailable, scan timeout, connect timeout, and GATT subscription
  failures remain specific native errors and are shown verbatim by the add and
  detail screens.
- A device disconnect changes only that device to disconnected and preserves its
  buffered samples for the existing retry-safe upload behavior.
- Forgetting a standard monitor disconnects it, removes only its registry
  metadata, and does not discard buffered samples; retention and account erasure
  rules remain the existing sample-buffer responsibility.
- Unexpected TypeScript handling errors call `captureException()` before the UI
  shows the specific error message.

## Testing and Validation

- XCTest first for the registry and independent multi-peripheral state
  transitions, including one device disconnecting while another remains ready.
- TypeScript tests for the bridge's snapshot/action contract.
- Mobile route/component tests first for list, device details, add-device
  success/error, WHOOP presence, and explicit unavailable/empty/error states.
- Run the affected Swift package tests, mobile unit tests, typecheck, and
  relevant lint commands.
- Validate connection and real incoming data on a physical iPhone. BLE cannot
  be accepted based on Simulator behavior.

## Constraints and Sources

- Standard monitors use the Bluetooth SIG Heart Rate Service `0x180D` and Heart
  Rate Measurement `0x2A37`; Dofek waits for notification subscription before
  reporting readiness. [Bluetooth SIG Heart Rate Service
  1.0](https://www.bluetooth.com/specifications/specs/heart-rate-service-1-0/)
- Core Bluetooth retrieves peripherals known to the app by identifier and can
  retrieve devices currently connected for a service; it does not establish a
  general app-visible iOS Settings paired-device inventory. [Apple:
  `retrievePeripherals(withIdentifiers:)`](https://developer.apple.com/documentation/corebluetooth/cbcentralmanager/retrieveperipherals%28withidentifiers%3A%29),
  [Apple:
  `retrieveConnectedPeripherals(withServices:)`](https://developer.apple.com/documentation/corebluetooth/cbcentralmanager/retrieveconnectedperipherals%28withservices%3A%29)
- WHOOP remains an isolated, reverse-engineered protocol module; its captured
  data must retain per-device attribution. [WHOOP BLE protocol
  reference](../../whoop-ble-protocol.md)
- Mobile route tests and non-route helpers must live outside `packages/mobile/app/`.
  [Expo Router core concepts](https://docs.expo.dev/router/basics/core-concepts/#6-non-navigation-components-live-outside-the-srcapp-directory)
