# Dofek Workout Extension

Dofek Workout is an independently packaged Zepp OS Workout Extension. It runs
as a data widget inside the watch's system Workout app, captures live workout
metrics, heart rate, and focused motion segments, and sends them to Dofek
through the phone-side Side Service.

Workout Extensions require API_LEVEL 3.6 or newer and an independent app ID,
store submission, and review. On a physical watch, users add the extension
inside the Workout app rather than opening it from the normal application list.
See Zepp's [Workout Extension quick start](https://docs.zepp.com/docs/guides/workout-extension/quick-start/).

## What it collects

While the widget has focus, `data-widget/index.ts` samples every ten seconds:

- speed, average speed, pace, average pace, distance, and duration;
- cadence, average cadence, altitude, ascent, vertical speed, count, downhill
  count, and downhill distance;
- current heart rate when available.

It also starts a foreground motion segment immediately on focus. The shared IMU
controller captures accelerometer samples and automatically adds gyroscope
samples when the watch exposes that sensor. The extension has no gyroscope
toggle. It uses the normal app's binary format, chunked file writer, BLE file
receiver, durable phone upload outbox, and display lease, with its own two
alternating file slots so a completed segment can transfer while collection
resumes. Pending slot metadata is persisted before transfer and restored before
either slot can be reset after a widget restart. Connected sessions also send
bounded, versioned sample chunks through the same server ingestion path used by
the normal app; the transferred binary remains registered on the phone as a
redundant local backup. The display lease uses Zepp's
documented screen-off controls and is always released when the segment stops
([`pauseDropWristScreenOff`](https://docs.zepp.com/docs/v2/reference/device-app-api/newAPI/display/pauseDropWristScreenOff/),
[`resetDropWristScreenOff`](https://docs.zepp.com/docs/v2/reference/device-app-api/newAPI/display/resetDropWristScreenOff/)).

The metric API starts at API_LEVEL 3.6, requires
`data:user.hd.workout`, and returns JSON strings that the app validates and
normalizes. See Zepp's
[`getSportData()` reference](https://docs.zepp.com/docs/reference/device-app-api/newAPI/app-access/getSportData/).
The extension intentionally does not request or upload Zepp's estimated
calories.

Samples are grouped by the workout start time derived from Zepp's duration,
persisted at `data://workout/live.json`, and uploaded after six pending samples
or when the widget pauses. A batch is removed only after `health.upload`
succeeds, so phone or network failures remain available for retry. Zepp pauses
registered callbacks and timers when an extension loses focus; the
`onResume`/`onPause` handlers therefore start and stop collection as described
in the [official lifecycle](https://docs.zepp.com/docs/guides/workout-extension/quick-start/#life-cycle).
The same handlers start and finalize motion segments; the extension does not
and cannot keep high-rate IMU capture active after its widget loses focus.

The build reuses the parent package's `app-side/index.ts` for authentication,
durable motion/health outboxes, and server requests. That Side Service runs in the Zepp phone app and can
communicate with both the watch app and a server, as documented in Zepp's
[Side Service introduction](https://docs.zepp.com/docs/guides/framework/side-service/intro/).
The Zepp phone Settings App can create a QR/short-code pairing challenge or
send a password-login request to the Side Service. It shows the server-verified
connection state and error reason and provides **Check connection** and
**Disconnect Dofek** actions. The Workout Extension uses its own
`zepp-workout` connection, independently of the normal Zepp app's `zepp-main`
connection. Update both packages to the current release before pairing; Dofek
rejects older ambiguous connection requests so a legacy Workout Extension
cannot revoke the normal app's credential.

## Pair and enable the extension

1. In the Zepp iOS app, open the installed **Dofek Workout** package's Settings.
2. Tap **Create QR / short code**, then scan the QR or enter the six-character
   code in Dofek web/mobile **Settings → Connections**. You can instead enter
   your Dofek email and password and tap **Log in and connect**.
3. Confirm that the Zepp Settings page says **Connection: connected**. Use
   **Check connection** to verify the saved credential against Dofek.
4. On the watch, open the system **Workout** app and choose a workout.
5. Open that workout's settings, select **Motion Extensions**, and add
   **Dofek Workout**.

Workout Extensions are added to individual workouts as Motion Extensions; they
do not appear as ordinary standalone watch apps ([Workout Extension
introduction](https://docs.zepp.com/docs/guides/workout-extension/intro/),
[quick start](https://docs.zepp.com/docs/guides/workout-extension/quick-start/)).

## Build and test

Use Node.js 26 or newer and the package-local Zeus CLI:

```bash
cd packages/zepp
pnpm install
export ZEPP_WORKOUT_EXTENSION_APP_ID=1234567
pnpm build:workout-extension
```

Replace the example with the numeric app ID provisioned for this independent
Workout Extension in the Zepp developer console. The build generates the
ignored `workout-extension/app.json`, copies target icons, bundles the data
widget, Side Service, and Settings App, then invokes Zeus to produce the
package. Zepp requires the registered app ID in `app.json`; see the
[submission guide](https://docs.zepp.com/docs/distribute/).

To open the extension in the Zepp simulator:

```bash
pnpm tsx workout-extension/build.ts
pnpm tsx workout-extension/zeus.ts dev
```

Run the package checks from `packages/zepp`:

```bash
pnpm test
pnpm typecheck
pnpm lint
```

The package suite covers manifest generation, widget lifecycle, focused motion
segments and transfers, live-metric uploads, Settings App behavior, shared
parsing and storage, and Side Service behavior. Simulator motion is synthetic,
so physical sensor availability, measured callback rate, BLE behavior while the
phone is suspended, and battery draw still require a paired watch.

## Layout

```text
workout-extension/
  app.template.json       generated-manifest source
  app.ts                  application entry point
  build.ts                manifest, asset, and bundle preparation
  data-widget/index.ts    watch collection and durable upload queue
  setting/index.ts        Zepp phone-app settings
  zeus.ts                 package-local Zeus launcher
```

The manifest currently supports round 480 px and square 390 px targets,
declares workout and heart-rate permissions, and supports all workout subtypes
with an empty `subType` list. Keep these declarations aligned with the
[Workout Extension manifest rules](https://docs.zepp.com/docs/guides/workout-extension/quick-start/#appjson)
and the source APIs.
