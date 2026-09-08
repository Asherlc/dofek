# Zepp capture completeness implementation plan

> Execute the approved research recommendation using the subagent-driven-development workflow, with review after each independently testable change.

The user approved combining detailed completed-workout retrieval with a validated raw-sensor recording path. Work stays on the existing branch. Hardware validation and partner access must be reported as unverified until demonstrated; no simulated result establishes device support.

## Work and review checkpoints

- [ ] Validate live detailed-workout access: prerequisite audit completed, but Infisical is not authenticated and no approved partner grant was available locally. The [official partner API](https://github.com/zepp-health/rest-api/wiki) requires separate approval; do not treat private app credentials as partner credentials.
- [x] Reproduce IMU timestamp and independent-gyro capture gaps with failing tests; repair the recording contract and verify encoder/decoder interoperability.
- [x] Complete authenticated IMU delivery using supported Zepp transport and the existing metric-stream ingestion architecture. Verify account isolation, durable acknowledgements, malformed input, and retry identity before marking uploads successful.
- [x] Replace stale workout heart-rate polling with the documented [continuous measurement API](https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/HeartRate/), with lifecycle tests.
- [x] Add a source-backed capability matrix and hardware audit procedure covering page focus, screen-off/AOD, workout pause/resume, file rotation, and phone disconnection. Record measurements only when actually observed.
- [x] Review all changes and run required checks: 658 Zepp tests, 119 focused ingestion/storage tests, source lint, root/server/web/Zepp typechecks and both Zepp builds passed. The user approved committing and pushing on 2026-09-07 with the local database-dependent checks blocked by OOM; hosted validation remains pending.

## Evidence and constraints

### Approved integration update (2026-09-07)

The first implementation was committed as `1206063` and pushed to draft PR #2676. Integrating current `main` exposed overlapping motion delivery work: both watch packages now share a durable watch chunk queue, phone outbox, binary backup transfer manifest and display lease. The user explicitly approved preserving that implementation and adding independent vectors and account binding to it, replacing this branch's binary HTTP transport. Existing queue formats must remain readable; records with no provable original account must remain recoverable without being assigned to a new login. See the [shared controller](../../../packages/zepp/src/imu-session-controller.ts), [phone queue](../../../packages/zepp/src/phone-imu-outbox.ts) and [capture audit](../../zepp-capture-audit.md).

- [x] Watch checkpoint: preserve shared lifecycle/backup behavior, tagged vectors, exact rotation clocks and collision-free chunk identities; verify historical queued payload decoding.
- [x] Phone checkpoint: resolve the stable account during connection verification, embed it in new watch records, preserve offline queueing without stored bearer tokens, require explicit assignment for unbound historical records and reject changed destinations.
- [x] Server checkpoint: one envelope ingestion route, token-owner assertion, independent vector timestamps/units/identity, partial validation and durable acknowledgements.
- [ ] Final checkpoint: independent review, focused tests, source lint, typechecks, both watch builds, merge commit push and hosted CI. The existing approved local database-check exception remains limited to the documented Docker OOM blocker.

The initial audit found that the phone receiver recorded the transferred binary path without uploading its contents, rotation changed the header's start without rebasing samples, and gyroscope callbacks overwrote a cached reading. Regression tests preceded those fixes. Independent review also found that the existing ClickHouse sink dropped vectors and metadata; the mapper now preserves the existing schema's fields. The new real-ClickHouse regression passed, but the broader suite and analytics lint remain blocked by local ClickHouse OOM/restarts. See the [incident record](../../production-incident-baseline.md#2026-09-06--local-zepp-validation-blocked-by-docker-network-and-memory-exhaustion).

Zepp [background App Services](https://docs.zepp.com/docs/guides/framework/device/app-service/) prohibit accelerometer, gyroscope, and geolocation. [Workout Extensions](https://docs.zepp.com/docs/guides/workout-extension/quick-start/#life-cycle) pause callbacks when unfocused. Changes must not claim to overcome these platform restrictions.
