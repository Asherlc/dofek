# Zepp workout capture: capabilities and device audit

## What each path can provide

This matrix separates documented platform capabilities from Dofek implementation and live validation. Research date: 2026-09-06. A passing local test is not evidence of continuous capture on a physical watch.

| Path | Data and automation | Limitation / validation status |
|---|---|---|
| Dofek cloud provider | Daily health history and workout list, without opening a workout data page | Current private client does not retrieve detailed workout tracks; see [client](../packages/zepp-client/src/client.ts). |
| Official partner workout API | `GET /users/-/sportDetail?trackId=…&device=…` returns detailed tracks including location and physiological/workout measurements | Requires a partner OAuth grant with `sportDetail` scope. A private Zepp app token is not that grant. Access is not validated. [Official API](https://github.com/zepp-health/rest-api/blob/master/api-doc.html), [enrollment](https://github.com/zepp-health/rest-api/wiki). |
| Normal watch app: workout history | Completed workout start time and duration, reconciled when collection runs | `Workout.getHistory()` does not expose full tracks or IMU history. [Workout API](https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/Workout/). |
| Workout Extension | Live `getSportData()` fields plus continuous HR while focused | Installed/enabled through each workout type's data pages. Supporting all subtypes does not enable the page globally. Callbacks and timers pause when unfocused. [Extension lifecycle/setup](https://docs.zepp.com/docs/guides/workout-extension/quick-start/). |
| Normal watch app: IMU | Independently timestamped acceleration and angular velocity events; bounded authenticated uploads | Deliberately started capture. Numeric sampling rates and uninterrupted screen-off capture are not guaranteed. [Accelerometer](https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/Accelerometer/), [Gyroscope](https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/Gyroscope/), [wake relaunch](https://docs.zepp.com/docs/reference/device-app-api/newAPI/display/setWakeUpRelaunch/). |
| Continuous App Service | Low-power health sampling and workout-history reconciliation | Cannot use Accelerometer, Gyroscope, Geolocation or JavaScript timers; therefore does not provide background raw IMU. [Service restrictions](https://docs.zepp.com/docs/guides/framework/device/app-service/). |
| Official sensor-data API | Documented tagged sensor-data archives, including ACC and PPG | No demonstrated entitlement or coverage of ordinary workouts; not evidence of full gyro or automatic workout IMU access. [Sensor API](https://github.com/zepp-health/rest-api/blob/master/api-sensor-doc.html). |

No documented system event currently establishes an automatic launch hook for every workout. The published list covers other events; absence from that list is a documentation limitation, not proof that private firmware functionality cannot exist. [System events](https://docs.zepp.com/docs/guides/framework/device/system-event/).

The comprehensive supported direction is detailed completed-workout retrieval plus separately validated sensor capture. Neither an extension page nor cloud workout summaries alone establish complete IMU coverage. Additional watch APIs exist for location, altitude and heading, but are not currently captured by Dofek's IMU recorder. [Geolocation](https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/Geolocation/), [Barometer](https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/Barometer/), [Compass](https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/Compass/).

## Account routing and delivery

The phone Side Service uses the Dofek server URL and companion bearer token saved by pairing or login. The server resolves that token to a Dofek user. Before sending a recording's first IMU batch, the watch persists a binding returned by authenticated `/api/ingest/zos-imu/connection`. Each upload asserts that account identity; the server compares it with the token's user, and Side Service rejects a changed destination URL. The asserted identity cannot override token authorization. Bindings survive retries and watch-app restarts; reconnecting the original account with a fresh token is allowed. The normal app and independently installed Workout Extension each need their own connection setup. See [Side Service](../packages/zepp/app-side/index.ts), [token validation](../packages/server/src/companion/token-repository.ts), [IMU ingestion](../packages/server/src/routes/ingest-zos-imu.ts), and [journal](../packages/zepp/src/imu-pending-files.ts).

IMU upload uses watch `request` → phone Side Service Fetch → `/api/ingest/zos-imu`. Each batch contains an intact binary header and at most 128 records, with the original file start time and record offset. The server authenticates, decodes, and awaits the canonical metric-stream publisher before acknowledging. Retry identities retain file start, record index and sensor so same-millisecond independent events remain distinct. Vector metadata preserves raw units (acceleration cm/s², angular velocity deg/s), format version and frequency mode. The version distinguishes independently recorded v2 vectors from historical v1 paired samples. See [upload](../packages/zepp/src/imu-upload.ts), [route](../packages/server/src/routes/ingest-zos-imu.ts), [ZML](https://github.com/zepp-health/zml), and [Side Service Fetch](https://docs.zepp.com/docs/reference/side-service-api/fetch/).

The file-transfer API's `transferred` event establishes receipt on the phone, not ingestion by Dofek. Its documented file object exposes file metadata and events, not an API for reading the received file's bytes in Side Service. Do not infer server delivery from the old exported-path status. [TransferFile](https://docs.zepp.com/docs/reference/device-app-api/newAPI/transfer-file/TransferFile/), [Side Service transfer](https://docs.zepp.com/docs/reference/side-service-api/transfer-file/).

## Cloud-access evidence and next validation

The local environment had no configured Zepp partner grant. Infisical export failed because the CLI was not logged in; this does **not** establish that production secrets are absent. Detailed partner access remains unverified. Enrollment requires organizational review; do not characterize registration as closed without current first-party evidence. [Partner requirements](https://github.com/zepp-health/rest-api/wiki).

1. Restore the existing Infisical login and inspect credential **names/presence only**, without printing secret values.
2. If an approved partner grant exists, use an authorized account to retrieve one workout list and its matching detail. Record HTTP status, scope, field names, sample counts, time bounds and device identity; omit personal routes and credentials from logs.
3. If no grant exists, obtain organizational partner access or establish an observed, authorized private-detail endpoint contract before implementing retrieval. Do not substitute a private app token into the partner API or invent an endpoint.
4. Compare detail coverage against the workout visible in Zepp. Missing IMU must remain recorded as missing, not inferred from calculated workout metrics.

## Physical-watch acceptance audit

Record watch model, firmware, Zepp app version, phone OS, app IDs/build versions, API level, sensor modes and gyro availability. Test both packages separately with a known test account. Preserve raw files until record counts and server delivery are verified. Simulator values cannot establish hardware sampling behavior; frequency modes are qualitative in the sensor API documentation linked above.

| Scenario | Evidence to collect |
|---|---|
| Foreground baseline | At least one minute of each enabled sensor; separate event counts, timestamp gaps and observed rates. Continuous HR must originate from `onCurrentChange`/`getCurrent`, not `getLast`. [HR API](https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/HeartRate/). |
| Extension focus | Switch to another workout page, return, pause/resume the workout, then finish. Record gaps and lifecycle transitions rather than assuming callback continuity. |
| Screen off / AOD / wake | Repeat for normal app and extension. Compare event timelines before/after each transition; record whether the process exits and whether pending uploads survive. |
| Rotation | Capture beyond one file boundary. Verify each event's absolute time equals header start plus offset, without boundary shifts, overwritten gyro events or lost final records. |
| Disconnect / server failure | Disable phone connectivity and exercise an ingestion failure on a test environment. Confirm no success acknowledgement, files remain recoverable, and retries produce identical event identities. |
| Process restart | Restart the watch app with pending files, then retry. Confirm it refuses to overwrite unacknowledged slots and drains them after connectivity returns. |
| Account routing | Pair normal app and extension separately. Verify a revoked token fails and ingestion derives the user from the active valid token. Do not route test data into another person's account. |

For each scenario report expected behavior, observed behavior, raw record counts, acknowledged batch counts, server event counts after retry deduplication by event ID, largest per-sensor gap, and pass/fail/untested. The existing `analytics.deduped_sensor` is scalar-only and does not expose these vector channels; its user/channel/timestamp grain must not be reused for full-rate IMU because it would collapse same-millisecond records. Raw storage acceptance tests retain the distinct record IDs, vectors and units; dedicated IMU analytics remain unimplemented. See [scalar channel selection](../analytics/models/staging/sensor_scalar_sample.sql), [scalar deduplication](../analytics/models/read_models/deduped_sensor.sql), and [sink storage tests](../src/metric-stream/clickhouse-sink.integration.test.ts). Do not report “all workouts” or “continuous IMU” until the corresponding physical scenarios demonstrate it.

## Remaining acceptance gates

- Live partner detailed-workout access: **unverified** (credentials/access prerequisite).
- Physical watch capture and lifecycle matrix: **untested** (watch interaction required).
- Store submission and hardware installation: **not performed** by this code investigation.
