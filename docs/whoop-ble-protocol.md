# WHOOP BLE Protocol

<!-- cspell:words todatetime -->

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

## Compact REALTIME_DATA (0x28, 24-byte payload, record type 2)

The strap continuously streams compact 0x28 packets at ~1 Hz, even outside sync sessions. Decoded from live device capture (March 2026):

| Payload Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 1 | Packet type (`0x28`) | |
| 1 | 1 | Record type (`0x02`) | |
| 2-5 | 4 | Timestamp (u32 LE) | Unix epoch seconds. **Different offset from other packet types** (which use offset 7). |
| 6-7 | 2 | Sub-sequence / flags | Varies per session |
| **8** | **1** | **Heart Rate (bpm)** | Confirmed 60-62 bpm in resting capture. 0 when strap has no reading. |
| **9** | **1** | **R-R interval count** | Zero intervals does not invalidate the independently reported BPM. |
| **10-11** | **2** | **R-R interval (u16 LE, ms)** | Beat-to-beat timing. ~900-1050 ms at resting HR. 0 when count=0. |
| 12-17 | 6 | Reserved (zeros) | |
| 18 | 1 | Constant `0x01` | |
| 19 | 1 | Constant `0x00` | |
| 20-23 | 4 | CRC32 / checksum | Changes every packet |

The retained [PacketLogger capture](../packages/mobile/modules/whoop-ble/Tests/fixtures/imu-activation-capture.tsv)
contains 52 compact packets, including 38 with positive BPM and zero intervals.
WHOOP's [research FAQ, page 4](https://sensorlab.arizona.edu/sites/default/files/2023-05/WHOOP%20Unite%20Research%20FAQs_0.pdf#page=4)
explains that its heart-rate estimate can remain available without an R-R
estimate, particularly during movement. The native buffer therefore exports
`heartRateBpm` independently of `rrIntervalMs`; see the
[capture regressions](../packages/mobile/modules/whoop-ble/Tests/WhoopBleSampleSerializerTests.swift).

## Full REALTIME_DATA (0x28, 116-byte payload)

During active sync sessions, the strap sends a larger 116-byte variant:

| Payload Offset | Size | Field | Notes |
|---|---|---|---|
| 22 | 1 | Heart Rate (bpm) | Validated 66-89 range in PacketLogger capture |
| 23-40 | 18 | Optical/PPG data | Partially understood, raw preserved |
| 41-44 | 4 | Quaternion W (float32 LE) | Strap's own sensor fusion |
| 45-48 | 4 | Quaternion X (float32 LE) | |
| 49-52 | 4 | Quaternion Y (float32 LE) | |
| 53-56 | 4 | Quaternion Z (float32 LE) | |

The full format only appears during active sync (when the WHOOP app sends `SEND_HISTORICAL_DATA`). Outside sync, only the compact 24-byte format streams.

## HISTORICAL_DATA (0x2F, 116-byte payload, record type 18)

Historical data replayed during sync. Contains the same sensor data as the compact 0x28 but with a longer header and additional fields:

| Payload Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 1 | Packet type (`0x2F`) | |
| 1 | 1 | Record type (`0x12` = 18) | |
| 2 | 1 | Record marker | |
| 3-6 | 4 | Record index (u32 LE) | |
| 7-10 | 4 | Unix seconds (u32 LE) | |
| 11-12 | 2 | Fractional clock ticks (u16 LE) | 1/32768 second per tick in the retained capture. |
| 13 | 1 | Header padding | |
| **14** | **1** | **Heart Rate (bpm)** | Confirmed from capture (values 60-73) |
| **15** | **1** | **R-R interval count** | Zero intervals can accompany positive BPM. |
| **16-23** | **8** | **Up to four R-R words (u16 LE)** | The current parser retains the first interval. |
| 24-25 | 2 | Metadata flags | |
| 26-27 | 2 | Changing data | |
| 28 | 1 | Session marker | |
| **29** | **1** | **Smoothed HR (bpm)** | Tracks ~2-3 bpm below byte 14 |
| 30-32 | 3 | Padding | |
| **33-36** | **4** | **Quaternion W (float32 LE)** | Confirmed unit quaternion (magnitude ~1.00) |
| **37-40** | **4** | **Quaternion X (float32 LE)** | |
| **41-44** | **4** | **Quaternion Y (float32 LE)** | |
| **45-48** | **4** | **Quaternion Z (float32 LE)** | |
| 49-115 | 67 | Config/metadata | Partially decoded |

For captured R18 and R21 records, combine the timestamp as
`unix_seconds + fractional_ticks / 32768`, before adding any IMU sample offset.
In the [capture](../packages/mobile/modules/whoop-ble/Tests/fixtures/imu-activation-capture.tsv),
the fractional word `14090` means approximately `0.43` seconds. Treating it as
milliseconds incorrectly adds `14.09` seconds. The
[serialization regressions](../packages/mobile/modules/whoop-ble/Tests/WhoopBleSampleSerializerTests.swift)
verify matching captured live/history readings. The independently maintained
[R21 protocol reference](https://github.com/ryanbr/noop/blob/main/docs/PROTOCOL_SENSORS.md#inertial-record-timestamps)
documents the same fractional clock scale.

The [native serializer](../packages/mobile/modules/whoop-ble/ios/WhoopBleSampleSerializer.swift)
preserves device time without replacing early or future readings with phone-clock
bounds. The [server timestamp filter](../packages/server/src/routers/sample-validation.ts)
drops individual samples more than five minutes ahead of server time. Filtered
samples are processed as part of the acknowledged batch and are removed from the
native queue; this does not recover readings from a bad device clock. The policy
retains CRC checks while avoiding timestamp identities manufactured by clamping.

## Persistent Config Keys (from firmware console logs)

The WHOOP app pushes 17 persistent config keys to the strap during sync via `SEND_NEXT_DEVICE_CONFIG (0x74)`:

| Index | Key | Value | Purpose |
|---|---|---|---|
| 0 | `general_ab_test` | 2 | A/B test group |
| 1 | `enable_r22_packets` | 2 | R22 optical data format v1 |
| 2 | `enable_r22_v2_packets` | 2 | R22 optical data format v2 |
| 3 | `enable_r22_v3_packets` | 2 | R22 optical data format v3 |
| 4 | `enable_r22_v4_packets` | **1** | R22 optical data format v4 (only one set to 1) |
| 5 | `enable_r22_v5_packets` | 2 | R22 optical data format v5 |
| 6 | `enable_r22_v6_packets` | 2 | R22 optical data format v6 |
| 7 | `enable_r22_v8_packets` | 2 | R22 optical data format v8 (no v7) |
| 8 | `make_hrfm_visible` | 2 | HR frequency measurement visibility |
| 9 | `disable_pip_r26_packets` | ? | Pulse information packets |
| 10 | `wear_detect_bias` | ? | Wear detection sensitivity |
| 11 | `enable_pdaf_walk_det` | ? | Walk detection |
| 12 | `enable_maverick_model` | 1 | Maverick hardware model |
| 13 | `hr_ch_switching` | 2 | HR channel switching |
| 14 | `ir_hw_switching` | ? | IR hardware switching |
| 15 | `enable_passive_strap_fit_gen5` | ? | Passive strap fit detection |
| 16 | `enable_sig11_during_sleep` | 2 | Signal 11 during sleep |

**R22 = optical sensor data packets.** The firmware logs show "No active optical data collection sources" during the retained daytime capture. This does not establish a universal collection schedule. Skin temperature has a separate sensor; see [WHOOP's specifications](https://www.whoop.com/us/en/press-center/introducing-4-0-whoop-body-any-wear-technology/).

## Commands for Enhanced Data Capture

| Command | Byte | Purpose |
|---|---|---|
| TOGGLE_REALTIME_HR (0x03) | Sent on connect | Continuous 1 Hz HR streaming beyond sync |
| TOGGLE_OPTICAL_MODE (0x6C) | Sent on connect | Enable raw PPG data in 0x28 packets |
| TOGGLE_IMU_MODE (0x6A) | Sent on streaming start | Raw IMU streaming |
| SEND_R10_R11_REALTIME (0x3F) | Sent on connect | Request full realtime data (did not upgrade to 116-byte format in testing) |

All commands are sent automatically when the iOS app connects to the strap and are ACK'd (0x24 response).

## What We Currently Capture

| Data | Packet | Rate | Status |
|---|---|---|---|
| Heart Rate (bpm) | 0x28 compact, byte 8; 0x2F R18, byte 14 | 1 Hz | **Stored** as the strap-reported `heart_rate`, independently of interval availability |
| R-R Interval (ms) | 0x28 compact, bytes 10-11 | 1 Hz | **Stored** in metric stream `rr_interval_ms` channel |
| Accelerometer (3-axis) | 0x2B R21 | ~100 Hz | **Stored** in `inertial_measurement_unit_sample` |
| Gyroscope (3-axis) | 0x2B R21 | ~100 Hz | **Stored** in `inertial_measurement_unit_sample` |
| Orientation quaternion | 0x2F R18, bytes 33-48 | During sync | **Stored** in metric stream `orientation` channel when present |
| Historical R-R | 0x2F R18, bytes 16-17 | During sync | **Stored** in metric stream `rr_interval_ms` channel alongside reported heart rate |

Activity charts prefer reported BPM at the same provider priority and timestamp.
The [upload repository](../packages/server/src/repositories/whoop-ble-sync-repository.ts)
retains positive `heartRateBpm` values even when the packet has no beat intervals;
zero or omitted BPM remains an unavailable measurement. This follows WHOOP's
[documented distinction between heart-rate estimation and beat-interval availability](https://sensorlab.arizona.edu/sites/default/files/2023-05/WHOOP%20Unite%20Research%20FAQs_0.pdf#page=4).

For interval-only observations, activity charts derive instantaneous heart rate from retained positive, finite
beat intervals as `60000 / rr_interval_ms`; this is the reciprocal method
described by [PhysioNet](https://archive.physionet.org/tutorials/hrv/), rather than
the strap's smoothed BPM field. The [sensor projection](../analytics/models/staging/sensor_scalar_sample.sql)
emits `heart_rate` samples with `measurement_kind = 'estimated'`, retaining the
original timestamps, source-record IDs, provider, device, and nullable activity
links. Raw intervals remain canonical. Web and mobile source controls, charts,
and zones consume that shared server projection without filling recording gaps.
Reported BPM wins over an interval-derived reading at the same timestamp when
their provider and configured priority are equal; see the [deduplication model](../analytics/models/read_models/deduped_sensor.sql).
Invalid intervals and deletion tombstones retract their derived readings.
For history outside the normal ingestion-time microbatch lookback, use the
[bounded sensor replay procedure](../analytics/README.md#microbatch-start-bounds-and-historical-backfills).

### Independent upload streams and retention

The [native sample store](../packages/mobile/modules/whoop-ble/ios/WhoopBleSampleStore.swift)
commits realtime and IMU samples to SQLite, bound to one authenticated account,
server origin, and generation. Samples survive process recreation. Each stream
reserves at most 500 rows from one peripheral; the reservation identity and body
remain stable until acknowledgment. SQLite provides [atomic transactions](https://sqlite.org/isolation.html).
No JavaScript uploader competes with the native queue, and the former in-memory
overflow limits no longer discard unacknowledged samples.

The [background uploader](../packages/mobile/modules/whoop-ble/ios/WhoopBleBackgroundUploader.swift)
uses independent native transfers for the two streams. Actual BLE arrivals
coalesce scheduling checks to five seconds. Full batches are eligible immediately
at a scheduling check; partial batches are eligible after 30 seconds, or an
authenticated configuration/foreground/refresh flush. Submission failures and
transient transport failures retain the reservation and delay capture-triggered reattempts by
30 seconds to avoid a per-notification retry loop. Explicit lifecycle flushes
may retry sooner. Authentication failures block the affected stream until new
configuration; a restored task with unknown credentials may retry the currently
configured token once, then blocks if that attempt is rejected.

The [URLSession adapter](../packages/mobile/modules/whoop-ble/ios/WhoopURLSessionTransport.swift)
uses file-backed background uploads to the existing authenticated tRPC routes.
A transport file is a disposable projection of the reserved SQLite rows. Startup
reconciles OS task identities before resubmission, reconstructs missing body
files, and cancels orphan task identities. A successful HTTP response must also
contain the valid tRPC result before the exact reservation is acknowledged.
The existing routers filter invalid/future samples, and a realtime sample can
produce several metric rows; `inserted` is therefore not a prefix length or a
promise that every source sample produced a row. See the
[realtime writer](../packages/server/src/repositories/whoop-ble-sync-repository.ts)
and [IMU router](../packages/server/src/routers/inertial-measurement-unit-sync.ts).

Apple's [background transfer service](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background)
controls actual delivery timing and requires file-backed tasks. Submitted
requests may survive app process recreation. The native app-delegate subscriber
restores completion handling independently of React. Session tokens remain in
application memory; iOS owns the submitted request headers. Native callbacks
can acknowledge restored tasks before JavaScript supplies credentials for new
requests. Canonical server routes must serve directly: background URLSession
automatically follows redirects, and a final origin mismatch prevents local
acknowledgment rather than preventing the redirect itself.

Sign-out and account/server changes cancel captured old task identities, rotate
the generation, and purge old rows, projections, and account counters. Late
callbacks cannot consume a replacement account's rows. Account erasure preserves
the monotonic device cutoff across reconfiguration. Ordinary BLE disconnection
and app suspension preserve the queue. Queue storage and transport projections
are excluded from backups and use locked-device-accessible
[file protection](https://developer.apple.com/documentation/foundation/fileprotectiontype/completeuntilfirstuserauthentication).
Unexpected storage failures stop capture, report to Sentry, and emit a capture
error to the authenticated app; there is no memory-only fallback.

### Diagnosing capture, upload, and visibility

Use a bounded UTC incident window and the authenticated account ID. The
[mobile telemetry boundary](../packages/mobile/lib/telemetry.ts) supplies the
account and app/runtime versions. Follow the
[native diagnostics contract](../packages/mobile/modules/whoop-ble/index.ts)
and [reporter](../packages/mobile/lib/whoop-ble-diagnostics.ts):

| Evidence | Fields and events | Interpretation |
| --- | --- | --- |
| Connection | `native_connection_event`, `nativeOccurredAt`, `nativeSessionId`, `processId`, error domain/code, subscription/handshake state | Retained native events can arrive later. Deduplicate by event ID and distinguish native occurrence from export time. Retained connection history has unknown account provenance. |
| Capture | `capture_snapshot`, notification/parsed/valid-heart-rate timestamps and counts | A connected state alone does not establish new valid heart rate. Compare observations and the activity window. |
| Durable queue | `bufferInstanceId`, stream counts, oldest/newest timestamps, received/confirmed/erased/cleared counters | The generation persists across ordinary app recreation; a new account/server binding rotates it. `bufferCreatedAt` describes the current native uploader instance and `checkpointAt` the snapshot time. |
| Native delivery | `activeUploadCount`, `blockedUploadStreams`, `lastUploadError` | A growing queue and no active task differs from a server-rejected stream. Inspect the reported error and native Sentry event before choosing remediation. |
| Server | `upload_received`, `upload_published`, `upload_failed`, `batchId`, accepted/filtered sample bounds, `boundary` | A stable batch UUID joins the request to the reservation. Broker publication is distinct from downstream chart visibility. |

Use the live service names and `attributes.custom` map documented in the
[Axiom runbook](axiom-observability-runbook.md). Server publication includes
`telemetry.batchId` from the native body and the authenticated account/device.
Published row counts can exceed source sample counts because one realtime
sample produces several channels. The
[server helper](../packages/server/src/lib/sensor-upload-telemetry.ts) defines
these fields; KafkaJS documents the producer's
[acknowledgment boundary](https://kafka.js.org/docs/producing#producing-messages).

Older mobile builds used memory-only queues and emitted `previous_buffer_checkpoint`,
JavaScript `worker_started`/`upload_started`/`buffer_confirmed` events.
Those historical events do not describe the native durable queue. Consult the
incident's app/runtime version before applying either interpretation. The
[October 28 incident](production-incident-baseline.md#2026-10-28--missing-whoop-bluetooth-heart-rate-for-afternoon-ride)
records the transition and validation limits.

### Native background refresh evidence

When the retained queue grows without an upload attempt, inspect the separate
`background-refresh` log category before changing uploader behavior. The
[native journal](../packages/mobile/modules/background-refresh/README.md#native-refresh-diagnostics)
retains 64 metadata events plus overflow, replayed through authenticated mobile
telemetry on setup, foreground, and handler receipt/settlement. It records
registration, schedule submission, launch, listener changes, bridge dispatch,
JavaScript receipt, completion, and expiration. Scheduling failures include
`errorDomain`, `errorCode`, and `errorDescription`; schedule events include
`backgroundRefreshStatus`, `lowPowerModeEnabled`, and `earliestBeginAt`.

Use native `eventId` to deduplicate replay across JavaScript lifetimes, and
`nativeSessionId`, `processId`, and `taskId` to follow a launch. Sort by
`nativeOccurredAt`, because `_time` is telemetry emission time after replay.
`diagnosticAccountProvenance=unknown` means `userId` identifies the authenticated
replaying session, not proven ownership when a native event occurred. Account
erasure clears the native history through the existing cleanup lease. These
metadata writes use asynchronous [UserDefaults persistence](https://developer.apple.com/documentation/foundation/userdefaults);
missing events and overflow cannot establish that iOS never ran a task.

In Axiom, first confirm the live dataset and service fields using the
[observability runbook](axiom-observability-runbook.md). The examples below use
`dofek-logs`, `service.name`, and the current `attributes.custom` object emitted
by the [Axiom exporter](../packages/telemetry/src/axiom-log-exporter.ts).
Set a bounded UTC incident window in the explorer; widen the emission window
if native history was replayed after the incident. Replace `ACCOUNT_ID` with the
account whose app is replaying the journal. Native occurrence filtering remains
independent of replay time:

```apl
['dofek-logs']
| where ['service.name'] == 'dofek-mobile'
| extend d = ['attributes.custom']
| where tostring(d['event']) == 'native_background_refresh_event'
| where tostring(d['userId']) == 'ACCOUNT_ID'
| extend eventId = tostring(d['eventId'])
| summarize arg_max(_time, d) by eventId
| extend nativeAt = todatetime(d['nativeOccurredAt'])
| where nativeAt >= datetime(2026-10-24T08:00:00Z) and nativeAt < datetime(2026-10-25T08:00:00Z)
| project nativeAt, emittedAt=_time, nativeEvent=d['nativeEvent'], taskId=d['taskId'],
    nativeSessionId=d['nativeSessionId'], processId=d['processId'], success=d['success'],
    reason=d['reason'], backgroundRefreshStatus=d['backgroundRefreshStatus'],
    lowPowerModeEnabled=d['lowPowerModeEnabled'], earliestBeginAt=d['earliestBeginAt'],
    errorDomain=d['errorDomain'], errorCode=d['errorCode'], errorDescription=d['errorDescription'],
    historyOverflowCount=d['historyOverflowCount'], diagnosticAccountProvenance=d['diagnosticAccountProvenance']
| sort by nativeAt asc
```

To count boundaries or isolate scheduler failures, keep the query through the
native-time filter, then replace the final `project`/`sort` with:

```apl
| summarize events=count() by nativeEvent=tostring(d['nativeEvent']), reason=tostring(d['reason'])
```

Or use `| where tostring(d['nativeEvent']) == 'schedule_failed'` before the original
projection. Axiom documents [extend](https://axiom.co/docs/apl/tabular-operators/extend-operator)
and [summarize](https://axiom.co/docs/apl/tabular-operators/summarize-operator),
including [explicit arg_max fields](https://axiom.co/docs/apl/aggregation-function/arg-max),
for these projections and grouped event counts.

Interpret the last observed boundary conservatively:

- `schedule_succeeded` confirms submission; it does not guarantee execution.
  Apple's [`earliestBeginDate`](https://developer.apple.com/documentation/backgroundtasks/bgtaskrequest/earliestbegindate)
  is a lower bound, and Dofek keeps its existing 15-minute request.
- `task_launched` followed by `task_completed` with `reason=missing_listener`
  exposes the existing cold-start listener policy. A native launch with
  `bridge_dispatched` but no `js_received` narrows the missing boundary to the
  event bridge/JavaScript lifetime, subject to retained-history gaps.
- `completion_requested` records the JavaScript result. `task_completed` records
  the coordinator's winning completion decision. `task_expired` and
  `no_pending_task` distinguish expiry from a later ignored completion;
  expiration does not cancel existing JavaScript work.
- `nativeOccurredAt` timestamps the diagnostic call. The
  [coordinator](../packages/mobile/modules/background-refresh/ios/BackgroundRefreshTaskCoordinator.swift)
  records after releasing its state lock, so simultaneous transitions can appear
  out of decision order. Use task IDs and completion reasons together; timestamp
  order alone does not establish causality between concurrent records.
- A complete refresh without native upload activity or server receipt requires
  looking at the WHOOP connection, durable queue, blocked-stream state, and last
  upload error; refresh completion alone does not establish sample publication
  or chart visibility.

The additive bridge requires a new native build. Keep the existing Expo
fingerprint runtime policy so updates target compatible binaries
([Expo runtime versions](https://docs.expo.dev/eas-update/runtime-versions/)).
SwiftPM validates the journal/coordinator; an iOS build validates the Expo-bound
scheduler/bridge. Verify real OS scheduling, expiration, and BLE recovery on a
physical iPhone; simulator evidence does not establish those hardware paths
([Expo simulator limitations](https://docs.expo.dev/workflow/ios-simulator/#limitations)).

For a disconnection alert, first correlate the native disconnect with the
[notification coordinator's](../packages/mobile/modules/background-refresh/ios/CollectionNotificationCoordinator.swift)
five-minute grace period, then check for a native reconnect or handshake failure.
The absence of an alert does not establish continuous heart-rate capture or
successful upload. The [notification coordinator](../packages/mobile/modules/background-refresh/ios/CollectionNotificationCoordinator.swift)
cancels the warning on a connected event; it does not inspect sample freshness,
queue age, or upload acknowledgments. A short reconnection can therefore cancel
the warning even when no new valid heart rate has been observed. Compare the
capture and upload evidence separately. The app-closure warning is best effort
because iOS may omit the [termination callback](https://developer.apple.com/documentation/uikit/uiapplicationdelegate/applicationwillterminate(_:));
neither warning proves notification authorization or delivery without direct
evidence of those outcomes.
If the background outcome has not reached the log service, open Dofek briefly
to allow the [reporter](../packages/mobile/lib/whoop-ble-diagnostics.ts) to export
retained native history. Correlate `nativeSessionId`, sort by `nativeOccurredAt`,
and deduplicate by `eventId`; ingestion time describes the later export.
Then verify a newer `lastDataNotificationAt`, `lastParsedRealtimeAt`, and
`lastValidHeartRateAt` to establish resumed heart-rate capture. A foreground
recovery does not establish sustained background recovery or historical
completeness, as illustrated by the
[October 24 evidence](incidents/2026-10-24-whoop-connection-evidence.md#foreground-replay-confirms-the-recovery-failure).

Automatic recovery leaves a pending Bluetooth connection intact instead of
expiring it after ten seconds. The
[handshake lifecycle](../packages/mobile/modules/whoop-ble/ios/WhoopBleConnectionManager+Handshake.swift)
keeps explicit connection requests bounded and times out service discovery and
notification subscription after a passive connection succeeds. Discovery/retry
preserves pending peripheral ownership. Apple documents that
[connection requests do not time out](https://developer.apple.com/documentation/corebluetooth/cbcentralmanager/connect(_:options:))
and that [restored peripherals can be connected or pending](https://developer.apple.com/documentation/corebluetooth/cbcentralmanagerrestoredstateperipheralskey).
The existing delayed alert still reports loss of collection while a reconnect
remains pending; a native rebuild and physical background test are required to
validate this behavior on a strap.

The [connection journal](../packages/mobile/modules/whoop-ble/ios/WhoopBleConnectionDiagnostics.swift)
persists the latest 64 metadata events at native lifecycle boundaries, including
while JavaScript is suspended. UserDefaults writes update memory immediately and
persist asynchronously, so the final write is not guaranteed after abrupt
termination: [Apple UserDefaults](https://developer.apple.com/documentation/foundation/userdefaults).
Its reads are nondestructive. The [reporter](../packages/mobile/lib/whoop-ble-diagnostics.ts)
logs each retained event once per JavaScript diagnostics lifetime, retaining
stable IDs across later replays. `connectionHistoryOverflowCount` identifies
history truncation; a gap does not establish why the app stopped or prove a
successful reconnection. Account erasure clears this history through the
[native bridge](../packages/mobile/modules/whoop-ble/ios/WhoopBleModule.swift).

Use the [Axiom map-field paths](axiom-observability-runbook.md) for updated mobile
logs. Bound the query by ingestion time wide enough to include the next app
startup, then filter `nativeOccurredAt` to the actual incident window; native
background events may be reported later. A Bluetooth disconnect alone is not a
cloud authorization failure. The [CoreBluetooth delegate callback](https://developer.apple.com/documentation/corebluetooth/cbcentralmanagerdelegate/centralmanager(_:diddisconnectperipheral:error:))
and the journal's application handshake events describe different boundaries.
These native diagnostics require a [new native build](https://docs.expo.dev/workflow/customizing/);
an existing installation cannot gain them from a JavaScript-only update.

After `upload_published` with `boundary=redpanda`, follow the existing
[consumer-lag and freshness checks](metric-stream-redpanda-r2-runbook.md#freshness-checks).
Then compare account/device/time coverage in raw and serving storage. Replace
the example account, device, and UTC bounds below with the incident scope:

```sql
SELECT
    channel,
    count() AS row_count,
    min(recorded_at) AS first_sample_at,
    max(recorded_at) AS last_sample_at
FROM ingest.metric_stream FINAL
WHERE user_id = toUUID('00000000-0000-0000-0000-000000000000')
    AND provider_id = 'whoop_ble'
    AND device_id = 'REPLACE_WITH_DEVICE_ID'
    AND recorded_at >= toDateTime64('2026-10-22 14:53:00', 6, 'UTC')
    AND recorded_at < toDateTime64('2026-10-22 15:51:00', 6, 'UTC')
    AND channel IN ('heart_rate', 'rr_interval_ms')
    AND is_deleted = 0
GROUP BY channel;
```

Repeat the same bounded query against `analytics.sensor_scalar_sample FINAL`,
using `_peerdb_is_deleted = 0` in place of `is_deleted = 0`. The
[scalar projection](../analytics/models/staging/sensor_scalar_sample.sql)
derives heart rate from intervals, so compare timestamp coverage and source
identity rather than expecting identical channel counts. Published data missing
from raw storage requires sink/consumer investigation; raw data present but
absent from the scalar projection requires analytics freshness investigation.
If both contain the samples, inspect the activity source selection and response.
These checks do not provide an exact batch receipt in the sink: the upload UUID
is log correlation metadata, not a stored sensor-row key.

The expanded native bridge requires a new native build; an OTA update cannot add
native code. The app uses the fingerprint runtime policy in
[app.json](../packages/mobile/app.json).
Follow Expo's [runtime compatibility guidance](https://docs.expo.dev/eas-update/runtime-versions/)
and verify a real device's version/build before interpreting absent new fields.
The telemetry does not establish what happened before that build was installed.

### Investigating Bluetooth/cloud differences

Compare readings from the same activity window at nearby timestamps before
comparing whole-window summaries. Missing intervals can concentrate in moving
or higher-heart-rate periods, so different coverage changes the summary even
when overlapping readings agree. WHOOP documents that interval estimates can
be unavailable during sport in its [research FAQ](https://sensorlab.arizona.edu/sites/default/files/2023-05/WHOOP%20Unite%20Research%20FAQs_0.pdf#page=4).

Check the reported-BPM and interval channels independently, retain the provider
and device identities, and compare live/history copies for timestamp shifts.
Use captured packets to distinguish an absent interval from an absent BPM;
the [native capture regressions](../packages/mobile/modules/whoop-ble/Tests/WhoopBleSampleSerializerTests.swift)
exercise the absent-interval case. The [server chart regression](../packages/server/src/repositories/activity-metric-sources-repository.integration.test.ts)
executes the reported-BPM path through an interval gap against ClickHouse.

## Background thermal and optical records

WHOOP has a dedicated skin-temperature sensor, separate from its optical LEDs;
see the [manufacturer specifications](https://www.whoop.com/us/en/press-center/introducing-4-0-whoop-body-any-wear-technology/).
The retained [PacketLogger fixture](../packages/mobile/modules/whoop-ble/Tests/fixtures/imu-activation-capture.tsv)
contains 71 complete 124-byte R18 frames passing header CRC16 and body CRC32.
Their unsigned thermal word at **full-frame offset 73** (payload offset 65)
ranges from 3216 to 3222. Dividing by 100 matches the skin-temperature encoding
documented in the independently maintained
[5/MG R18 reference](https://github.com/ryanbr/noop/blob/2a1de7609843b095505274ad6fc811757210be80/docs/PROTOCOL_SENSORS.md#r18-biometric-summary).
This corroborates the encoding, not physical calibration or the identity of
the auxiliary thermal words. Do not apply WHOOP 4 ADC conversions to MG.
The [server decoder tests](../packages/server/src/services/whoop-sensor-decoder.test.ts)
exercise all 71 captured records and distinguish source time from reception time.

The native [serializer](../packages/mobile/modules/whoop-ble/ios/WhoopBleSensorRecord.swift)
preserves complete CRC-valid full type-40 realtime and type-43/type-47 sensor
records, excluding compact HR-only packets, existing R21 IMU and ECG layouts.
Full realtime records retain their opaque optical region instead of discarding
it at the ingestion boundary. Each record has a stable capture identity and observed
device-information strings. Records enter the existing SQLite outbox as
`sensorRecords`; reservations contain at most 16 records and 262144 encoded bytes.
The native uploader sends them through `whoopBleSync.pushSensorRecords`,
independently of IMU/realtime delivery. The
[durability tests](../packages/mobile/modules/whoop-ble/Tests/WhoopBleSampleStoreTests.swift)
verify reopening, byte bounds and erasure.
For captured R18 records, erasure checks both reception and source time, so
a delayed historical offload cannot resurrect measurements preceding deletion.
Unverified layouts retain observation-time semantics.

The [router](../packages/server/src/routers/whoop-ble-sync.ts) validates complete
frames before publishing canonical `sensor_record` metadata through the existing
metric-stream path. Reception time is `recordedAt`; original source clocks remain
in the frame. The [repository](../packages/server/src/repositories/whoop-sensor-repository.ts)
projects R18 temperature at query time, groups replayed source timestamps once,
and uses measurement dates for daily source selection without writing a derived
Postgres value. Both clients inspect uploaded records on the WHOOP BLE provider
detail screen.

R20/R22/R26 remain opaque until reproducible captures support their layouts.
Retain bytes without assigning unverified wavelengths, sample timing, SpO2
percentages or respiratory rates. Existing optical activation commands remain
unchanged; this change does not force persistent feature flags or initiate
historical trimming. Actual availability requires a physical strap check. An
overnight capture is the next evidence needed for additional optical maps; the
[upstream reference](https://github.com/ryanbr/noop/blob/2a1de7609843b095505274ad6fc811757210be80/docs/PROTOCOL_SENSORS.md)
distinguishes documented layouts from device-validated behavior.

## Tools

- `packages/ble-probe/` — macOS CLI for interactive BLE probing (Swift, CoreBluetooth)
- `scripts/parse-whoop-ble-capture.ts` — PacketLogger `.pklg` capture parser

## References

- APK decompilation: WHOOP Android v5.439.0, decompiled with `jadx --deobf`
- BLE library: Nordic Semiconductor `no.nordicsemi.android.ble` (BleManagerHandler)
- PacketLogger: Xcode Additional Tools, requires Bluetooth logging profile from Apple
