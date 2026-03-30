# WHOOP BLE Protocol

Reverse-engineered BLE protocol for WHOOP fitness straps (Gen 4 Harvard, Maverick/Goose, Puffin generations). Findings from APK decompilation (v5.439.0), PacketLogger captures, and live device probing (March 2026).

## GATT Services

| Hardware Gen | Service UUID |
|---|---|
| Gen 4 (Harvard) | `61080001-8d6d-82b8-614a-1c8cb0f8dcc6` |
| Maverick/Goose | `fd4b0001-cce1-4033-93ce-002d5875f58a` |
| Puffin | `11500001-6215-11ee-8c99-0242ac120002` |

## Characteristics

All generations use the same suffix pattern — replace the `0001` in the service UUID:

| Suffix | Name | Direction | Properties |
|---|---|---|---|
| `0002` | CMD_TO_STRAP | Phone → Strap | Write, WriteNoResponse |
| `0003` | CMD_FROM_STRAP | Strap → Phone | Notify |
| `0004` | EVENTS_FROM_STRAP | Strap → Phone | Notify |
| `0005` | DATA_FROM_STRAP | Strap → Phone | Notify |
| `0007` | MEMFAULT | Strap → Phone | Notify |

## Frame Format

### Maverick/Puffin (8-byte header, confirmed)

```
[SOF: 0xAA] [version: 0x01] [payloadLen: u16 LE] [role1: u8] [role2: u8] [headerCRC16: u16 LE]
[command/data payload: payloadLen - 4 bytes]
[payloadCRC32: u32 LE]
```

- **Header CRC16**: CRC16-MODBUS (polynomial 0xA001, init 0xFFFF) of the first 6 header bytes, stored as u16 LE at bytes 6-7
- **Payload CRC32**: Standard IEEE 802.3 CRC32 (`java.util.zip.CRC32`) of the command/data bytes only (NOT including the CRC32 itself), stored as u32 LE at the end of the payload
- `payloadLen` **includes** the 4-byte CRC32 trailer
- `role1` = 0x00, `role2` = 0x01 for command frames (from `AbstractC15395a` in APK)
- Source: `dm0/C15399e.java` (MaverickPacketFrame) in decompiled APK

**Verified**: built frames match PacketLogger capture byte-for-byte. Example:
```
Header:  aa 01 0c 00 00 01 e7 41   (CRC16 of aa010c000001 = 0x41E7)
Payload: 23 f1 6a 01 01 00 00 00   (TOGGLE_IMU_MODE, seq=0xF1)
CRC32:   58 e9 61 fc               (CRC32 of payload = 0xFC61E958)
```

### Gen 4 Harvard (5-byte header)

```
[SOF: 0xAA] [version: u8] [payloadLen: u16 LE] [headerCRC8: u8]
[payload: payloadLen bytes]
```

- CRC8 table in `C28184c.f111541c` in decompiled APK
- Source: `dm0/C15397c.java` (Gen4PacketFrame)

## Packet Types

From `cm0/AbstractC6476c.java` in decompiled APK:

| Byte | Decimal | Name | Description |
|---|---|---|---|
| 0x23 | 35 | COMMAND | Command sent to strap (Gen4/Maverick) |
| 0x24 | 36 | COMMAND_RESPONSE | Strap's response to a command |
| 0x25 | 37 | PUFFIN_COMMAND | Command sent to Puffin straps |
| 0x26 | 38 | PUFFIN_COMMAND_RESPONSE | Puffin command response |
| 0x28 | 40 | REALTIME_DATA | Real-time HR + orientation quaternion (~1Hz) |
| 0x2B | 43 | REALTIME_RAW_DATA | Raw IMU data (Maverick R21 format) |
| 0x2F | 47 | HISTORICAL_DATA | Historical data replay during sync |
| 0x30 | 48 | EVENT | Event notifications |
| 0x31 | 49 | METADATA | Metadata packets |
| 0x32 | 50 | CONSOLE_LOGS | Firmware debug console output (ASCII) |
| 0x33 | 51 | REALTIME_IMU | Real-time IMU stream |
| 0x34 | 52 | HISTORICAL_IMU | Historical IMU replay |
| 0x35 | 53 | RELATIVE_PUFFIN_EVENTS | Puffin-specific events |
| 0x36 | 54 | PUFFIN_EVENTS_FROM_STRAP | Puffin events |
| 0x37 | 55 | RELATIVE_BATTERY_PACK_CONSOLE_LOGS | Battery pack logs |
| 0x38 | 56 | PUFFIN_METADATA | Puffin-specific metadata |

## Command Bytes

From `cm0/EnumC6478e.java` in decompiled APK:

| Byte | Decimal | Name |
|---|---|---|
| 0x01 | 1 | LINK_VALID |
| 0x02 | 2 | GET_MAX_PROTOCOL_VERSION |
| 0x03 | 3 | TOGGLE_REALTIME_HR |
| 0x07 | 7 | REPORT_VERSION_INFO |
| 0x0A | 10 | SET_CLOCK |
| 0x0B | 11 | GET_CLOCK |
| 0x0E | 14 | TOGGLE_GENERIC_HR_PROFILE |
| 0x13 | 19 | RUN_HAPTIC_PATTERN_MAVERICK |
| 0x14 | 20 | ABORT_HISTORICAL_TRANSMITS |
| 0x16 | 22 | SEND_HISTORICAL_DATA |
| 0x17 | 23 | HISTORICAL_DATA_RESULT |
| 0x1A | 26 | GET_BATTERY_LEVEL |
| 0x22 | 34 | GET_DATA_RANGE |
| 0x23 | 35 | GET_HELLO_HARVARD (Gen4 only) |
| 0x33 | 51 | SET_DP_TYPE |
| 0x3F | 63 | SEND_R10_R11_REALTIME |
| 0x4F | 79 | RUN_HAPTICS_PATTERN |
| 0x51 | 81 | START_RAW_DATA |
| 0x52 | 82 | STOP_RAW_DATA |
| 0x53 | 83 | VERIFY_FIRMWARE_IMAGE |
| 0x54 | 84 | GET_BODY_LOCATION_AND_STATUS |
| 0x60 | 96 | ENTER_HIGH_FREQ_SYNC |
| 0x61 | 97 | EXIT_HIGH_FREQ_SYNC |
| 0x62 | 98 | GET_EXTENDED_BATTERY_INFO |
| 0x69 | 105 | TOGGLE_IMU_MODE_HISTORICAL |
| 0x6A | 106 | TOGGLE_IMU_MODE |
| 0x6C | 108 | TOGGLE_OPTICAL_MODE |
| 0x73 | 115 | START_DEVICE_CONFIG_KEY_EXCHANGE |
| 0x74 | 116 | SEND_NEXT_DEVICE_CONFIG |
| 0x75 | 117 | START_FF_KEY_EXCHANGE |
| 0x76 | 118 | SEND_NEXT_FF |
| 0x78 | 120 | SET_FF_VALUE |
| 0x80 | 128 | GET_FF_VALUE |
| 0x7A | 122 | STOP_HAPTICS |
| 0x7B | 123 | SELECT_WRIST |
| 0x91 | 145 | GET_HELLO (Maverick/Puffin) |

## Command Payload Format

```
[packetType: 0x23 or 0x25] [seqNum: u8] [commandByte: u8] [params...]
```

- `0x23` for COMMAND (Gen4/Maverick)
- `0x25` for PUFFIN_COMMAND
- `seqNum` increments per command sent
- `params` vary by command — e.g., TOGGLE_IMU_MODE uses `[revision=0x01, enable=0x01, 0x00, 0x00, 0x00]`

The command payload (including params) is followed by a CRC32 trailer to form the full frame payload.

## R21 Raw Data Format (type 0x2B, record type 21)

1236-byte payload containing 100 accelerometer samples and 100 gyroscope samples:

| Payload Offset | Size | Field |
|---|---|---|
| 0 | 1 | Packet type (0x2B) |
| 1 | 1 | Record type (21 = 0x15) |
| 16 | 2 | countA — accelerometer sample count (u16 LE, typically 100) |
| 20 | 200 | ax samples (100 × i16 LE) |
| 220 | 200 | ay samples (100 × i16 LE) |
| 420 | 200 | az samples (100 × i16 LE) |
| 622 | 2 | countB — gyroscope sample count (u16 LE) |
| 632 | 200 | gx samples (100 × i16 LE) |
| 832 | 200 | gy samples (100 × i16 LE) |
| 1032 | 200 | gz samples (100 × i16 LE) |

- Sensor range: ±8g (1g ≈ 4096 LSB)
- Sample rate: ~50-100 Hz (100 samples per frame, frames at ~1Hz)
- Accelerometer and gyroscope arrays are stored separately (not interleaved)

## Standard Sync Sequence

The WHOOP app performs this sequence on connection:

1. `GET_HELLO (0x91)` — handshake (or `GET_HELLO_HARVARD (0x23)` for Gen4)
2. `START_FF_KEY_EXCHANGE (0x75)` — begin feature flag exchange
3. `GET_FF_VALUE (0x76)` × N — read feature flags (`enable_r22_packets`, `enable_r22_v2_packets`, etc.)
4. `START_DEVICE_CONFIG_KEY_EXCHANGE (0x73)` — begin device config exchange
5. `SEND_NEXT_DEVICE_CONFIG (0x74)` × N — push config values
6. `GET_DATA_RANGE (0x22)` — ask strap what data it has stored
7. `SEND_HISTORICAL_DATA (0x16)` — request historical data replay
8. Strap streams `HISTORICAL_DATA (0x2F)` + `REALTIME_RAW_DATA (0x2B)` + `CONSOLE_LOGS (0x32)` packets
9. App sends `HISTORICAL_DATA_RESULT (0x17)` ACKs for each chunk
10. Concurrent: strap streams `REALTIME_DATA (0x28)` with HR + orientation quaternion at ~1 Hz

## Authentication / Bonding

The strap requires BLE bonding before accepting any commands:

- **Unbonded connections** (e.g., macOS ble-probe): All commands return `PUFFIN_COMMAND_RESPONSE (0x26)` with error code `0x049c` (1180 decimal), regardless of command type, format, or CRC
- **Bonded connections** (iOS piggybacking on WHOOP app): Commands are accepted (0x24 ACK). The WHOOP app establishes the bond during initial strap setup. iOS shares the bond across all apps at the OS level.
- **Bonding is at the OS level** on iOS — `retrieveConnectedPeripherals(withServices:)` returns the strap when the WHOOP app has connected it

## Passive Data Capture (No Command Needed)

R21 raw data (type 0x2B) flows passively during the WHOOP app's normal sync session. Our app can capture accelerometer data by:

1. Finding the strap via `retrieveConnectedPeripherals` (requires WHOOP app to be connected)
2. Calling `connect()` to establish our own logical connection (shares the bonded BLE link)
3. Subscribing to `DATA_FROM_STRAP (0005)` notifications
4. Parsing incoming R21 frames

No `TOGGLE_IMU_MODE` command is needed for this approach. The IMU is already active during sync.

## Data Extraction from 0x28 REALTIME_DATA Packets

The REALTIME_DATA (0x28) packet streams at ~1 Hz during sync and contains:

| Payload Offset | Size | Field | Notes |
|---|---|---|---|
| 22 | 1 | Heart Rate (bpm) | Validated 66-89 range in resting capture |
| 23-40 | 18 | Optical/PPG data | Partially understood, raw preserved |
| 41-44 | 4 | Quaternion W (float32 LE) | Strap's own sensor fusion |
| 45-48 | 4 | Quaternion X (float32 LE) | |
| 49-52 | 4 | Quaternion Y (float32 LE) | |
| 53-56 | 4 | Quaternion Z (float32 LE) | |

HR and quaternion are extracted by `WhoopBleFrameParser.extractRealtimeData()` and buffered separately from IMU data. The full raw payload is preserved for future optical/PPG analysis.

## Commands for Enhanced Data Capture

| Command | Byte | Purpose |
|---|---|---|
| TOGGLE_REALTIME_HR (0x03) | Sent on connect | Continuous 1 Hz HR streaming beyond sync |
| TOGGLE_OPTICAL_MODE (0x6C) | Sent on connect | Enable raw PPG data in 0x28 packets |
| TOGGLE_IMU_MODE (0x6A) | Sent on streaming start | Raw IMU streaming |

All three commands are sent automatically when the iOS app connects to the strap.

## Tools

- `packages/ble-probe/` — macOS CLI for interactive BLE probing (Swift, CoreBluetooth)
- `packages/mobile/modules/ble-probe/` — iOS Expo native module for in-app BLE debugging
- `packages/mobile/app/ble-probe.tsx` — React Native debug screen with REPL-like UI
- `scripts/parse-whoop-ble-capture.ts` — PacketLogger `.pklg` capture parser

## References

- APK decompilation: WHOOP Android v5.439.0, decompiled with `jadx --deobf`
- BLE library: Nordic Semiconductor `no.nordicsemi.android.ble` (BleManagerHandler)
- PacketLogger: Xcode Additional Tools, requires Bluetooth logging profile from Apple
