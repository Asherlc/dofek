# WHOOP recovery and queue diagnostics

The operator approved both corrections after the [physical-device investigation](../../production-incident-baseline.md#2026-10-30--climbing-activity-missing-whoop-bluetooth-heart-rate-unresolved).

## Recovery

Preserve automatic collection after transient setup failures during automatic reconnect/restoration. Cancel the failed handshake, retain the peripheral until CoreBluetooth's disconnect callback, then reuse the existing pending reconnect path. Explicit connection promises retain their bounded failure contract; intentional Disconnect cancels recovery, and Stop cancels IMU restoration. Missing services/characteristics remain terminal. An internal disconnecting state rejects late setup callbacks without expanding the public Swift client state enum. Apple's [cancellation callback contract](https://developer.apple.com/documentation/corebluetooth/cbcentralmanager/cancelperipheralconnection(_:)) supports waiting for cancellation before reconnecting.

## Diagnostics

Use the existing transactional lifecycle counters to derive queued count, and separate indexed oldest/newest lookups. Add a covering `(stream, timestamp)` index; existing SQLite queues create it once on opening. Keep the existing samples and reservation schema, exact acknowledgment, erasure semantics, and diagnostic payload. SQLite documents [covering indexes](https://sqlite.org/queryplanner.html#covering_indexes) and [MIN/MAX optimization](https://sqlite.org/optoverview.html#the_min_max_optimization).

## Alternatives and boundaries

Increasing timeouts or adding retry timers would leave the incorrect recovery transition in place. Keeping exact counts but merely moving full scans to another thread would still stall the uploader and capture queue. The approved direction corrects the state transition and database access directly. No new dependencies, network routes, remote configuration or sensor data transformations are needed. This is native WHOOP capture code; web rendering is unaffected.

## Validation

Regressions exercise automatic timeout/error cancellation followed by reconnect and readiness, repeated failure, intentional cancellation, and existing explicit/structural failure behavior. Real SQLite fixtures verify exact counts/bounds across append, acknowledgment, erasure, owner changes and reopen. A SQLite VM-instruction budget catches scans without depending on machine timing. Benchmark the copied incident queue separately; never modify the phone's queue. Run the full Swift package suite and applicable lint/type checks, then obtain a fresh diff review.
