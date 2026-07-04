# Zepp Raw Sensor Streams Design

## Goal

Capture every useful raw or close-to-raw measurement the Zepp OS watch app can provide, while keeping computed watch summaries out of raw storage. The first implementation should extend the existing Zepp OS app and import path so session exports can include timestamped health measurements alongside IMU data.

## Scope

In scope:

- Continue recording accelerometer and optional gyroscope samples in the Zepp session file.
- Add timestamped heart-rate samples from Zepp OS continuous heart-rate measurement. The Zepp OS `HeartRate` API exposes `onCurrentChange()` for continuous measurement and `getCurrent()` for the callback value. Source: https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/HeartRate/
- Add successful blood-oxygen measurements from `BloodOxygen.start()` / `onChange()` / `getCurrent()`. Expected measurement states such as not wearing, invalid signal, timeout, and measurement failure must be treated as non-fatal collection outcomes. Source: https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/BloodOxygen/
- Add timestamped stress readings only when the API returns a measured current value and time. Source: https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/Stress/
- Add body-temperature measurements from current or daily measured values when they can be represented as timestamped samples; Zepp documents `getToday()` as five-minute body surface temperature measurements, with missing values represented by `-1000`. Source: https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/BodyTemperature/
- Normalize imported timestamped samples into the existing metric-stream pipeline.

Out of scope:

- Screen status, light level, battery, wear state, weather, and other device context. These are not health metrics we need for this pass.
- Computed Zepp summaries as raw streams: steps, calories, distance, stand hours, PAI, fat-burning minutes, sleep score, sleep totals, resting HR, max HR, and daily/hourly averages.
- New UI surfaces beyond existing status text needed to show recording/sync errors.
- Long-term compatibility aliases or dual import paths. The imported format should have one canonical decoder.

## Data Boundary

The raw stream should contain measurements that came directly from a sensor API with a timestamp or an event time:

- `heart_rate`: beats per minute.
- `blood_oxygen`: percent SpO2 for successful measurements.
- `stress`: Zepp stress value when a current measured timestamp is available.
- `body_temperature`: Celsius body-surface temperature when a timestamp can be reconstructed from Zepp's documented sample cadence.
- `accelerometer` and `gyroscope`: existing IMU channels.

Computed Zepp values may still be useful for separate daily summary imports later, but they must not be published as `metric_stream` rows. If a value is an aggregate, score, target progress, or watch-derived summary, it belongs in an explicit summary path or not at all.

## File Format

Extend the Zepp binary session format to a v2 structure with typed chunks:

- Header: keep current session metadata and add a version bump.
- IMU chunk: current accel/gyro records, unchanged except for the chunk type wrapper.
- Health chunk: low-rate records with `t_ms`, channel id, value, and optional status code.

The decoder must continue to decode existing v1 IMU-only files. V2 files should decode into one session object containing IMU samples and health samples. The server import path should publish health samples to metric stream and retain the raw session payload as it does today.

## Resilience

Blood oxygen failures are expected. The collector should:

- Record successful SpO2 values.
- Ignore or record status-only failure outcomes without throwing.
- Never stop IMU or HR logging because SpO2 returns not-wearing, invalid-signal, timeout, invalid, high, low, or generic failure status.
- Surface only repeated unexpected exceptions in app status/logging.

Other sensor callbacks should follow the same rule: unavailable or unsupported sensor APIs disable that channel only. They should not stop the whole recording session.

## Tests

Use TDD for implementation:

- Unit-test the Zepp v2 encoder/decoder with mixed IMU and health chunks.
- Unit-test v1 decoder compatibility.
- Unit-test raw/computed filtering so computed values are not emitted as metric-stream samples.
- Unit-test SpO2 failure handling so failure states do not throw or stop collection.
- Unit-test server import publishing for HR/SpO2/stress/body-temperature metric-stream rows.

## Open Decisions

- Exact v2 binary chunk ids and record layout should be chosen during the implementation plan.
- Stress and body-temperature inclusion depends on whether current Zepp API values can be represented with credible timestamps. If not, omit that channel rather than storing ambiguous data.
