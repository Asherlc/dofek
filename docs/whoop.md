# WHOOP Provider

## Authentication

Uses WHOOP's internal Cognito-based auth (not the public developer OAuth2 API). This gives access to the same endpoints the mobile/web app uses.

- **Auth endpoint**: `https://api.prod.whoop.com/auth-service/v3/whoop/`
- **Cognito client ID**: `37365lrcda1js3fapqfe2n40eh`
- **Auth flow**: `USER_PASSWORD_AUTH` via Cognito `InitiateAuth`
- **MFA**: Supports both SMS and TOTP. If MFA is enabled, `InitiateAuth` returns a challenge session, which is completed via `RespondToAuthChallenge`.
- **Token refresh**: `REFRESH_TOKEN_AUTH` flow — Cognito doesn't return a new refresh token, so the original is reused.
- **User ID**: Fetched from the bootstrap endpoint after auth: `GET /users-service/v2/bootstrap/?accountType=users&apiVersion=7&include=profile`

Tokens are stored in the `oauth_token` table (in the `fitness` schema). The user ID is persisted in the `scopes` column as `userId:<id>`.

## API

Full API documentation is in [`whoop-api.openapi.yaml`](whoop-api.openapi.yaml) (OpenAPI 3.1).

- **Base URL**: `https://api.prod.whoop.com`
- **Auth header**: `Authorization: Bearer <access_token>`
- **User-Agent**: `WHOOP/4.0`
- **API version**: All requests include `?apiVersion=7`

### Currently synced data

| Data | Endpoint | Notes |
|------|----------|-------|
| Recovery | `GET /core-details-bff/v0/cycles/details` | Embedded in cycle response. HRV, resting HR, SpO2, skin temp. |
| Sleep | `GET /sleep-service/v1/sleep-events?activityId=<id>` | Per-sleep detail with stage breakdown. Sleep ID comes from cycles. |
| Workouts | `GET /core-details-bff/v0/cycles/details` | Embedded in cycle response under `strain.workouts[]`. Aggregate only: strain, HR, calories, zones. |
| Strength workouts | `GET /weightlifting-service/v2/weightlifting-workout/{activityId}` | Discovered, not yet synced. Exercise-level data: sets, reps, weight, muscle groups, MSK strain. |
| Heart rate | `GET /metrics-service/v1/metrics/user/<userId>` | 6-second interval time series. |
| Journal | `GET /behavior-impact-service/v1/impact` | Behavior/journal entries with impact scores. |

### Key implementation notes

- The cycles BFF limits queries to **200-day windows** — the provider loops in chunks.
- Strength Trainer workouts (sport_id=123) include an `msk_score` object with muscular load metrics, but this is aggregate only — no exercise-level data.

## Strength Trainer Data (exercises, sets, reps, weight)

### Status: Discovered via APK decompilation (March 2026)

Exercise-level strength data is available through the **`weightlifting-service`** — a separate internal microservice discovered by decompiling the WHOOP Android APK and probing the endpoints live. This service was not found during earlier endpoint probing because the service name (`weightlifting-service`) was not guessable from the public API surface.

### Key endpoint

**`GET /weightlifting-service/v2/weightlifting-workout/{activityId}`** returns full exercise-level data for a workout activity. The `activityId` is the UUID activity ID from the cycles BFF workout response.

Response includes:
- **Exercise details**: exercise name, equipment, muscle groups, movement pattern, laterality
- **Sets**: reps, weight (kg), duration, MSK volume per set
- **Workout-level metrics**: total effective volume (kg), raw/scaled MSK strain, cardio strain, strain contribution split
- **Zone durations**: time in each intensity zone (0-100%)

Example response shape:
```json
{
  "zone_durations": { "zone90_to100_duration": 0, ... },
  "workout_groups": [{
    "workout_exercises": [{
      "sets": [{
        "weight_kg": 0,
        "number_of_reps": 0,
        "msk_total_volume_kg": 255.876,
        "time_in_seconds": 60,
        "during": "['2026-03-12T21:37:00.000Z','2026-03-12T21:37:00.001Z')",
        "complete": true
      }],
      "exercise_details": {
        "exercise_id": "FRONTPLANKELBOW",
        "name": "Front Plank",
        "equipment": "BODY",
        "exercise_type": "STRENGTH",
        "muscle_groups": ["CORE"],
        "volume_input_format": "TIME"
      }
    }]
  }],
  "activity_id": "uuid",
  "total_effective_volume_kg": 2047.008,
  "raw_msk_strain_score": 0.0288,
  "scaled_msk_strain_score": 2.85552,
  "cardio_strain_score": 1.549,
  "cardio_strain_contribution_percent": 0.329,
  "msk_strain_contribution_percent": 0.671
}
```

### All discovered weightlifting-service endpoints

#### Working (GET)

| Endpoint | Description |
|----------|-------------|
| `GET /weightlifting-service/v2/weightlifting-workout/{activityId}` | Full exercise-level workout data |
| `GET /weightlifting-service/v1/exercise` | Full exercise catalog (~500+ exercises, flat array) |
| `GET /weightlifting-service/v2/exercise` | Same catalog, wrapped in `{"exercises": [...]}` |
| `GET /weightlifting-service/v1/link-workout` | UI data for linking workouts (templates, AI chat config) |
| `GET /weightlifting-service/v2/workout-template/{templateId}` | Workout template with planned exercises/sets |
| `GET /weightlifting-service/v2/workout-library` | WHOOP pre-built workout templates |
| `GET /weightlifting-service/v3/workout-library` | Same (v3) |
| `GET /weightlifting-service/v3/prs` | Personal records |

#### Write endpoints (POST, confirmed to exist via 405/422 responses)

| Endpoint | Description |
|----------|-------------|
| `POST /weightlifting-service/v2/weightlifting-workout/activity` | Create/link workout to activity |
| `POST /weightlifting-service/v2/custom-exercise` | Create custom exercise |
| `POST /weightlifting-service/v3/workout-template` | Create workout template |
| `POST /weightlifting-service/v2/performance-profile` | Write performance profile |
| `POST /weightlifting-service/v2/weightlifting-workout/link-cardio-workout` | Link cardio workout |
| `POST /weightlifting-service/v1/raw-data/protobuf` | Upload raw strap data |

#### Other paths (from APK decompilation, not all tested)

- `GET /weightlifting-service/v1/exercise/{exerciseId}`
- `GET /weightlifting-service/v2/custom-exercise/{exerciseId}`
- `GET /weightlifting-service/v1/share/{sharedWorkoutId}`
- `GET /weightlifting-service/v1/share/{workoutTemplateId}`
- `GET /weightlifting-service/v2/workout-template/{workoutTemplateKey}`
- `GET /weightlifting-service/v2/prebuilt-workout-template/{workoutTemplateId}`
- `GET /weightlifting-service/v1/link-workout-notification-dismissal/{activityId}`

### Exploration script

`scripts/explore-whoop-strength.ts` probes these endpoints. Requires a refresh token:

```bash
WHOOP_REFRESH_TOKEN=<token> pnpm tsx scripts/explore-whoop-strength.ts
```

Get the refresh token from the database:
```sql
SELECT refresh_token FROM fitness.oauth_token WHERE provider_id = 'whoop';
```

### Next steps

1. ~~Add a `getStrengthWorkout()` method to `WhoopInternalClient`~~ ✅ Done
2. ~~Sync exercise-level data into the existing `strength_workout` / `strength_set` tables~~ ✅ Done
3. Consider syncing the exercise catalog (`GET /weightlifting-service/v2/exercise`) for exercise metadata

### Raw IMU/accelerometer data

There are **three paths** to getting raw accelerometer data from a Whoop strap. All are on the roadmap for future implementation (iPhone accelerometer via `CMSensorRecorder` is being implemented first as a quicker win).

#### Path A: Protobuf files from Strength Trainer workouts (API)

Each set in the weightlifting response has a `protobuf_file_path` field pointing to raw accelerometer/gyroscope data from the WHOOP strap. This is the rawest data WHOOP captures for strength training — the MSK strain scores are derived from it.

**Status (March 2026): Confirmed protobuf data exists, download mechanism TBD.**

A live-tracked Strength Trainer workout (sport_id=123, "Virgil van Dijk's Pitch Power") confirmed that `protobuf_file_path` is populated for sets where the strap detects the exercise. Key observations:

- **Only RIGHT-side sets had protobuf data** — the strap was worn on the right arm, so sets where `strap_location_laterality: "RIGHT"` have protobuf paths, while `"LEFT"` sets do not
- **`strap_location` is an integer** (e.g., `1`), not a string like the decompiled DTO suggested ("BICEP")
- **4 of ~18 sets** across the workout had protobuf data (Split Squat sets tracked on right arm, Squat Jump)
- **New field discovered**: `is_exercise_trackable: Boolean` — indicates whether the exercise supports IMU tracking
- **New field discovered**: `weightlifting_workout_set_id: UUID` — unique ID per set

**S3 storage:**
- **Bucket**: `com.whoop.weightlifting.prod` (in `us-west-2`)
- **Key format**: `pb/dt={YYYY-MM-DD}/hour={HH}/user_id={userId}/{timestampMs}.pb`
- **Full path example**: `com.whoop.weightlifting.prod/pb/dt=2026-03-26/hour=00/user_id=35557944/1774486428149.pb`

**Upload endpoint:**
- `POST /weightlifting-service/v1/raw-data/protobuf` with `Content-Type: application/octet-stream`
- Returns `{"bucket_and_key": "com.whoop.weightlifting.prod/pb/..."}` on success
- The strap uploads raw IMU data here during live-tracked workouts

**Download: NOT YET POSSIBLE.** Attempts tried:
- Direct S3 access → 403 (bucket is private, no public access)
- Various API download endpoints → all 404
- Bearer token on S3 → invalid (S3 doesn't accept Cognito Bearer tokens)
- No presigned URL endpoint found on the weightlifting-service

**APK decompilation confirmed (March 2026): no download mechanism exists.**
- The app only **uploads** protobuf data via `POST /weightlifting-service/v1/raw-data/protobuf` (Retrofit method: `uploadWeightliftingProtobufFile`). There is no download/GET endpoint for protobuf files.
- **No Cognito Identity Pool** — the app does not use federated identity for direct S3 access. It uses `cognitoidentityprovider` (User Pool auth) only.
- **No protobuf schema bundled** — the `.proto` files in the APK are Firebase analytics (`client_analytics.proto`, `messaging_event.proto`), not WHOOP IMU schemas.
- The upload method signature is: `uploadWeightliftingProtobufFile(body: RequestBody, headers: Map<String, String>, setStartTimeMS: Long) -> UploadedProtobufInfo`
- `UploadedProtobufInfo` contains a single field: `bucket_and_key: String` (the S3 path)

**Remaining options to access raw IMU data:**
1. **BLE interception** — capture accelerometer data as it flows from strap to phone over Bluetooth Low Energy, before upload. This would require reverse-engineering the BLE protocol.
2. **WHOOP Unite research program** — institutional research agreement that may offer deeper data access.
3. **MITM proxy** — intercept the upload to capture the raw protobuf bytes and reverse-engineer the schema.

**Derived accelerometer data (potentially accessible):**
The APK contains a `LoadVelocityProfileDto` with fields derived from accelerometer data:
- `average_velocities_meters_per_second: List<Double>` — per-set average velocity
- `peak_velocities_meters_per_second: List<Double>` — per-set peak velocity
- `loads_kg: List<Double>` — load for each data point
- `one_rm_kg: Double` — estimated 1RM from load-velocity regression
- `slope_average / slope_peak: Double` — regression slope
- `r_value_average / r_value_peak: Double` — regression R-value
- `minimum_average_velocity_threshold_m_per_s / minimum_peak_velocity_threshold_m_per_s: Double`
- `load_at_zero_average_velocity_kg / load_at_zero_peak_velocity_kg: Double` — y-intercept
- `zero_load_average_velocity_m_per_s / zero_load_peak_velocity_m_per_s: Double` — x-intercept

This data is served via `POST /weightlifting-service/v2/performance-profile/template` — not yet tested, likely requires enough training data points to compute the regression.

**Example set with protobuf (from live-tracked workout):**
```json
{
  "weight_kg": 0.0,
  "is_exercise_trackable": true,
  "weightlifting_workout_set_id": "8f58d274-61c3-49ef-90f1-d4feae1a79e4",
  "number_of_reps": 8,
  "during": "['2026-03-25T17:53:48.149Z','2026-03-25T17:53:48.419Z')",
  "strap_location": 1,
  "strap_location_laterality": "RIGHT",
  "protobuf_file_path": "com.whoop.weightlifting.prod/pb/dt=2026-03-26/hour=00/user_id=35557944/1774486428149.pb",
  "msk_total_volume_kg": 0.0,
  "time_in_seconds": null,
  "complete": true
}
```

**Additional response fields discovered (not in current types):**
- Top-level: `pushcore_version`, `weightlifting_workout_id`, `workout_template_id`, `msk_intensity_percent`, `raw_cardio_intensity_score`, `raw_total_strain_score`, `total_strain_score`, `total_active_time_seconds`, `total_rest_time_seconds`, `average_heart_rate`, `max_heart_rate`, `kilojoules`
- Exercise details: `image_url` (CloudFront), `video_url` (CloudFront) — exercise demo images/videos

**Decompiled DTO fields (from `WeightliftingWorkoutSetDto.java`):**
- `protobuf_file_path: String` — S3 key for raw IMU data
- `strap_location: Integer` — where on the body the strap was (integer code, not string as originally documented)
- `strap_location_laterality: String` — "LEFT" or "RIGHT"
- `is_exercise_trackable: Boolean` — whether the exercise supports IMU tracking

**APK decompilation location:** `/tmp/whoop-apk/jadx-output/` (WHOOP Android v5.439.0, decompiled with `jadx --deobf`). Key files:
- `sources/com/whoop/weightlifting/data/WeightliftingApi.java` — Retrofit interface with all 20 endpoints
- `sources/com/whoop/weightlifting/data/dto/WeightliftingWorkoutSetDto.java` — Set DTO with protobuf fields
- Search for `protobuf` or `ProtobufParser` in the decompiled sources to find the protobuf schema definition
- Search for `IdentityPoolId` or `CognitoIdentity` to find the S3 access mechanism

#### Path B: BLE capture during Strength Trainer workouts (passive)

When the Whoop app starts a Strength Trainer workout, it sends `TOGGLE_IMU_MODE (0x6a)` to the strap, which begins streaming raw accel+gyro packets (types 0x33/0x34) at high frequency over BLE. Using iOS PacketLogger, these can be captured passively (without disrupting the Whoop app's connection) and parsed with `scripts/parse-whoop-ble-capture.ts`.

**Limitation:** Only captures data during active Strength Trainer workouts — not 24/7.

**Next step:** Run a Strength Trainer workout with PacketLogger capturing. The parser is ready; we just need a capture that includes 0x33/0x34 packets to validate the IMU decoding.

#### Path C: Direct BLE command injection (active, 24/7)

Build a macOS or iOS CoreBluetooth client that connects to the Whoop strap and sends:
- `START_RAW_DATA (0x51)` + `TOGGLE_IMU_MODE_HISTORICAL (0x69)` — dump all stored IMU history
- `TOGGLE_IMU_MODE (0x6a)` — enable continuous raw IMU streaming

**Challenges:**
- The Whoop only bonds to one BLE central at a time — would need to disconnect the Whoop app first (or build a MITM proxy)
- Battery drain on strap: raw IMU mode is power-hungry, likely 2-3x normal battery consumption
- Protocol may change with firmware updates
- The strap's console log confirms `SENSORS: No active IMU data collection sources` during normal wear — the IMU is off by default to save battery

**This is the most complete path** (24/7 raw wrist accel from the Whoop itself) but also the most fragile. Worth pursuing after the iPhone accelerometer pipeline is proven.

#### Roadmap priority

1. ✅ **iPhone CMSensorRecorder** (in progress) — 50 Hz, background, official API, no hacking
2. 🔜 **Path B: BLE capture during Strength Trainer** — validate IMU packet parsing, low effort
3. 🔮 **Apple Watch CMSensorRecorder** — 50 Hz wrist accel via watchOS companion app
4. 🔮 **Path C: Direct Whoop BLE** — 24/7 wrist accel, requires custom BLE client + bonding workaround

### BLE protocol (reverse-engineered from APK + packet capture)

The Whoop strap communicates with the phone app over BLE using custom GATT services. The protocol was reverse-engineered from the decompiled Android APK (v5.439.0) and confirmed via iOS PacketLogger captures analyzed with tshark.

**Scripts:**
- `scripts/parse-whoop-ble-capture.ts` — full parser for `.pklg`/`.btsnoop` captures, extracts IMU samples to CSV
- `scripts/parse-whoop-pklg.ts` — quick parser for inspecting packet structure

#### Service UUIDs

| Hardware Gen | Service UUID |
|-------------|-------------|
| Gen 4 (Harvard) | `61080001-8d6d-82b8-614a-1c8cb0f8dcc6` |
| Maverick/Goose | `fd4b0001-cce1-4033-93ce-002d5875f58a` |
| Puffin | `11500001-6215-11ee-8c99-0242ac120002` |

Characteristics follow the same offset pattern for all generations (replace `0001` with the characteristic suffix):

| Suffix | Name | Direction | Purpose |
|--------|------|-----------|---------|
| `...0002` | CMD_TO_STRAP | Write | Send commands to the strap |
| `...0003` | CMD_FROM_STRAP | Notify | Command responses |
| `...0004` | EVENTS_FROM_STRAP | Notify | Event notifications |
| `...0005` | DATA_FROM_STRAP | Notify | Sensor data stream |
| `...0007` | MEMFAULT | Notify | Debug/crash logs |

In the iOS capture, these mapped to ATT handles: `0x099b` (CMD_TO_STRAP), `0x099d` (DATA_FROM_STRAP), `0x09a3` (high-frequency data stream).

#### Frame format

All BLE payloads use this frame structure:

```
[0xAA] [version:u8] [payloadLen:u16 LE] [headerFields...] [payload...] [crc32:u32 LE]
```

- `0xAA` = start-of-frame marker
- Version is typically `0x01`
- CRC32 is over the entire frame excluding the CRC itself

#### Packet types

| Byte | Name | Description |
|------|------|-------------|
| 0x23 | COMMAND | Command sent to strap |
| 0x24 | COMMAND_RESPONSE | Strap's response to a command |
| 0x28 | REALTIME_DATA | Real-time processed metrics (HR, orientation quaternion) |
| 0x2B | REALTIME_RAW_DATA | Raw sensor data (Maverick R21 format, 1244-byte packets) |
| 0x2F | HISTORICAL_DATA | Historical data replay during sync |
| 0x32 | CONSOLE_LOGS | Strap's internal debug console output |
| 0x33 | REALTIME_IMU | Real-time raw IMU stream (accel + gyro) |
| 0x34 | HISTORICAL_IMU | Historical raw IMU replay |

#### Standard sync sequence (observed in capture)

The Whoop app performs this sequence on connection:

1. `GET_HELLO (0x91)` — handshake
2. `SET_PERSISTENT_CONFIG (0x75)` — configure strap parameters
3. `GET_PERSISTENT_CONFIG (0x76)` × 17 — read all config keys
4. `SEND_PERSISTENT_CONFIG (0x78)` × 17 — push config values (e.g., `enable_r22_packets`, `enable_maverick_model`, `hr_ch_switching`, `wear_detect_bias`, etc.)
5. `GET_DATA_RANGE (0x22)` — ask strap what data it has stored
6. `SEND_HISTORICAL_DATA (0x16)` — request historical data replay
7. Strap streams `HISTORICAL_DATA (0x2F)` packets + `METADATA (0x31)` packets
8. App sends `HISTORICAL_DATA_RESULT (0x17)` ACKs for each chunk
9. Concurrent: strap streams `REALTIME_DATA (0x28)` with HR + orientation quaternion at ~1 Hz

#### Real-time data packet (type 0x28, 116 bytes)

During standard sync, the strap sends processed sensor data at ~1 Hz:

| Offset | Size | Field | Notes |
|--------|------|-------|-------|
| 0-1 | 2 | SOF (`0xAA 0x01`) | |
| 2-3 | 2 | Payload length (LE) | 116 for this packet type |
| 4-10 | 7 | Frame header | Type byte = `0x80` |
| 11-14 | 4 | Sequence number (u32 LE) | Increments per packet |
| 15-18 | 4 | Strap timestamp (u32 LE) | Unix epoch seconds |
| 19-21 | 3 | Preamble | Constant `0x14 0x4E 0x00` |
| **22** | **1** | **Heart Rate (bpm)** | Validated: 66-89 range in resting capture |
| 23-40 | 18 | Optical/PPG data | Sparse, partially zero |
| **41-44** | **4** | **Quaternion W (float32 LE)** | Orientation, ~0.0 when wrist is sideways |
| **45-48** | **4** | **Quaternion X (float32 LE)** | ~0.68 in resting position |
| **49-52** | **4** | **Quaternion Y (float32 LE)** | ~-0.71 in resting position |
| **53-56** | **4** | **Quaternion Z (float32 LE)** | ~0.20 in resting position |
| 57+ | ~60 | Device metadata | Mostly constant per session |

Confirmed: all 869 packets in our capture had quaternion magnitude within 0.97-1.05 (unit quaternion = pure rotation from the strap's IMU sensor fusion).

#### Triggering raw IMU mode

The standard sync only streams **processed** data (HR + orientation quaternion). To get **raw accelerometer/gyroscope** data, the app sends:

| Command | Byte | What it does |
|---------|------|-------------|
| `TOGGLE_IMU_MODE_HISTORICAL (0x69)` | Write to CMD_TO_STRAP | Enables historical raw IMU data replay from strap memory |
| `TOGGLE_IMU_MODE (0x6a)` | Write to CMD_TO_STRAP | Enables real-time raw IMU streaming |
| `START_RAW_DATA (0x51)` | Write to CMD_TO_STRAP | Start raw data collection on strap |
| `STOP_RAW_DATA (0x52)` | Write to CMD_TO_STRAP | Stop raw data collection |

Once enabled, the strap sends `HISTORICAL_IMU (0x34)` or `REALTIME_IMU (0x33)` packets on DATA_FROM_STRAP:

**IMU packet structure (types 0x33/0x34):**

| Offset | Size | Field |
|--------|------|-------|
| 0 | 1 | Packet type (0x33 or 0x34) |
| 1 | 1 | Record type |
| 3 | 4 | Data timestamp (u32 LE, Unix seconds) |
| 11 | 2 | Sub-seconds (u16 LE) |
| 24 | 2 | Sample count A — accelerometer (u16 LE) |
| 26 | 2 | Sample count B — gyroscope (u16 LE) |
| 28+ | 12×N | Interleaved samples: `[ax:i16 ay:i16 az:i16 bx:i16 by:i16 bz:i16]` |

Each sample is 12 bytes (6 × int16 LE). Channels a = accelerometer XYZ, channels b = gyroscope XYZ.

**Maverick R21 raw packet (type 0x2B, record type 21, 1244 bytes):**

| Offset | Size | Field |
|--------|------|-------|
| 16 | 2 | Count A (u16 LE) |
| 20 | 200 | ax samples (100 × i16 LE) |
| 220 | 200 | ay samples |
| 420 | 200 | az samples |
| 622 | 2 | Count B (u16 LE) |
| 632 | 200 | bx samples |
| 832 | 200 | by samples |
| 1032 | 200 | bz samples |

#### How to capture raw IMU via PacketLogger

1. Install the **Bluetooth logging profile** on your iPhone from [developer.apple.com/bug-reporting/profiles-and-logs/](https://developer.apple.com/bug-reporting/profiles-and-logs/) (requires Apple developer account sign-in)
2. Install **Wireshark** (`brew install wireshark`) for the `tshark` CLI
3. Connect iPhone to Mac via USB
4. Open PacketLogger (from Xcode Additional Tools), select iOS device, start trace
5. Open Whoop app and trigger a sync (or start a Strength Trainer workout for live IMU)
6. Save capture as `.pklg`
7. Analyze: `tshark -r capture.pklg -2 -R 'bthci_acl' -T fields -e btatt.handle -e btatt.value`
8. Parse: `npx tsx scripts/parse-whoop-ble-capture.ts capture.pklg`

**Current limitation (March 2026):** Our capture only shows the standard sync (HR + quaternion). To capture raw IMU packets, we need to either:
- Start a Strength Trainer workout (the app sends `TOGGLE_IMU_MODE` automatically)
- Build a custom BLE client that sends the `0x69` command directly (requires stealing the BLE connection from the Whoop app)

### Investigation history

<details>
<summary>Earlier investigation (pre-APK decompilation)</summary>

#### Initial CORS-blocked endpoints

These endpoints returned CORS preflight errors (not 404) from the browser, suggesting they exist but are restricted to non-browser clients:

| Endpoint | Status |
|----------|--------|
| `/developer/v2/activity/strength-trainer` | CORS-blocked from browser. **Returns 404 from Node** — false positive. |
| `/fitness-service/v1/*` | CORS-blocked from browser. **Returns 404 from Node** — all path variations tested. |
| `/activities-service/v1/activities` | CORS-blocked from browser. **Returns 404 from Node**. |

#### Tested and confirmed 404 from Node

A comprehensive probe of ~45 endpoint variations was run from Node.js using a valid Cognito access token. **All returned 404.** This includes:
- `/developer/v2/activity/strength-trainer`
- `/fitness-service/v1/{exercises,workouts,strength,users/*/workouts,...}`
- `/strength-trainer-service/v1/*`
- `/msk-service/v1/*`, `/msk/v1/*`
- `/training-service/v1/*`
- `/workout-bff/v1/*`, `/workout-details-bff/v1/*`
- `/coach-service/v1/*`
- `/activities-service/v1/{activities,workout}/*`

The service name `weightlifting-service` was not among the guessed prefixes, which is why APK decompilation was needed.
</details>

### Community context

There is an [active feature request](https://www.community.whoop.com/t/api-for-strength-trainer/10517) on the WHOOP community forum for official API access to Strength Trainer exercise data. As of March 2026, it has not been added to the public developer API.
