# Background refresh diagnostics

The user approved adding native scheduler diagnostics after the October 24
WHOOP upload investigation. The phone retained samples while no background
refresh reached the uploader; current logs cannot identify the missing boundary.

Keep a bounded native metadata journal for registration, scheduling, native task
launch, listener availability, bridge dispatch, JavaScript receipt, actual task
completion, and expiration. Include refresh availability, Low Power Mode,
native occurrence time, stable event/task identity, and structured OS errors.
Replay the journal through existing mobile telemetry at authenticated startup,
foreground activation, and background-handler receipt/completion. Retained events
have unknown account provenance. Account erasure clears the journal.

Follow the existing WHOOP native diagnostic journal pattern using UserDefaults,
with 64 retained events, an overflow counter, nondestructive reads, and stable
event IDs across restarts. Use the existing Expo bridge, Zod validation, logger,
and Sentry. Do not record sensor samples or credentials. This metadata does not
promise that the final asynchronous UserDefaults write survives abrupt process
termination: [Apple UserDefaults](https://developer.apple.com/documentation/foundation/userdefaults).

The approved approach adds evidence without changing the 15-minute earliest
request date, upload triggers, completion policy, expiration policy, retries, or
timeouts. A BLE-triggered uploader and file-backed background transfers remain
separate behavior changes. Apple's scheduling date is not a guarantee:
[earliestBeginDate](https://developer.apple.com/documentation/backgroundtasks/bgtaskrequest/earliestbegindate).
The native bridge requires a new app binary; JavaScript-only updates cannot add
native methods: [Expo native code](https://docs.expo.dev/workflow/customizing/).

Validation must cover persisted history, bounded retention, error metadata,
listener absence, expiry/late completion, replay deduplication, malformed bridge
payloads, cleanup, and integration into the application lifecycle. Compile the
Expo-bound code in an iOS app build; the module's SwiftPM target excludes it.
Physical iOS scheduling remains a separate deployment verification.
