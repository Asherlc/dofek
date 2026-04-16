# BLE Probe

Interactive BLE reverse engineering tool for macOS, optimized for WHOOP straps.

## Features
- **Scanning**: Scan for all BLE devices or focus specifically on WHOOP straps.
- **Service Discovery**: Explore all GATT services and characteristics.
- **Subscribing**: Real-time notification monitoring for specific characteristic suffixes (e.g., `0005` for WHOOP data).
- **Command Injection**: Send individual command bytes or raw hex frames to the `CMD_TO_STRAP` characteristic.
- **Frame Parsing**: Built-in support for parsing WHOOP binary frames and packet types.
- **Statistics**: Track notification counts by packet type (e.g., REALTIME_DATA, REALTIME_RAW).

## Technical Details
- **Platform**: Swift (macOS) with `CoreBluetooth`.
- **Supported WHOOP Hardware**: Gen4/Harvard, Maverick/Goose, Puffin.
- **Key WHOOP Service UUIDs**:
  - Gen4: `61080001-8d6d-82b8-614a-1c8cb0f8dcc6`
  - Maverick: `fd4b0001-cce1-4033-93ce-002d5875f58a`

## Usage (REPL)
Run the probe:
```bash
./run.sh
```

Typical WHOOP reverse engineering workflow:
1. `whoop` - Find the strap.
2. `connect <UUID>` - Connect.
3. `discover` - List characteristics.
4. `subscribe 0003` - Watch command responses.
5. `subscribe 0005` - Watch the main data stream.
6. `cmd 6a` - Send `TOGGLE_IMU_MODE` to start high-rate IMU data streaming.
