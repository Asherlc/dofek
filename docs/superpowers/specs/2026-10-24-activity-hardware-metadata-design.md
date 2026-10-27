# Activity hardware metadata across providers

## Selected scope

The user selected **show hardware metadata and improve labels**. Retain reported
recording-device and sensor facts across providers and expose them on activity
details on web and iOS. Metric-source labels may become more descriptive.

Do not change source IDs, source ordering, default selections, saved priorities,
activity origin selection, deduplication, or computed metric values. In particular,
do not rewrite existing `source_name`, stream `device_id`, or `measurement_kind`
merely to improve presentation: those fields participate in analytical selection.

## Evidence and semantics

Distinguish the importing provider, recording app/device, and physical sensors.
Reported hardware presence does not prove the origin of each individual sample.
Use recorder names for recording labels; identify a physical sensor as a metric
source only when the source explicitly attributes that metric to that device.
Unknown fields stay unknown. Preserve coarse equipment categories as categories.

- FIT `file_id` identifies the creator; optional `device_info` describes recording
  hardware and accessories, with incomplete fields. See [Garmin Activity files](https://developer.garmin.com/fit/articles/file-types/activity.html).
- Wahoo delivers activity FIT files through its [Cloud API](https://cloud-api.wahooligan.com/#get-a-workout-summary), so the shared importer covers Wahoo and Garmin.
- Strava supplies recording `device_name` and power-meter-versus-estimate
  `device_watts`, rather than a paired-sensor inventory. See the [official schema](https://developers.strava.com/swagger/activity.json).
- Polar supplies exercise device/model and device ID ([AccessLink](https://www.polar.com/accesslink-api/#exercises)).
- HealthKit source app and optional hardware are separate concepts ([HKDevice](https://developer.apple.com/documentation/healthkit/hkdevice)).
- Peloton device category/platform, Ride with GPS source, and Zepp source/app
  fields already present in raw activity data can supply qualified provenance.

## Architecture

Use one shared response contract in `@dofek/providers/activity-hardware`, with
server-side normalization of raw observations and provider payloads. Hardware
items identify their provider/member activity, role (`recorder`, `creator`,
`sensor`, `source`, `category`, or `unknown`), reported label/model/manufacturer, available identifiers, connection,
firmware, and battery facts. A FIT file creator is qualified separately from an
original recording device, since exporting platforms can create activity files
([FIT Activity specification](https://developer.garmin.com/fit/articles/file-types/activity.html)).
Include explicit measured/estimated power evidence
when a provider supplies it, without changing stored sample classification.
Source apps and coarse equipment categories retain qualified roles and do not
become original-recorder assertions.

Keep existing API metadata in its existing canonical activity `raw` payload.
Preserve missing Polar and HealthKit hardware fields there. Do not duplicate that
payload into another table. Standalone BLE HR uploads should retain their known
peripheral name as raw sample metadata alongside the existing UUID, without
changing the UUID/source ID or adding a speculative device registry.

FIT device messages currently have no canonical storage. Add the small
`fitness.activity_device_observation` child table: `activity_id` (cascade FK),
`sequence` (nonnegative, unique within activity), `message_type`, and `raw` JSON.
Each original `file_id`/`device_info` message is retained, including repeated
battery/firmware observations. Ownership and provider come from its activity.
No global device-identity registry or write-time cross-provider merging.

Extend the bounded native protocol: metadata includes `fileId` raw object or null;
the second pass emits `devices` batches containing raw `device_info` messages.
The TypeScript consumer adds required `onDeviceInfoBatch(messages)`; preserve
250-message/512-KiB limits, acknowledgements, and bounded spool/replay. The final
message count includes streamed device messages. Activity import replaces the
owned activity's device observations on a successful replacement import. Weight
activity behavior remains governed by its existing importer.

The hardware repository reads owned, visible member activities and their raw
device observations from Postgres. Reduce repeated observations at read time,
preserving earlier non-null identity fields when later messages report only
battery status. Use the official existing FIT SDK profile for enum labels, rather
than handwritten manufacturer/product/device-type tables. No new ClickHouse
read model, CDC mirror, runtime catalog request, or external service is needed.

Add `activity.hardware` and label enrichment around the existing metric-source
response. Resolve activity IDs/access windows through the existing activity
repository; enforce user ownership and activity visibility again in raw-data
queries. Source IDs/order/defaults must remain byte-for-byte unchanged.

## Presentation

Both detail screens show a concise **Devices and sensors** section with recording
hardware, observed sensors, source attribution, and qualified power evidence.
Put identifiers, firmware and battery details behind accessible disclosure.
Do not label an observed sensor as the proven source of every sample. Show
reported uncertainty and preserve server errors and cached content on refetch.

## Delivery and validation

Cover native streaming, raw observation persistence/reimport, ownership,
provider normalization, source-label-only changes, and both UIs with tests first.
Database behavior uses executable Postgres/ClickHouse integration tests as
appropriate; native changes use CMake/CTest. Add representative stories and
inspect both component previews. Use focused suites and required build/type/lint
checks; do not repeat the unrelated full-repository run from the thumbnail task.

Existing data improves where metadata is already retained. Newly retained FIT,
Polar, HealthKit, and BLE fields appear after reimport/resync/new capture. Do not
launch historical production reimports as part of this implementation.
