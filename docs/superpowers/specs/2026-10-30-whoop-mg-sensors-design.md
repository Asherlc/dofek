# WHOOP MG background sensor capture

Status: approved by the user on 2026-10-30; implementation committed.
The [hosted iOS native build](https://github.com/Asherlc/dofek/actions/runs/41155587629/job/124402172401) passed. Local Expo generation was deferred
pending Infisical authentication at the user's request. Physical MG/overnight
validation remains pending.

## Intent and agreed scope

Collect the additional background sensor data directly from the user's WHOOP
MG through the existing iOS BLE connection, retain it durably, and make it
inspectable in Dofek. The user selected the full pipeline approach and then
explicitly excluded ECG. Existing accelerometer, gyroscope, heart-rate and
beat-interval capture remain part of the product.

New scope is skin temperature, available optical records, and their associated
raw motion counters, thermal and status fields. Availability is established by
received records, not by the presence of hardware or a successful command ACK.
ECG commands, ECG waveforms, a recording flow, new clinical interpretations and
computed SpO2/respiratory values are outside this change. The latter require
validated interpretation beyond possessing optical samples; see the
[versioned sensor reference][sensors].

## Approaches

1. **Extend the existing pipeline. Selected by the user.** Keep the native
   parser, SQLite queue, background uploader and existing metric-stream
   infrastructure. Add complete sensor-record retention and server decoding for
   the added fields. This delivers capture, storage and inspection together.
2. **Capture-only investigation. Not selected.** Retain packets and defer all
   decoding and presentation until a device investigation has concluded. This
   offers earlier packet access but does not deliver the requested measurements.

Replacing the BLE stack with another app's implementation is not proposed. The
current native delivery system already owns reconnect, account erasure and
durable acknowledgments; see the [module contract][module]. The external NOOP
implementation has a [noncommercial license][license]; use documented protocol
facts as references rather than importing its implementation or fixtures.

## Current implementation and evidence

- The native [frame parser][parser] already reassembles format-1 frames and
  checks both CRCs. It extracts R21 IMU and realtime/R18 data.
- The native [serializer][serializer] emits `opticalRawHex`, but the
  [server repository][repository] does not store that field. This is not a
  working optical archive. Some preserved bytes are merely surrounding packet
  data, not identified optical channels.
- The [durable upload design][durability] and [module contract][module] establish
  the existing queue, ownership and background delivery responsibilities.
- The external [protocol scope][scope] distinguishes earlier device observations
  from a firmware-version reference. Its descriptions do not establish that
  every documented record is emitted by the user's firmware.
- The existing [capture fixture][capture] contains 71 complete 124-byte R18
  frames passing header CRC16 and payload CRC32 checks. The candidate thermal
  word at full-frame offset 73 ranges from 3216 to 3222, consistent with the
  external skin-temperature encoding. This supports a reproducible field map,
  not independent calibration or confirmed model/firmware identity. Additional
  optical layouts still need capture evidence.

The research baseline is NOOP commit
`2a1de7609843b095505274ad6fc811757210be80`. Further protocol research must identify
the firmware, packet provenance and validation limits beside each added map.

## Capture and interpretation contract

Read device identity and firmware through device information or verified hello
responses. Retain the actual values; unknown model information stays unknown.
Do not assume MG from its shared BLE service alone; see the
[device profile][profile].

Retain complete CRC-valid sensor records, including their layout selectors,
device clock words, reception time and device identity. Preserve unrecognized
sensor layouts opaquely. Invalid frames remain rejected by the frame parser.
This is the permanent canonical representation for the new sensor streams,
not temporary diagnostic logging or an additional shadow table.

Decode the new fields on the server from that representation. The target maps
are R18 temperature and associated raw fields, R20 optical blocks, and the
documented R22/R26 variants where evidence supports their layout. Optical slots
keep their source/configuration metadata; unknown channels retain neutral names.
The [sensor reference][sensors] distinguishes counts from capacities and does
not establish universal wavelength identities or optical calibration.

Preserve source clock words and observed reception times separately. Store each
raw record with its reception time as `recordedAt`; raw-record range queries
therefore describe observation time. Decoded measurement queries use verified
source timestamps and return measurement time explicitly. Their time-range
predicate must target that source time, including when an older reading arrives
in a later offload. A raw record's observation timestamp must not masquerade as
the measurement time. Records with unresolved source clocks remain raw-only.
Unknown sample spacing stays unknown: optical arrays can be displayed against
sample index until device evidence establishes elapsed time. Missing values,
unsupported layouts and invalid counts must not become measured zeros.

Only expose Celsius when capture evidence supports the encoding on the observed
layout/firmware. Otherwise retain the thermal value in raw units with that
qualification. Do not copy the WHOOP 4 temperature conversion into MG decoding.
Never compute SpO2 percentages, respiratory rate, sleep stages or daily steps
from unvalidated fields. Preserve counters as counters and status codes as codes.

Acquire the records using the current connection and documented collection
controls. A new control requires evidence of its generation-specific payload,
response and emitted records. Do not silently rewrite persistent feature flags,
sensor gains or firmware configuration to force a preferred record version.
Keep existing IMU streaming and reconnect intent intact.

## Durable delivery and storage

Add a sensor-record stream to the existing native SQLite outbox and background
uploader. Commit each captured record before acknowledging any historical chunk
that could allow the strap to forget it. The upstream
[transport reference][transport] documents that history ownership boundary.

Use one authenticated sensor-record ingestion procedure, with explicit schema,
bounded frame and batch lengths, CRC validation and device metadata. Assign a
capture identity once in the native queue and retain it across reservations and
retries. Queue acknowledgments remove the exact submitted reservation only.
Account changes, sign-out and erasure apply to the new stream exactly as to the
existing streams. A failure in one stream must not block unrelated delivery.

Store new sensor records in the current Redpanda/R2/ClickHouse metric-stream
path using a provider-agnostic record channel and metadata for the original
bytes and provenance. Keep raw bytes canonical; derived readings are query-time
projections, not new Postgres daily metrics or duplicated decoded storage.
The [metric-stream contract][events] already permits metadata-bearing records.
Do not add a separate service, broker, storage dependency or analytics read model.

Choose batching limits against the existing API's body limit before coding:
packet counts alone do not bound JSON byte size. Oversized or malformed inputs
fail with specific errors rather than silent truncation or acknowledgment.

## User-visible behavior

Add a compact sensor-detail section to the existing WHOOP connection/provider
detail surfaces. Show skin temperature, latest capture time and available sensor
streams. Expand details to inspect raw optical values, thermal values, counters
and status fields with source identity and verified units.

Both web and mobile consume the same protected server contract. Mobile owns
the physical BLE connection; web inspects uploaded data. No remote command
queue or browser BLE acquisition is added. Use existing chart components, with
server-prepared values and axes. Preserve cached data on refetch errors and
show actionable server errors. No ECG controls or ECG display are added.

Once verified, BLE skin temperature also feeds the existing health/body
temperature views through server source resolution, with WHOOP BLE attribution.
Project it from the same retained sensor records without adding a second stored
daily value. Do not sum, average together or silently replace overlapping API
observations; apply the existing source-selection contract. Keep skin and core
body temperature distinct.

Status distinguishes captured, queued, uploaded and decoded. Connected or
ACKed does not mean sensor data is available. If a requested record has never
arrived, report that observation without claiming a hardware failure or
suggesting an unsupported remedy.

## Validation and completion boundaries

Use tests first for changed behavior. Native tests exercise fragmented frames,
CRC/length validation, queue reopening, byte bounds, exact acknowledgments,
independent streams and account erasure. Server tests cover raw-record retention,
provenance, decoding and retry identity. Execute storage/read-query tests against
the real database engine. Both clients need focused rendering/interaction tests
and visual checks for available, missing, raw-only and error states.

New protocol interpretation requires reproducible captures as mandated by the
[native agent guide][native-guide]. Constructed fixtures verify arithmetic and
malformed-input handling but must not be described as device evidence. Obtain
existing authorized captures or perform a physical MG capture before declaring
a field verified. If such evidence is unavailable, report the exact validation
gap and request the required device observation; do not invent offsets or
silently substitute another data source.

Run native Swift tests, affected TypeScript tests/typechecks, applicable lint,
native bridge checks, the Swift export checks and an iOS build. Physical-device
validation must check overnight availability, disconnect/reconnect, delayed
upload and measured units; Simulator does not establish BLE operation, as noted
in the [module contract][module]. A new native build is required for the bridge
changes under [Expo's native development workflow][expo].

## Builder decisions and review checkpoints

The builder chooses small decoder modules, exact schema/type names, bounded
batch sizes and existing chart composition. Preserve existing public APIs and
sample semantics unless new capture evidence identifies a separately scoped
correction. No new dependencies or environment variables are anticipated.

Review protocol evidence before adding each field map; review durability and
ownership before connecting capture to upload; review the shared response and
both clients before completion. Implementation starts after design approval.

[sensors]: https://github.com/ryanbr/noop/blob/2a1de7609843b095505274ad6fc811757210be80/docs/PROTOCOL_SENSORS.md
[scope]: https://github.com/ryanbr/noop/blob/2a1de7609843b095505274ad6fc811757210be80/docs/PROTOCOL.md
[profile]: https://github.com/ryanbr/noop/blob/2a1de7609843b095505274ad6fc811757210be80/docs/PROTOCOL_WHOOP5.md
[transport]: https://github.com/ryanbr/noop/blob/2a1de7609843b095505274ad6fc811757210be80/docs/PROTOCOL_TRANSPORT.md
[license]: https://github.com/ryanbr/noop/blob/2a1de7609843b095505274ad6fc811757210be80/LICENSE
[module]: ../../../packages/mobile/modules/whoop-ble/README.md
[native-guide]: ../../../packages/mobile/modules/whoop-ble/AGENTS.md
[parser]: ../../../packages/mobile/modules/whoop-ble/ios/WhoopBleFrameParser.swift
[serializer]: ../../../packages/mobile/modules/whoop-ble/ios/WhoopBleSampleSerializer.swift
[repository]: ../../../packages/server/src/repositories/whoop-ble-sync-repository.ts
[durability]: ./2026-10-28-whoop-durable-upload-design.md
[events]: ../../../src/metric-stream/events.ts
[capture]: ../../../packages/mobile/modules/whoop-ble/Tests/fixtures/imu-activation-capture.tsv
[expo]: https://docs.expo.dev/workflow/customizing/
