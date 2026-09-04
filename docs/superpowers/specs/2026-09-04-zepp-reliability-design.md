# Zepp Reliability and Lifecycle Alignment Design

## Purpose

Bring the normal Dofek Zepp app and the independently packaged Dofek Workout
Extension into one explicit, reliable collection system. The design preserves
every supported collection and delivery path, removes the unsupported idea
that an App Service can keep foreground IMU sensors alive, fixes misleading
connection state, and makes health-ingest failures actionable.

The primary product objective is maximum redundancy and availability within
Zepp OS's supported APIs. Higher battery, BLE, and local-storage use are
acceptable consequences when they buy an independent delivery path or prevent
data loss. Duplicate delivery is expected and made safe through stable event
identities and idempotent server ingestion.

## Platform Constraints

- A continuously running App Service remains alive after the Device App exits,
  but Zepp explicitly prohibits high-power sensors including `Accelerometer`
  and `Gyroscope` in that runtime. It may use supported low-power sensors and
  BLE ([App Service capabilities and limitations](https://docs.zepp.com/docs/guides/framework/device/app-service/)).
- A Workout Extension enters a paused state when it loses focus. While paused,
  registered callbacks cannot run and timers stop
  ([Workout Extension lifecycle](https://docs.zepp.com/docs/guides/workout-extension/quick-start/#life-cycle)).
- A normal Device App can use raw accelerometer and gyroscope APIs while its
  page remains active. Zepp normally exits the Mini Program shortly after its
  screen turns off; wake-up relaunch reopens the page later rather than
  preserving execution
  ([`setWakeUpRelaunch`](https://docs.zepp.com/docs/reference/device-app-api/newAPI/display/setWakeUpRelaunch/)).
- The advanced foreground recorder may suspend wrist-rest screen-off until the
  recording ends. It must restore normal display behavior on every stop and
  destruction path
  ([`pauseDropWristScreenOff`](https://docs.zepp.com/docs/v2/reference/device-app-api/newAPI/display/pauseDropWristScreenOff/)).
- The watch communicates with the phone over BLE, while the phone-side Side
  Service owns server Fetch access
  ([Zepp OS architecture](https://docs.zepp.com/docs/guides/architecture/arc/),
  [Side Service Fetch API](https://docs.zepp.com/docs/v2/reference/side-service-api/fetch/)).

No component may describe foreground or focused-widget IMU capture as
background capture. Undocumented firmware behavior is not a supported product
capability.

## Package Responsibilities

### Normal Dofek app

The normal app owns setup, continuous low-power health collection, redundant
health delivery, and an advanced foreground raw-motion recorder.

On setup or launch, it requests `device:os.bg_service` permission and starts a
renamed Health Service independently of raw-motion recording. Denying this
permission prevents continuous background health collection but does not block
the foreground recorder.

The Advanced Raw Motion Recorder is an intentional high-power mode. Starting
it obtains a display lease that suspends wrist-rest screen-off, starts both
accelerometer and gyroscope when supported, and records until the user stops or
the page is destroyed. Stop and destruction finalize durable data and release
the display lease. The UI states plainly that the feature keeps the app and
display active and has substantial battery cost.

### Dofek Workout Extension

The Workout Extension owns workout-scoped live metrics. When its panel gains
focus, it automatically starts the shared IMU session controller and continues
sampling `getSportData()` plus current heart rate. When it loses focus, it
closes the current raw-motion segment and flushes all pending workout data
without declaring that the system workout ended. A later focus event opens a
new segment under the same workout identity.

The extension UI reports the actual coverage state: live collection while
focused and a clear gap state after focus loss. It never implies that raw IMU
continued while Zepp paused the extension.

### Shared runtime-independent modules

One set of shared modules owns:

- sensor capability checks and frequency selection;
- accelerometer/gyroscope callback synchronization;
- IMU session state, buffering, file rotation, encoding, and finalization;
- transfer metadata and stable segment identity;
- health transport envelopes and validation;
- durable outbox entries, acknowledgments, and serialized draining;
- connection-state modeling and user-facing error formatting.

The normal Device App and Workout Extension are thin lifecycle adapters. They
provide start, pause, stop, display, UI, and workout-identity policies without
duplicating collection internals.

### Health Service

`app-service/imu_service` becomes `app-service/health_service`. The service uses
only supported low-power sensors, appends immutable observations to a durable
watch outbox, and attempts bounded BLE delivery when a phone connection is
available. It never imports, constructs, or invokes accelerometer or gyroscope
APIs.

### Side Service and server

The phone Side Service persists a received batch before acknowledging it to the
watch. It drains its phone outbox to the server when connectivity permits. A
server acknowledgment is the only event that removes the corresponding phone
entry; a phone persistence acknowledgment is the only event that permits the
watch to remove its entry.

Server ingestion validates versioned envelopes, preserves source and package
provenance, writes raw observations through their canonical storage paths, and
treats a stable event ID replay as success. Metric interpretation and
deduplication remain server responsibilities.

## Redundant Collection and Delivery

The system intentionally uses all supported triggers:

1. Health Service collects supported low-power observations every minute.
2. Health Service attempts background BLE delivery when connected.
3. Opening the normal app triggers a watch-to-phone catch-up drain.
4. Establishing or verifying a Dofek connection triggers a phone-to-server
   drain and, when the watch is reachable, a watch-to-phone drain.
5. Settings retains **Sync health data now** as an explicit retry trigger.
6. Workout Extension persists and uploads focused live metrics and raw-motion
   segments.
7. Completed workout history reconciles the activity envelope after focused
   extension gaps.
8. The Advanced Raw Motion Recorder supplies a separate uninterrupted
   foreground capture path when the user accepts its power cost.

The normal app and Workout Extension keep independent companion credentials.
They are separately installed applications with isolated storage and Side
Services. Either package can therefore continue uploading if the other is
disconnected, outdated, or unavailable.

All drains are serialized per outbox. Concurrent background, launch,
connection, and manual triggers coalesce into the same drain rather than
issuing competing mutations. Batches are bounded and replayable. Delivery is
at least once at every boundary.

## Identity, Provenance, and Storage

Every transport event has a deterministic identity derived from the producing
package, installation, source, timestamp, channel or record kind, and workout
or segment identity where applicable. Retries preserve that identity.

Workout Extension focus segments share the system workout identity but retain
distinct segment identities. Completed workout history, live workout metrics,
focused raw IMU, and advanced-recorder IMU remain separate raw observations
with explicit provenance. The server does not discard one source merely
because another overlaps it.

Watch outbox records are removed only after a durable phone acknowledgment.
Phone outbox records are removed only after server acknowledgment. Partial
batch acknowledgments identify accepted event IDs so an interruption never
requires deleting an entire batch.

Raw IMU files remain on the watch until phone-side persistence is confirmed.
The phone retains the received file until server-side persistence is confirmed.
File transfer continues to use Zepp's queue-aware TransferFile facility rather
than embedding bulk binary data in control messages
([TransferFile API](https://docs.zepp.com/docs/reference/device-app-api/newAPI/transfer-file/TransferFile/)).

## Transport Contract and Validation

Health and workout traffic uses a single explicitly versioned envelope. The
envelope carries package connection type, installation identity, batch ID,
event IDs, timestamps, and typed raw observations. The same transport types and
pure validators are used by watch collection code, the phone Side Service, and
server tests; runtime-specific adapters do not redefine payload shapes.

Validation occurs at three boundaries:

1. Collection normalizes only documented invalid or sentinel values. A valid
   raw observation is added to the watch outbox.
2. The Side Service validates the persisted envelope before HTTP transmission.
3. The server validates authorization, envelope version, and every event before
   persistence.

An invalid observation is never reported as successfully synchronized. Its raw
transport representation and structured validation reason are retained in a
diagnostic quarantine so it cannot block valid events and is not silently
lost. Quarantined entries contain field paths and reasons and are eligible for
reprocessing after a code correction.

The existing generic `Invalid payload` experience is removed. Server responses
include structured field paths and validation messages. The Side Service
preserves those details, sends them to telemetry without attaching unrelated
health values, and displays an actionable reason in Settings. Server-side
validation failures also emit safe structured diagnostics so the producing
package, envelope version, batch, and invalid field can be identified without
logging bearer credentials.

## Authentication and Settings UX

Connection state is modeled as one of:

- `disconnected`;
- `pairing`;
- `checking`;
- `connected`;
- `disconnecting`;
- `error`.

A stored token is evidence that verification can be attempted, not proof of a
connected state. Only a successful server verification produces `connected`.
A 401 response removes the invalid token and returns the package to
`disconnected` with an actionable explanation.

When disconnected, Settings shows server configuration plus QR/short-code and
password-login choices. When connected, those controls are hidden and Settings
shows verified connection information, synchronization state, **Check
connection**, **Sync health data now**, and **Disconnect Dofek**. Connecting a
different account requires a successful disconnect first.

Normal Dofek and Dofek Workout display which independent connection they
represent. Neither package implies that connecting it automatically connects
the other.

## Failure Handling

- Expected unsupported-sensor conditions are explicit capability results.
- Unexpected exceptions are reported to the existing telemetry path and leave
  their outbox entry available for retry.
- BLE disconnection, phone unavailability, network failure, server failure,
  page destruction, and extension pause never acknowledge unpersisted data.
- Outbox writes are atomic. A new durable version replaces the prior version
  only after the write succeeds.
- A poison event is quarantined with its exact validation failure while valid
  sibling events continue through the pipeline.
- Display restoration is attempted from every normal stop and destruction
  path. A display-restoration failure is reported and surfaced rather than
  swallowed.
- Background-service startup failure is visible in Settings and is independent
  of the Advanced Raw Motion Recorder.

## Testing and Physical Verification

Implementation follows test-driven development. Each behavioral change begins
with a focused failing test.

Unit coverage includes:

- the shared IMU session controller and both lifecycle policies;
- display lease acquisition and restoration;
- deterministic identities and idempotent acknowledgments;
- watch and phone outbox persistence, serialization, and partial drains;
- sensor-value normalization and transport validation;
- authentication-state transitions and control visibility;
- structured server-error formatting.

Server integration coverage uses the real database and verifies accepted
envelopes, duplicate replay, partial invalid batches, structured validation
errors, and canonical raw writes. Runtime adapter tests exercise Device App
destruction, Workout Extension focus loss and resume, disconnected BLE,
phone-offline retries, revoked credentials, and concurrent synchronization
triggers.

Repository verification runs the Zepp unit suite, server unit and relevant
integration suites, typecheck, lint, both Zepp package builds, and schema-aware
manifest validation.

Simulator validation is required for every behavior the Zepp simulator can
exercise. Both packages are built and launched in matching round and square
profiles. The audit covers initial permission/setup states, Settings rendering,
connection-state transitions, normal-app recording lifecycle, Workout
Extension focus/pause/resume segmentation, structured payload errors, BLE and
network retry states exposed by the simulator, duplicate triggers, and display
lease cleanup. Simulator-generated sensor values are treated as lifecycle and
transport evidence rather than hardware-rate evidence. A behavior is deferred
to the physical-watch checklist only when the simulator cannot reproduce the
underlying device capability.

A physical T-Rex 3 audit verifies:

- Health Service continuity after the normal app exits;
- background BLE delivery and later catch-up after BLE loss;
- phone-offline retention followed by server delivery;
- manual synchronization through the same coordinator;
- exact invalid-field presentation for a rejected payload;
- connected and disconnected Settings control states;
- Workout Extension focus segmentation and later activity reconciliation;
- Advanced Recorder keep-awake behavior and display restoration;
- duplicate delivery producing one idempotent server result.

## Documentation and Migration

The Zepp README and both package-specific Settings descriptions will use the
same responsibility and lifecycle language as this design. References to an
IMU App Service, background raw IMU, or wake-up relaunch as continuity are
removed.

Existing stored credentials and valid buffered health data remain readable.
The first run migrates legacy buffer entries into versioned outbox events with
stable identities before attempting delivery. The migration is deterministic
and idempotent; legacy storage is removed only after the new durable write
succeeds. No compatibility route or duplicate long-term storage path remains
after migration.

## Non-Goals

- Bypassing documented Zepp OS restrictions or relying on undocumented
  firmware behavior.
- Claiming complete raw IMU coverage when neither foreground surface was
  active.
- Combining the two independently installed packages into one store listing or
  sharing their isolated credentials.
- Computing health metrics on the watch or phone.
- Discarding overlapping provider observations during ingestion.
