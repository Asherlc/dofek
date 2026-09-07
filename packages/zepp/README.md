# Dofek Zepp

Zepp OS mini program that captures raw accelerometer and optional gyroscope samples on the watch, buffers them to binary files, and uploads bounded batches to Dofek through the phone. It also uploads daily totals and timestamped heart-rate, stress, body-surface-temperature, and blood-oxygen history through the phone-side Side Service. This app uses `@zeppos/zml` messaging between the watch and Side Service, which uses Fetch for server calls ([Side Service intro](https://docs.zepp.com/docs/guides/framework/side-service/intro/), [Fetch API](https://docs.zepp.com/docs/reference/side-service-api/fetch/), [HeartRate history](https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/HeartRate/), [BodyTemperature history](https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/BodyTemperature/), [BloodOxygen history](https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/BloodOxygen/)).

The normal watch app also pulls completed workout start times and durations through Zepp's official [`Workout.getHistory()`](https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/Workout/) API. A separately packaged Workout Extension captures the richer live metrics exposed by [`getSportData()`](https://docs.zepp.com/docs/reference/device-app-api/newAPI/app-access/getSportData/) on API_LEVEL 3.6+ devices. See the [capability matrix and physical-watch acceptance audit](../../docs/zepp-capture-audit.md) for automation limits, cloud access prerequisites and unverified hardware behavior.

## Target devices

The app targets Zepp OS devices whose official Latest API_LEVEL is 3.0 or newer. App service startup and permission querying both start at API_LEVEL 3.0, as documented below.

| Requirement | Value | Source |
|---|---|---|
| Device family | Zepp OS devices with Latest API_LEVEL >= 3.0 | [Zepp OS device list](https://docs.zepp.com/docs/reference/related-resources/device-list/) |
| Required API_LEVEL | 3.0+ | [app-service start](https://docs.zepp.com/docs/reference/device-app-api/newAPI/app-service/start/), [queryPermission](https://docs.zepp.com/docs/reference/device-app-api/newAPI/app/queryPermission/) |
| Screen targets | Round 480/466/454/416/360, square 432/390/320 widths | [Zepp OS device list](https://docs.zepp.com/docs/reference/related-resources/device-list/) and [app.json target docs](https://docs.zepp.com/docs/watchface/app-json/) |

Configured in `app.json` as screen-width target groups.

## Architecture

```
┌──────────────────── Watch ────────────────────┐
│ Device App page (page/index.ts)               │
│  • checkSensor() + Accelerometer/Gyroscope    │
│  • onChange → memory buffer → flush chunks    │
│  • rotates session_a.bin / session_b.bin      │
├───────────────────────────────────────────────┤
│ App Service (app-service/imu_service.ts)      │
│  • persists low-power health samples/minute   │
│  • reconciles completed workout history       │
│  • CANNOT access IMU sensors (platform limit) │
└───────────────────────┬───────────────────────┘
                        │ ZML request / acknowledgement
                        ▼
┌──────────────────── Phone ────────────────────┐
│ Side Service (app-side/index.ts)              │
│  • authenticates and uploads IMU batches      │
│  • uploads health history to Dofek            │
│  • pairs QR/short code or password login      │
│ Settings App (setting/index.ts)               │
│  • deliberate start/stop, preferences, export │
│  • Dofek URL, QR/short code, login, token     │
└───────────────────────────────────────────────┘
```

The separately packaged Workout Extension runs inside Zepp's system Workout app on API_LEVEL 3.6+ devices. It samples supported `getSportData()` fields—speed, pace, distance, duration, cadence, altitude, ascent, vertical speed, and count/downhill fields—plus continuous heart rate. Device-estimated expenditure is excluded. Samples are batched once per minute, retried after phone/network failures, and ingested as activity-linked metric-stream rows ([collector](src/workout-live.ts)). Zepp pauses extension callbacks while its page is not focused. The normal app and App Service can reconcile limited workout history and low-power health data, but cannot reconstruct missing live workout or IMU samples ([Workout Extension lifecycle](https://docs.zepp.com/docs/guides/workout-extension/quick-start/), [`getSportData()`](https://docs.zepp.com/docs/reference/device-app-api/newAPI/app-access/getSportData/)).

### Background collection

The normal watch app starts a continuously running App Service after the user grants `device:os.bg_service`. The service uses `Time.onPerMinute()`—which Zepp supports even though ordinary `setTimeout`/`setInterval` calls are unavailable—to persist minute-level heart rate, blood oxygen, body temperature, stress, and completed workout history. The foreground app uploads the durable rolling seven-day buffer; stable sample identifiers make repeated catch-up uploads idempotent. On API_LEVEL 4.0+ watches, `reload: true` also asks Zepp to restart the service after system restarts, power-mode changes, app updates, and related system-state changes; API_LEVEL 3.x watches restart collection whenever Dofek is reopened. Accelerometer, gyroscope, and geolocation remain foreground-only because Zepp explicitly blocks high-power sensors in App Service ([App Service capabilities and limitations](https://docs.zepp.com/docs/guides/framework/device/app-service/), [App Service `start`](https://docs.zepp.com/docs/reference/device-app-api/newAPI/app-service/start/)).

### IMU delivery and account binding

The watch sends at most 128 intact binary records per ZML request. Side Service sends them to `/api/ingest/zos-imu`, and acknowledges only after the server's metric-stream publisher accepts the batch. The finalized-file journal retains unacknowledged files across app restarts. Before the first batch, the journal binds the recording to the authenticated account and server; changing either requires reconnecting the original destination. Tokens remain on the phone. A finalized empty file contains no samples and clears locally. See [watch uploader](src/imu-upload.ts), [journal](src/imu-pending-files.ts), [server route](../server/src/routes/ingest-zos-imu.ts), [ZML](https://github.com/zepp-health/zml) and [Side Service Fetch](https://docs.zepp.com/docs/reference/side-service-api/fetch/).

The previous TransferFile callback only established that a file had reached the phone; it did not establish server ingestion. The documented phone file object provides metadata and transfer events, so the upload path uses documented messaging and Fetch instead ([TransferFile](https://docs.zepp.com/docs/reference/device-app-api/newAPI/transfer-file/TransferFile/)).

### Documented platform limits (called out in code)

1. **App Service cannot use Accelerometer/Gyroscope** — high-power sensors are blocked in background service ([App Service guide](https://docs.zepp.com/docs/guides/framework/device/app-service/)). IMU sampling runs in the Device App page; App Service collects only supported low-power health sensors and completed workout history.
2. **App Service has no ordinary JavaScript timers** — `setTimeout` / `setInterval` are unavailable. Background collection uses the supported `Time.onPerMinute()` sensor callback instead ([App Service guide](https://docs.zepp.com/docs/guides/framework/device/app-service/)).
3. **App Service `@zos/fs` writes** are only guaranteed when the screen is off or in AOD; the page performs normal chunked flushes while logging.
4. **Sample rate is not specified in Hz by Zepp docs** — only `FREQ_MODE_LOW | NORMAL | HIGH`. The app selects the highest mode ≤ user preference and records the **measured delivered rate** from `onChange` callbacks.
5. **`onChange` delivery** — treated as one sample per callback (per API examples). The header stores measured Hz; verify on hardware.
6. **Background IMU** — sensor collection stops when the page is destroyed. `setWakeUpRelaunch(true)` requests reopening on wake; it does not guarantee uninterrupted capture. Screen-off/AOD behavior requires the [physical-watch audit](../../docs/zepp-capture-audit.md), and abrupt termination can lose active samples before finalization ([wake relaunch](https://docs.zepp.com/docs/reference/device-app-api/newAPI/display/setWakeUpRelaunch/)).

`configVersion` is **v3** because `app-service` module registration requires v3 schema, while APIs used are Zepp OS 2.0+ `@zos/*` modules.

## Dofek pairing and login

The normal Zepp app and Dofek Workout Extension each maintain their own Dofek
connection. Pair both packages if you use both; connecting one no longer
disconnects the other. Dofek web and mobile Settings list the two connections
separately and can revoke either one.

Update both Zepp packages to the current release before pairing. Older packages
do not identify whether a request comes from the normal app or Workout
Extension, so Dofek rejects those ambiguous requests instead of risking one
package disconnecting the other.

Each package supports the following ways to connect its phone-side Side Service:

| Flow | Where it starts | Where it finishes | Notes |
|---|---|---|---|
| QR from watch | Watch app | Dofek web/mobile settings | The watch renders a Zepp `QRCODE` widget with the Dofek verification URL. Zepp documents this widget for API_LEVEL 2.0+ ([QRCODE](https://docs.zepp.com/docs/reference/device-app-api/newAPI/ui/widget/QRCODE/)). |
| QR from Zepp iOS app | The installed package's Zepp Settings page | Dofek web/mobile settings | Tap **Create QR / short code**. The Settings App displays the server-generated QR SVG URL as an image. |
| Short code | Watch or Zepp Settings | Dofek web/mobile settings | Enter the six-character code in Dofek Settings. The server claim endpoint completes the connection for the polling Side Service. |
| Dofek email/password | Zepp mini program Settings | Zepp Side Service | The Side Service exchanges credentials through Dofek's password-login endpoint. |
| Dofek email/password | Watch app | Zepp Side Service | The watch asks the Side Service to log in after collecting text with Zepp's system keyboard. `SYSTEM_KEYBOARD` starts at API_LEVEL 4.0, so older watches keep the other pairing flows ([SYSTEM_KEYBOARD](https://docs.zepp.com/docs/reference/device-app-api/newAPI/ui/widget/SYSTEM_KEYBOARD/)). |

Pairing challenges expire after ten minutes. After pairing, the Zepp Settings
page displays the server-verified connection state and offers **Check
connection** and **Disconnect Dofek**. Dofek Settings also displays whether
**Zepp app** and **Workout extension** are connected and can disconnect either
package independently. On the normal watch app, the connection button changes
to **Disconnect Dofek** after login, so the normal app can also be revoked
without the phone Settings page. The Zepp Side Service uses Zepp's object-form Fetch API
to call Dofek and poll for completion ([Fetch API](https://docs.zepp.com/docs/reference/side-service-api/fetch/)).

### Add the Workout Extension to a workout

Installing Dofek Workout does not automatically add its widget to every
workout. On the watch:

1. Open the system **Workout** app and choose the workout you want to configure.
2. Open that workout's settings.
3. Select **Motion Extensions**.
4. Add **Dofek Workout**.

Zepp documents Workout Extensions as widgets that users add to individual
workouts through Motion Extensions ([Workout Extension introduction](https://docs.zepp.com/docs/guides/workout-extension/intro/),
[quick start](https://docs.zepp.com/docs/guides/workout-extension/quick-start/)).

## Build & install

Requires Node ≥ 26. The Zeus CLI is installed from this package's dev dependencies:

```bash
cd packages/zepp
pnpm install
```

The package scripts invoke the local `@zeppos/zeus-cli` dependency through `tools/zeus.ts`; no global Zeus install is required.

### Simulator

```bash
pnpm dev
```

Choose a simulator profile matching one of the supported target widths. Simulator sensor values are synthetic; delivered Hz will not match hardware.

### On-device (Developer / Bridge mode)

1. Enable Developer Mode in the Zepp mobile app.
2. Connect a supported Zepp OS API_LEVEL 3.0+ device via Bridge.
3. Build and install:

```bash
pnpm preview
# or
pnpm build
```

4. Open **Dofek Zepp** on the watch, then tap **Start session** and grant accelerometer + background service permissions when prompted.
5. Tap **Stop & transfer** to finalize and send the session. The mini program **Settings** page in the Zepp phone app can also start or stop a session while the Dofek watch app is open.

## Release (Zepp Store)

CI builds both `.zab` packages and attaches them to a GitHub Release. Zepp's documented publication flow requires uploading each ZAB through the developer console and submitting it for review, so CI prepares the packages while the final store uploads remain manual ([Zepp app submission](https://docs.zepp.com/docs/distribute/)).

### Automatic builds (every main push)

Every successful `main` CI run triggers `release-zepp.yml`: it patches an auto-generated version, builds both independently submitted Zepp packages with the local Zeus wrapper, uploads both `.zab` workflow artifacts for 90 days, and creates a GitHub Release containing both packages. Configure the public GitHub repository variable `ZEPP_WORKOUT_EXTENSION_APP_ID` with the numeric app ID provisioned for the independent Workout Extension before enabling these builds.

The artifacts are:

- `dofek-zepp-app-zab` — the normal API_LEVEL 3.0+ watch app.
- `dofek-zepp-workout-extension-zab` — the independent API_LEVEL 3.6+ Workout Extension.

CI versions each build as `0.0.<unix-timestamp>` with code `<timestamp>`, so version files do not need manual updates.

1. Download both `.zab` files from the latest GitHub Release.
2. Upload the normal watch app package to its existing listing in [console.zepp.com](https://console.zepp.com/).
3. Upload the Workout Extension package to its independent Workout Extension listing and submit both upgrades for review. Zepp requires a separate app ID and submission for a Workout Extension ([Workout Extension quick start](https://docs.zepp.com/docs/guides/workout-extension/quick-start/)).

## Watch files and recovery

```text
data://imu/session_a.bin
data://imu/session_b.bin
data://imu/pending.json
```

The two recording slots rotate while sampling. A slot containing an unacknowledged finalized recording cannot be overwritten; recording stops if both slots are occupied. **Stop & transfer** retries pending files. Uploaded records flow through the canonical metric stream to ClickHouse and the archive; the app no longer produces a phone sandbox export path. See [page lifecycle](page/index.ts), [upload journal](src/imu-pending-files.ts) and [sink](../../src/metric-stream/clickhouse-sink.ts).

## Binary format

| Section | Size | Contents |
|---|---|---|---|
| Header | 32 bytes | magic `IUM1` (LE bytes of `0x314D5549`), version (uint8), flags (uint8), reserved (uint16), session start unix ms (uint64), sample count (uint32), accel freq mode (uint8), gyro freq mode (uint8), measured Hz×100 (uint16), padding |
| Chunk | 4 + N×record | `uint16 count`, reserved `uint16`, records |
| Record (version 2) | 20 bytes | `uint32 t_ms`, `uint32 sensor` (0 acceleration, 1 angular velocity), `float32 x`, `float32 y`, `float32 z` |

Units: accelerometer cm/s², gyroscope deg/s ([Accelerometer](https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/Accelerometer/), [Gyroscope](https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/Gyroscope/)). The header's measured rate counts both enabled callback streams; it is not a per-sensor hardware rate ([collector](src/imu-collector.ts)).

`t_ms` is milliseconds relative to the file header start time, using `Date.now()` deltas; this is not a hardware sensor timestamp or a guaranteed monotonic clock. Accelerometer and gyroscope callbacks produce separate records. The decoder also accepts historical version-1 16-byte acceleration records and 28-byte paired records; historical paired gyro timestamps cannot be reconstructed beyond what those files preserved. See the [encoder](src/imu-format.ts) and [decoder](../../src/providers/zos-app/decode.ts).

## Decode a recording

```bash
pnpm tsx tools/decode-imu.ts /path/to/imu.bin -o imu.csv
```

The script prints header metadata and decoded vector count. CSV rows include relative time, absolute time, sensor kind and vector components ([decoder CLI](tools/decode-imu.ts)).

## Project layout

```text
zepp/
  app.json              # Zepp OS API_LEVEL 3.0+ targets + modules
  app.ts                # app entry
  page/index.ts         # watch UI + sensor collector
  app-service/imu_service.ts
  workout-extension/    # independently packaged live Workout app extension
  app-side/index.ts     # phone authenticated upload service
  setting/index.ts      # phone controls
  src/                  # library modules (codec, collector, file flush, tests)
  tools/decode-imu.ts
```

## Operational notes

- Recording stays idle until the user starts a session from the watch or phone Settings. Settings sends the command through the Side Service, so the Dofek watch app must be open ([Overall Architecture](https://docs.zepp.com/docs/guides/architecture/arc/)).
- Stop finalizes and transfers the active session before another session can start. Manual export retries a finalized session when needed.
- BLE throughput varies with connection quality; large sessions may take minutes to transfer.
- If gyro is disabled or absent (`checkSensor(Gyroscope) === false`), only accelerometer records are produced ([collector](src/imu-collector.ts)).
