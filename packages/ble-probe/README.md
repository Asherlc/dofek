# BLE Probe

Interactive BLE reverse engineering tool for wearable devices. Includes both a macOS CLI for direct device probing and an iOS Expo native module for in-app debugging.

## macOS CLI

Connects directly to BLE peripherals from your Mac. Useful for protocol exploration when bonding isn't required.

### Usage

```bash
cd packages/ble-probe
bash run.sh
```

First run may prompt for Bluetooth permission — if it crashes, run `open .build/BleProbe.app` once to trigger the macOS permission dialog, then use `bash run.sh`.

### Commands

```
scan                 Scan for all nearby BLE devices (5s)
whoop                Scan for WHOOP straps specifically
connect <UUID>       Connect to a peripheral by UUID
discover             Discover all services and characteristics
subscribe <suffix>   Subscribe to notifications (e.g., 'subscribe 0005')
unsubscribe <suffix> Unsubscribe from notifications
cmd <hex>            Send a WHOOP command byte (e.g., 'cmd 6a')
raw <hex bytes>      Write raw hex bytes to CMD_TO_STRAP
stats                Show notification packet type counts
reset                Reset notification stats
verbose              Toggle verbose mode (show all notifications)
help                 Show help
```

### Example: WHOOP workflow

```
> whoop
  📱 WBB5BP0969399 [147EA472-...] RSSI=-72
> connect 147EA472-F902-4C6E-8955-F123C665CEE5
✅ Connected to WBB5BP0969399
> discover
  ....0002 CMD_TO_STRAP [W,WnR]
  ....0003 CMD_FROM_STRAP [N]
  ....0005 DATA_FROM_STRAP [N]
> subscribe 0003
> subscribe 0005
> cmd 6a
📤 Writing to CMD_TO_STRAP: aa 01 0c 00 ...
> stats
📊 Total notifications: 5
   0x26 (PUFFIN_CMD_RESPONSE): 5
```

### Limitations

- **Requires Bluetooth permission** — macOS TCC requires the app bundle for Bluetooth access
- **No bonding** — macOS connections are unbonded, so WHOOP straps reject commands with error 0x049c. Use the iOS module for bonded-connection testing.

## iOS Expo Native Module

Device-agnostic BLE operations for the Dofek mobile app. Accessible via Settings > Developer Tools > BLE Probe.

### Architecture

```
modules/ble-probe/
  ios/BleProbeModule.swift    — CoreBluetooth native module
  ios/ExpoBleProbe.podspec    — CocoaPods spec
  index.ts                    — TypeScript API
  src/BleProbeModule.ts       — Expo module bridge

app/ble-probe.tsx             — REPL-like debug screen
```

### Key advantage

After one native rebuild to install the module, **all protocol exploration happens in JavaScript and hot-reloads in under 1 second**. Device-specific protocol logic (command formats, CRC computation, packet parsing) lives in JS, not Swift. This eliminates the 2-3 minute native rebuild cycle for every command format tweak.

### API

```typescript
import {
  scan,
  connect,
  discoverServices,
  discoverCharacteristics,
  subscribe,
  writeRaw,
  addNotificationListener,
} from "../modules/ble-probe";

// Scan for devices
const devices = await scan(["service-uuid"], 5);

// Connect
await connect(deviceId);

// Discover
const services = await discoverServices();
const chars = await discoverCharacteristics(serviceUUID);

// Subscribe to notifications
await subscribe("0005");
addNotificationListener((notification) => {
  console.log(notification.hex);
});

// Write raw bytes
await writeRaw("0002", "aa010c000001e741...", false);
```

### Auto-command for remote iteration

Edit the `autoCommand` string in `app/ble-probe.tsx` and save — the command executes on the phone via hot-reload:

```typescript
const autoCommand = "raw aa010c000001e74123016a0101000000";
```

This lets you iterate protocol commands from the terminal without touching the phone.
