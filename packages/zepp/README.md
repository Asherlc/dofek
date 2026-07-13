# Dofek Zepp

Zepp OS mini program that captures raw accelerometer (and optional gyroscope) samples on the watch, buffers them to a watch-side binary file, and exports the file to the phone over BLE. It can also collect supported Zepp health summaries on the watch and upload them from the phone-side Side Service to Dofek using a companion token. Zepp documents Side Service as the phone-side runtime that can communicate with both the watch app and external servers through Fetch API ([Side Service intro](https://docs.zepp.com/docs/guides/framework/side-service/intro/), [Fetch API](https://docs.zepp.com/docs/reference/side-service-api/fetch/)).

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
│  • started with logging for persistence hook  │
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
│  • start/stop, freq mode, gyro flag, export   │
│  • Dofek URL, QR/short code, login, token     │
└───────────────────────────────────────────────┘
```

### Why TransferFile instead of BLE messaging?

Bulk IMU logs are megabytes, while BLE messaging is oriented toward small binary payloads and manual framing. **TransferFile** (API 3.0+) provides queued file transfer, progress events, and completion/error states — better backpressure handling for large exports. Control commands (start/stop/export) still use lightweight Side Service ↔ Device App messages via `@zeppos/zml`.

### Documented platform limits (called out in code)

1. **App Service cannot use Accelerometer/Gyroscope** — high-power sensors are blocked in background service ([App Service guide](https://docs.zepp.com/docs/guides/framework/device/app-service/)). IMU sampling runs in the Device App page; App Service is used for lifecycle/transfer hooks only.
2. **App Service has no timers** — `setTimeout` / `setInterval` are unavailable; polling loops cannot run there.
3. **App Service `@zos/fs` writes** are only guaranteed when the screen is off or in AOD; the page performs normal chunked flushes while logging.
4. **Sample rate is not specified in Hz by Zepp docs** — only `FREQ_MODE_LOW | NORMAL | HIGH`. The app selects the highest mode ≤ user preference and records the **measured delivered rate** from `onChange` callbacks.
5. **`onChange` delivery** — treated as one sample per callback (per API examples). The header stores measured Hz; verify on hardware.
6. **Background IMU** — when the mini program UI is destroyed, sensor access stops. `setWakeUpRelaunch(true)` reopens the app after wake, but continuous off-body/screen-off high-rate IMU is not supported by the platform.

`configVersion` is **v3** because `app-service` module registration requires v3 schema, while APIs used are Zepp OS 2.0+ `@zos/*` modules.

## Dofek pairing and login

The Zepp app supports multiple ways to create the companion token used by the phone-side Side Service:

| Flow | Where it starts | Where it finishes | Notes |
|---|---|---|---|
| QR from watch | Watch app | Dofek web/mobile settings | The watch renders a Zepp `QRCODE` widget with the Dofek verification URL. Zepp documents this widget for API_LEVEL 2.0+ ([QRCODE](https://docs.zepp.com/docs/reference/device-app-api/newAPI/ui/widget/QRCODE/)). |
| QR from Zepp iOS app | Zepp mini program Settings | Dofek web/mobile settings | The Settings App displays the server-generated QR SVG with Zepp's `Image` component, which accepts remote image URLs ([Image](https://docs.zepp.com/docs/reference/app-settings-api/ui/image/)). |
| Short code | Watch or Zepp Settings | Dofek web/mobile settings | Enter the six-character code in Dofek Settings. The server claim endpoint issues a companion token back to the polling Side Service. |
| Dofek email/password | Zepp mini program Settings | Zepp Side Service | The Side Service exchanges credentials for a companion token through Dofek's password-login endpoint. |
| Dofek email/password | Watch app | Zepp Side Service | The watch asks the Side Service to log in after collecting text with Zepp's system keyboard. `SYSTEM_KEYBOARD` starts at API_LEVEL 4.0, so older watches keep the other pairing flows ([SYSTEM_KEYBOARD](https://docs.zepp.com/docs/reference/device-app-api/newAPI/ui/widget/SYSTEM_KEYBOARD/)). |

Pairing challenges expire after ten minutes. The Zepp Side Service uses Zepp's object-form Fetch API to call Dofek and poll for completion ([Fetch API](https://docs.zepp.com/docs/reference/side-service-api/fetch/)).

## Build & install

Requires Node ≥ 14 and the Zeus CLI:

```bash
npm i -g @zeppos/zeus-cli
cd packages/zepp
pnpm install
```

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

4. Open **Dofek Zepp** on the watch, grant accelerometer + background service permissions when prompted.
5. Open the mini program **Settings** page in the Zepp phone app for remote start/stop/export.

## Release (Zepp Store)

CI builds and attaches the `.zab` package as a GitHub Release artifact.
There's no Zepp Store submission API — the final upload is manual.

### Automatic builds (every main push)

Every push to `main` triggers `release-zepp.yml`: patches an auto-generated version into `app.json` and `package.json`, runs `zeus build`, and uploads the `.zab` artifact (retained 90 days). The built artifact is always available at:

> GitHub → Actions → Release Dofek Zepp (Zepp Store) → latest run → Artifacts → `zepp-zab`

**Version scheme:**
- Tagged push (`zepp-v1.2.3`) → version `1.2.3`, code `10203`
- Main push (no tag) → version `0.0.<unix-timestamp>`, code `<timestamp>`

You never need to manually bump version files — CI derives the version from the tag or generates one.

### Cutting a tagged release (GitHub Release)

Tagged pushes additionally create a GitHub Release with the `.zab` attached.

```bash
git tag zepp-v1.0.1
git push origin zepp-v1.0.1
```

1. CI builds the `.zab` with version `1.0.1` and creates a GitHub Release.
2. Download the `.zab` from the Release page (or from workflow artifacts for untagged builds).
3. Go to [console.zepp.com](https://console.zepp.com/) → your app → **Version Upgrade**.
4. Upload the `.zab`, fill in screenshots/description if needed, submit for review (1-5 business days).

Tag pattern: `zepp-v<semver>`.

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
  app-side/index.ts     # phone BLE receiver
  setting/index.ts      # phone controls
  src/                  # library modules (codec, collector, file flush, tests)
  tools/decode_imu.py
```

## Operational notes

- Start logging from the watch **or** phone Settings (phone sends a Side Service command to the watch page).
- Stop logging before export so the header sample count is finalized.
- BLE throughput varies with connection quality; large sessions may take minutes to transfer.
- If gyro is disabled or absent (`checkSensor(Gyroscope) === false`), records omit gyro fields.
