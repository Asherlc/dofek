# WHOOP BLE historical replay investigation

Investigated 2026-10-24 against Dofek commit `ce357ab2b`. This is protocol
research, not an implemented replay feature or a device verification of the
October disconnects. The [protocol reference](whoop-ble-protocol.md) remains
the entry point for framing and existing capture behavior.

## Finding

Stored heart-rate history can be replayed: Dofek's retained capture contains a
complete official-client exchange, including historical records and chunk
acknowledgements. Dofek can already receive and upload supported historical
records, but does not request or coordinate replay. Recovering an arbitrary
missed interval, every beat interval, or high-rate motion is not established.
See the capture evidence and implementation boundaries below.

## Evidence from Dofek's capture

The existing [PacketLogger fixture](../packages/mobile/modules/whoop-ble/Tests/fixtures/imu-activation-capture.tsv)
has 620 ATT rows. Reassembling separately by characteristic handle with the
eight-byte frame header produces 374 complete frames. All header CRC16 and
payload CRC32 checks pass. This is the existing Maverick-format capture;
it does not establish every hardware generation's behavior.

| Capture row | Observed exchange |
| --- | --- |
| [347](../packages/mobile/modules/whoop-ble/Tests/fixtures/imu-activation-capture.tsv#L347) | `GET_DATA_RANGE (0x22)`, parameter `00`. |
| [351](../packages/mobile/modules/whoop-ble/Tests/fixtures/imu-activation-capture.tsv#L351) | `SEND_HISTORICAL_DATA (0x16)`, parameter `00`. |
| [354](../packages/mobile/modules/whoop-ble/Tests/fixtures/imu-activation-capture.tsv#L354) | Metadata packet `0x31`, subtype `1`: history start. |
| [408](../packages/mobile/modules/whoop-ble/Tests/fixtures/imu-activation-capture.tsv#L408), 501, 549, 579, 603 | Metadata subtype `2`: five chunk ends, containing respectively 2, 30, 15, 15, and 9 R18 records since each start. |
| [409](../packages/mobile/modules/whoop-ble/Tests/fixtures/imu-activation-capture.tsv#L409), 502, 550, 580, 604 | `HISTORICAL_DATA_RESULT (0x17)`: `01` followed by the exact eight-byte token from the preceding end. |
| [607](../packages/mobile/modules/whoop-ble/Tests/fixtures/imu-activation-capture.tsv#L607) | Metadata subtype `3`: transfer complete. |
| [612](../packages/mobile/modules/whoop-ble/Tests/fixtures/imu-activation-capture.tsv#L612), 615–617 | Another request, start, end with all-ones token, then `ABORT_HISTORICAL_TRANSMITS (0x14)` with parameter `00`. |

In these frames, the metadata subtype is payload byte 2, and an end token is
payload bytes 13–20 inclusive, after removing the eight-byte header and CRC32
trailer. The first token is `b3 c6 01 00 00 00 00 00`; the corresponding ACK
parameters are `01 b3 c6 01 00 00 00 00 00`. Every one of the five ACKs echoes
the complete token. These offsets describe this fixture only; see the
[captured bytes](../packages/mobile/modules/whoop-ble/Tests/fixtures/imu-activation-capture.tsv#L408).

The exchange delivers 71 historical R18 records spanning
`2026-03-29T15:28:11.429Z` through `15:29:21.429Z`. The request and final chunk
ACK are approximately 1.5 seconds apart. There are no `0x34` historical IMU
frames in the fixture. Its 46 R21 frames occur before the first replay request;
they do not prove recovery of missed high-rate IMU. Among the historical R18
records, 39 declare zero intervals, 30 declare one, and two declare two.
These counts come from the same [fixture](../packages/mobile/modules/whoop-ble/Tests/fixtures/imu-activation-capture.tsv).

For reproduction, feed each handle's ATT values through an independent frame
accumulator, use `8 + payloadLength` as total length, and validate both CRCs
before counting records. The
[frame parser](../packages/mobile/modules/whoop-ble/ios/WhoopBleFrameParser.swift)
and [CRC implementation](../packages/mobile/modules/whoop-ble/ios/WhoopBleFrameParser+CRC.swift)
define those operations. The existing capture and parser/timestamp suites
passed 51 tests during this investigation:

```sh
swift test --package-path packages/mobile/modules/whoop-ble \
  --filter 'WhoopBleFrameParserTests|WhoopBleSampleBufferTimestampTests'
```

## External corroboration and ownership limits

NOOP's versioned research describes page-based range discovery, metadata
boundaries, and an eight-byte token echoed after committing a chunk. Its
transport contract warns that ACK can release device history; it establishes
no per-application history isolation. A time window is not the request
interface. Treat official-app coexistence and remaining history as device-test
questions, not guarantees. See the pinned
[transport contract](https://github.com/ryanbr/noop/blob/fc1df821f3826c73080ed78530635cee9e3aedaf/docs/PROTOCOL_TRANSPORT.md#history-sequencing-and-storage-ownership).

An independent WHOOP 5 owner reports 38,304 historical records and 516 ACKs
after leaving the strap unsynced for approximately 15 hours. The retained
capture covers approximately 10.3 hours and contains R18/R26 records, supporting
biometric replay but not proving high-rate motion retention. See the
[owner's capture analysis](https://github.com/ryanbr/noop/issues/103#issuecomment-4942931874).

Consequently, a Dofek capture gap does not establish that its samples are still
available on the strap. Another client's successful sync may advance shared
history. Neither source demonstrates a safe arbitrary rewind after that;
`SET_READ_POINTER` is outside the normal replay flow in the
[sensitive-command reference](https://github.com/ryanbr/noop/blob/fc1df821f3826c73080ed78530635cee9e3aedaf/docs/PROTOCOL_COMMANDS.md#service-and-sensitive-operations).

## Current Dofek boundaries

| Area | What exists and what replay still needs |
| --- | --- |
| Connection | [Native reconnection](../packages/mobile/modules/whoop-ble/ios/WhoopBleModule+ConnectionManagerDelegate.swift) resumes live activation. There is no replay state machine or chunk cursor. |
| Command encoding | [buildCommandData](../packages/mobile/modules/whoop-ble/ios/WhoopBleFrameParser.swift) always appends `01 01 00 00 00`. Replay needs command-specific parameters, request correlation, response validation, and metadata handling. Passing a new opcode to the existing builder would produce the wrong request. |
| Supported historical records | [extractRealtimeData](../packages/mobile/modules/whoop-ble/ios/WhoopBleFrameParser.swift) accepts `0x2F` R18, retaining BPM, the first interval, quaternion, and selected bytes. It drops additional intervals; it is not a lossless historical decoder. |
| Motion | The same [parser](../packages/mobile/modules/whoop-ble/ios/WhoopBleFrameParser.swift) has synthetic-test support for `0x34`, and capture-backed R21 decoding under `0x2B`. A `0x2F` R21 is not dispatched to that decoder. No retained fixture proves dedicated `0x34` layout or missed high-rate motion recovery. |
| Buffer and durability | [WhoopBleSampleBuffer](../packages/mobile/modules/whoop-ble/ios/WhoopBleSampleBuffer.swift) stores memory-only queues capped at 86,400 realtime and 500,000 IMU samples, evicting oldest arrivals on overflow. A fast history burst can outrun upload. Native drain confirmation only removes a successfully uploaded batch; it is not a strap ACK or durable raw-chunk commit. |
| Upload | The [existing uploader](../packages/mobile/lib/whoop-ble-buffer-drain.ts) sends supported historical records through the live-data routes. [Validation](../packages/server/src/routers/sample-validation.ts) does not impose an age cutoff, but [realtime storage](../packages/server/src/repositories/whoop-ble-sync-repository.ts) retains BPM, interval, and quaternion channels rather than every received raw byte. |
| Attribution | The [IMU repository](../packages/server/src/repositories/inertial-measurement-unit-sync-repository.ts) currently ignores `deviceType` and labels WHOOP uploads `apple_motion`/`api`. This needs correction before claiming accurate WHOOP motion provenance. |
| Repeated records | [Realtime external IDs](../packages/server/src/repositories/whoop-ble-sync-repository.ts) include device, channel, and timestamp. The [capture regression](../packages/mobile/modules/whoop-ble/Tests/WhoopBleSampleBufferTimestampTests.swift) preserves live `.000` and history `.430` observations separately. A replay progress token must retain device semantics rather than treating a formatted timestamp as a cursor. |

The upstream sensor reference also qualifies R-R units and dedicated IMU
layouts by version. Existing Dofek decoding must be checked against captured
device/firmware output before promising complete beat or motion recovery;
see [R18](https://github.com/ryanbr/noop/blob/fc1df821f3826c73080ed78530635cee9e3aedaf/docs/PROTOCOL_SENSORS.md#r18-biometric-summary)
and [dedicated IMU](https://github.com/ryanbr/noop/blob/fc1df821f3826c73080ed78530635cee9e3aedaf/docs/PROTOCOL_SENSORS.md#dedicated-imu-stream-types-51-and-52).

## Existing implementations assessed

- [NOOP](https://github.com/ryanbr/noop) provides current Swift research and
  hardware reports. Its [license](https://github.com/ryanbr/noop/blob/fc1df821f3826c73080ed78530635cee9e3aedaf/LICENSE)
  restricts original code/documentation to noncommercial use while explicitly
  permitting reuse of wire facts. Do not copy its implementation into the
  unrestricted MIT module.
- [whoop-rs](https://github.com/eugenehp/whoop-rs) is Apache-2.0, but its README
  explicitly reports no hardware validation. A second parser and Rust runtime
  would not resolve the device-evidence gap.
- [whoop4-ble](https://github.com/andyguzmaneth/whoop4-ble) is MIT and targets
  WHOOP 4. Its framing and ACK construction are not a replacement for the
  retained Maverick exchange.

## Recommended next investigation

First record the current strap's model/firmware and a controlled disconnect
and official-app sync. Compare available history and received records before
and after that sync. Capture the complete request, metadata, and response
exchange without introducing a second client that sends trim ACKs. This tests
whether Dofek can recover a missed interval while the official app remains
the history consumer; the ownership uncertainty is described above.

If that establishes a useful recovery window, scope a native controller using
the existing parser, command-specific payloads, and durable retention of each
complete raw chunk before ACK. Local storage supports offline capture but
adds queue/account-erasure work; waiting for a durable server receipt ties
progress to network/background execution. Neither alone resolves coexistence
with WHOOP's own consumer. Do not enable automatic ACKs until that behavior is
verified on the target device.

Before release, cover interruption mid-chunk, repeated END/records, unknown
layouts, storage failure, overflow/backpressure, account erasure, and official
app coexistence. Use executable storage tests for retained/uploaded data and a
physical device for BLE recovery, consistent with the module's
[testing boundaries](../packages/mobile/modules/whoop-ble/README.md).
