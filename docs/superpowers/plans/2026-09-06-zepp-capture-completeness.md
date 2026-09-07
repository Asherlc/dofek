# Zepp capture completeness implementation plan

> Execute the approved research recommendation using the subagent-driven-development workflow, with review after each independently testable change.

The user approved combining detailed completed-workout retrieval with a validated raw-sensor recording path. Work stays on the existing branch. Hardware validation and partner access must be reported as unverified until demonstrated; no simulated result establishes device support.

## Work and review checkpoints

- [ ] Validate live detailed-workout access: prerequisite audit completed, but Infisical is not authenticated and no approved partner grant was available locally. The [official partner API](https://github.com/zepp-health/rest-api/wiki) requires separate approval; do not treat private app credentials as partner credentials.
- [x] Reproduce IMU timestamp and independent-gyro capture gaps with failing tests; repair the recording contract and verify encoder/decoder interoperability.
- [x] Complete authenticated IMU delivery using supported Zepp transport and the existing metric-stream ingestion architecture. Verify account isolation, durable acknowledgements, malformed input, and retry identity before marking uploads successful.
- [x] Replace stale workout heart-rate polling with the documented [continuous measurement API](https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/HeartRate/), with lifecycle tests.
- [x] Add a source-backed capability matrix and hardware audit procedure covering page focus, screen-off/AOD, workout pause/resume, file rotation, and phone disconnection. Record measurements only when actually observed.
- [x] Review all changes and run required checks: 320 unit tests, source lint, root/server/web/Zepp typechecks and both Zepp builds passed. The user approved committing and pushing on 2026-09-07 with the local database-dependent checks blocked by OOM; hosted validation remains pending.

## Evidence and constraints

The initial audit found that the phone receiver recorded the transferred binary path without uploading its contents, rotation changed the header's start without rebasing samples, and gyroscope callbacks overwrote a cached reading. Regression tests preceded those fixes. Independent review also found that the existing ClickHouse sink dropped vectors and metadata; the mapper now preserves the existing schema's fields. The new real-ClickHouse regression passed, but the broader suite and analytics lint remain blocked by local ClickHouse OOM/restarts. See the [incident record](../../production-incident-baseline.md#2026-09-06--local-zepp-validation-blocked-by-docker-network-and-memory-exhaustion).

Zepp [background App Services](https://docs.zepp.com/docs/guides/framework/device/app-service/) prohibit accelerometer, gyroscope, and geolocation. [Workout Extensions](https://docs.zepp.com/docs/guides/workout-extension/quick-start/#life-cycle) pause callbacks when unfocused. Changes must not claim to overcome these platform restrictions.
