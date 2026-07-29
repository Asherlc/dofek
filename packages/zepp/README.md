# Dofek Zepp

Zepp OS mini program that captures raw accelerometer (and optional gyroscope) samples on the watch, buffers them to a watch-side binary file, and exports the file to the phone over BLE. It also uploads daily totals and timestamped heart-rate, stress, body-surface-temperature, and blood-oxygen history through the phone-side Side Service. Zepp documents Side Service as the phone-side runtime; this app uses `@zeppos/zml` messaging between the watch app and Side Service, and the Side Service uses Fetch API for Dofek server calls ([Side Service intro](https://docs.zepp.com/docs/guides/framework/side-service/intro/), [Fetch API](https://docs.zepp.com/docs/reference/side-service-api/fetch/), [HeartRate history](https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/HeartRate/), [BodyTemperature history](https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/BodyTemperature/), [BloodOxygen history](https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/BloodOxygen/)).

The normal watch app also pulls completed workout start times and durations through Zepp's official [`Workout.getHistory()`](https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/Workout/) API. A separately packaged Workout Extension captures the richer live metrics exposed by [`getSportData()`](https://docs.zepp.com/docs/reference/device-app-api/newAPI/app-access/getSportData/) on API_LEVEL 3.6+ devices.

## Target devices

The app targets Zepp OS devices whose official Latest API_LEVEL is 3.0 or newer. This boundary comes from the APIs the app uses: file transfer, app service startup, and permission querying all start at API_LEVEL 3.0.

| Requirement | Value | Source |
|---|---|---|
| Device family | Zepp OS devices with Latest API_LEVEL >= 3.0 | [Zepp OS device list](https://docs.zepp.com/docs/reference/related-resources/device-list/) |
| Required API_LEVEL | 3.0+ | [TransferFile](https://docs.zepp.com/docs/reference/device-app-api/newAPI/transfer-file/TransferFile/), [app-service start](https://docs.zepp.com/docs/reference/device-app-api/newAPI/app-service/start/), [queryPermission](https://docs.zepp.com/docs/reference/device-app-api/newAPI/app/queryPermission/) |
| Screen targets | Round 480/466/454/416/360, square 432/390/320 widths | [Zepp OS device list](https://docs.zepp.com/docs/reference/related-resources/device-list/) and [app.json target docs](https://docs.zepp.com/docs/watchface/app-json/) |

Configured in `app.json` as screen-width target groups.

## Architecture

```
┌──────────────────── Watch ────────────────────┐
│ Device App page (page/index.ts)               │
│  • checkSensor() + Accelerometer/Gyroscope    │
│  • onChange → memory buffer → flush chunks      │
│  • writes data://imu/session.bin              │
├───────────────────────────────────────────────┤
│ App Service (app-service/imu_service.ts)      │
│  • persists low-power health samples/minute   │
│  • reconciles completed workout history       │
│  • CANNOT access IMU sensors (platform limit) │
└───────────────────────┬───────────────────────┘
                        │ TransferFile (BLE)
                        ▼
┌──────────────────── Phone ────────────────────┐
│ Side Service (app-side/index.ts)              │
│  • onReceivedFile → saves export path         │
│  • uploads health summaries to Dofek          │
│  • pairs QR/short code or password login      │
│ Settings App (setting/index.ts)               │
│  • deliberate start/stop, preferences, export │
│  • Dofek URL, QR/short code, login, token     │
└───────────────────────────────────────────────┘
```

The separately packaged Workout Extension runs inside Zepp's system Workout app on API_LEVEL 3.6+ devices. It samples every field exposed by `getSportData()`—speed, pace, distance, duration, calories, cadence, altitude, ascent, vertical speed, and supported count/downhill fields—plus current heart rate. Samples are batched once per minute, retried after transient phone/network failures, and ingested as activity-linked metric-stream rows. Zepp pauses extension callbacks while its page is not focused, so the normal app and continuous App Service provide historical reconciliation and low-power background continuity ([Workout Extension lifecycle](https://docs.zepp.com/docs/guides/workout-extension/quick-start/), [`getSportData()`](https://docs.zepp.com/docs/reference/device-app-api/newAPI/app-access/getSportData/)).

### Background collection

The normal watch app starts a continuously running App Service after the user grants `device:os.bg_service`. The service uses `Time.onPerMinute()`—which Zepp supports even though ordinary `setTimeout`/`setInterval` calls are unavailable—to persist minute-level heart rate, blood oxygen, body temperature, stress, and completed workout history. The foreground app uploads the durable rolling seven-day buffer; stable sample identifiers make repeated catch-up uploads idempotent. On API_LEVEL 4.0+ watches, `reload: true` also asks Zepp to restart the service after system restarts, power-mode changes, app updates, and related system-state changes; API_LEVEL 3.x watches restart collection whenever Dofek is reopened. Accelerometer, gyroscope, and geolocation remain foreground-only because Zepp explicitly blocks high-power sensors in App Service ([App Service capabilities and limitations](https://docs.zepp.com/docs/guides/framework/device/app-service/), [App Service `start`](https://docs.zepp.com/docs/reference/device-app-api/newAPI/app-service/start/)).

### Why TransferFile instead of BLE messaging?

Bulk IMU logs are megabytes, while BLE messaging is oriented toward small binary payloads and manual framing. **TransferFile** (API 3.0+) provides queued file transfer, progress events, and completion/error states — better backpressure handling for large exports. Control commands (start/stop/export) still use lightweight Side Service ↔ Device App messages via `@zeppos/zml`.

### Documented platform limits (called out in code)

1. **App Service cannot use Accelerometer/Gyroscope** — high-power sensors are blocked in background service ([App Service guide](https://docs.zepp.com/docs/guides/framework/device/app-service/)). IMU sampling runs in the Device App page; App Service collects only supported low-power health sensors and completed workout history.
2. **App Service has no ordinary JavaScript timers** — `setTimeout` / `setInterval` are unavailable. Background collection uses the supported `Time.onPerMinute()` sensor callback instead ([App Service guide](https://docs.zepp.com/docs/guides/framework/device/app-service/)).
3. **App Service `@zos/fs` writes** are only guaranteed when the screen is off or in AOD; the page performs normal chunked flushes while logging.
4. **Sample rate is not specified in Hz by Zepp docs** — only `FREQ_MODE_LOW | NORMAL | HIGH`. The app selects the highest mode ≤ user preference and records the **measured delivered rate** from `onChange` callbacks.
5. **`onChange` delivery** — treated as one sample per callback (per API examples). The header stores measured Hz; verify on hardware.
6. **Background IMU** — when the mini program UI is destroyed, sensor access stops. `setWakeUpRelaunch(true)` reopens the app after wake, but continuous off-body/screen-off high-rate IMU is not supported by the platform.

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

## Output file location

After export, the Side Service stores the received file path in Settings Storage key `last_export_path`. On the phone this is under the mini program's Side Service data sandbox, typically:

```text
data://export/imu_<ISO-timestamp>.bin
```

The Settings UI shows the resolved path once transfer completes. Exact host filesystem mapping depends on Zepp App version/OS; use the displayed path from Settings or pull via Zepp developer tooling.

Watch-side source file before export:

```text
data://imu/session.bin
```

## Binary format

| Section | Size | Contents |
|---|---|---|---|
| Header | 32 bytes | magic `IUM1` (LE bytes of `0x314D5549`), version (uint8), flags (uint8), reserved (uint16), session start unix ms (uint64), sample count (uint32), accel freq mode (uint8), gyro freq mode (uint8), measured Hz×100 (uint16), padding |
| Chunk | 4 + N×record | `uint16 count`, reserved `uint16`, records |
| Record (accel) | 16 bytes | `uint32 t_ms`, `float32 ax`, `float32 ay`, `float32 az` |
| Record (+gyro) | 28 bytes | above + `float32 gx`, `float32 gy`, `float32 gz` |

Units: accelerometer cm/s², gyroscope deg/s (per `@zos/sensor` docs).

`t_ms` is milliseconds since logging start (monotonic session clock based on `Date.now()` delta).

## Decode with Python

```bash
pip install pandas
python tools/decode_imu.py /path/to/imu_2025-06-24T12-00-00.bin -o imu.csv
```

The script prints header metadata, row count, and a timestamp-derived Hz estimate.

## Project layout

```text
zepp/
  app.json              # Zepp OS API_LEVEL 3.0+ targets + modules
  app.ts                # app entry
  page/index.ts         # watch UI + sensor collector
  app-service/imu_service.ts
  workout-extension/    # independently packaged live Workout app extension
  app-side/index.ts     # phone BLE receiver
  setting/index.ts      # phone controls
  src/                  # library modules (codec, collector, file flush, tests)
  tools/decode_imu.py
```

## Operational notes

- Recording stays idle until the user starts a session from the watch or phone Settings. Settings sends the command through the Side Service, so the Dofek watch app must be open ([Overall Architecture](https://docs.zepp.com/docs/guides/architecture/arc/)).
- Stop finalizes and transfers the active session before another session can start. Manual export retries a finalized session when needed.
- BLE throughput varies with connection quality; large sessions may take minutes to transfer.
- If gyro is disabled or absent (`checkSensor(Gyroscope) === false`), records omit gyro fields.
