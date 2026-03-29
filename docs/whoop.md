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

### Status: WORKING (March 29, 2026)

**Raw 6-axis accelerometer+gyroscope data is being captured from the WHOOP strap via BLE.** The full pipeline is confirmed:

1. Our iOS app connects to the strap via `retrieveConnectedPeripherals` (piggybacking on the WHOOP app's bonded BLE connection)
2. R21 raw data frames (type 0x2B, 1236 bytes) flow passively during the WHOOP app's normal sync — **no command injection needed**
3. Each frame contains 100 samples of 6-axis data (accel XYZ + gyro XYZ, int16 LE)
4. Samples are buffered and uploaded to the server via tRPC

**Key finding: no additional battery drain.** The strap's IMU is already active during normal WHOOP app operation. We're reading data that's already being transmitted as part of the standard BLE protocol, not turning on a sensor that was off. The original concern about reducing strap battery life from 5 days to 3-4 days by enabling the IMU is not applicable — the IMU data already flows during sync.

**Caveat:** Data flows during active WHOOP app sync sessions. When the WHOOP app finishes syncing and goes to background, R21 packets may stop. Continuous 24/7 capture may still require TOGGLE_IMU_MODE (which we confirmed is accepted on the bonded iOS connection — got 0x24 ACK).

**Remaining work:**
- Fix strap epoch → Unix timestamp conversion (currently shows 1970 dates)
- Fix tRPC endpoint routing for upload
- Update tests for Maverick 8-byte header format
- Verify data continues flowing after WHOOP app sync completes
- Clean up diagnostic logging

There are **three paths** to getting raw accelerometer data from a Whoop strap. Path D (passive BLE capture) is now the primary working approach.

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

Send `TOGGLE_IMU_MODE (0x6a)` to enable continuous raw IMU streaming beyond sync sessions.

**Status (March 29, 2026): Command accepted on iOS bonded connection.**
- Our TOGGLE_IMU_MODE command received a 0x24 ACK (COMMAND_RESPONSE) on the bonded iOS connection
- Commands are silently ignored on unbonded connections (macOS got 0x26 NACK with error 0x049c)
- The strap requires BLE bonding (established by the WHOOP app) before accepting commands
- On iOS, our app shares the WHOOP app's bonded connection via `retrieveConnectedPeripherals`
- Full command frame format cracked: 8-byte Maverick header with CRC16-MODBUS + CRC32 payload

**Battery drain: NOT A CONCERN.** The strap's IMU is already active during normal WHOOP app sync. R21 raw data (type 0x2B, 100 samples/frame) flows passively without any command. ~~During normal wear, the IMU is off~~ — this was incorrect. The IMU runs during sync sessions, which happen frequently throughout the day.

#### Path D: Passive BLE capture during WHOOP app sync (WORKING)

**This is the current working approach.** Our app piggybacks on the WHOOP app's BLE connection and passively reads R21 raw data frames that flow during normal sync operations. No command injection needed.

- ✅ 2,100+ samples captured in initial testing
- ✅ 6-axis data (accel XYZ + gyro XYZ), 100 samples per frame
- ✅ Data confirmed real: gravity vector = 0.98g, low variance when wrist at rest
- ✅ Sensor range confirmed: ±8g (1g ≈ 4096 LSB)
- ⚠️ Data only flows during active WHOOP app sync sessions

#### Roadmap priority

1. ✅ **iPhone CMSensorRecorder** — 50 Hz, background, official API
2. ✅ **Path D: Passive WHOOP BLE** — WORKING, 100 Hz wrist accel during WHOOP sync
3. ✅ **Apple Watch CMSensorRecorder** — 50 Hz wrist accel via watchOS companion app
4. 🔜 **Path C: Active WHOOP BLE** — 24/7 wrist accel via TOGGLE_IMU_MODE (command accepted, needs testing for continuous streaming)
5. 🔮 **Path A: Protobuf download** — requires finding the download mechanism

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

There are two frame formats depending on hardware generation:

**Gen4 (Harvard) — 5-byte header with CRC8:**
```
[SOF: 0xAA] [version: u8] [payloadLen: u16 LE] [headerCRC8: u8]
[payload: payloadLen bytes]
```
- CRC8 uses the table in `C28184c.f111541c`
- Class: `dm0/C15397c` (Gen4PacketFrame)

**Maverick/Puffin — 8-byte header with CRC16 + CRC32 payload (CONFIRMED):**
```
[SOF: 0xAA] [ver: 0x01] [payloadLen: u16 LE] [role1: 0x00] [role2: 0x01] [headerCRC16: u16 LE]
[command: payloadLen - 4 bytes]
[payloadCRC32: u32 LE]
```
- **Header CRC16**: CRC16-MODBUS of the first 6 header bytes, stored as u16 LE at bytes 6-7
- **Payload CRC32**: Standard Java `CRC32` (`java.util.zip.CRC32` = IEEE 802.3) of the command bytes only (not including the CRC32 itself), stored as u32 LE at the end of the payload
- `role1 = 0x00` = `AbstractC15395a.c` (role "c")
- `role2 = 0x01` = `AbstractC15395a.b` (role "b")
- Class: `dm0/C15399e` (MaverickPacketFrame)
- **payloadLen includes the 4-byte CRC32** — so command bytes = payloadLen - 4

**Verified (March 29, 2026):** Built frames match PacketLogger capture byte-for-byte:
- Frame 7: `aa010c000001e74123f16a010100000058e961fc` — header CRC16 `e741` = CRC16-MODBUS(`aa010c000001`), payload CRC32 `58e961fc` = CRC32(`23f16a0101000000`)
- Frame 13: `aa010c000001e74123f36a010100000071f8fe6b` — same header CRC (same header bytes), payload CRC `71f8fe6b` = CRC32(`23f36a0101000000`)

**Command payload structure:**
```
[packetType: 0x23 or 0x25] [seqNum: u8] [commandByte: u8] [params...]
```
- 0x23 = COMMAND (Gen4/Maverick)
- 0x25 = PUFFIN_COMMAND (Puffin-specific)

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

### Live BLE investigation (March 28-29, 2026)

#### Phase 1: iOS debug build (March 28)

Deployed a debug build to a physical iPhone connected to a WHOOP 4.0 strap ("WHOOP MGB0542854") via BLE. Findings:

1. **BLE connection works on iOS**: `retrieveConnectedPeripherals` finds the strap already connected by the WHOOP app. Our app successfully connects, discovers services/characteristics, and subscribes to DATA_FROM_STRAP notifications. iOS allows multiple apps to share a BLE peripheral.

2. **Data flows but contains no IMU packets on iOS**: 697-944 BLE notifications arrive on DATA_FROM_STRAP. All are console log packets (packet type 0x01 at payload offset 0) containing ASCII firmware debug output. No IMU packets (type 0x33/0x34) were observed. Commands sent got no response (CMD_FROM_STRAP was silent).

#### Phase 2: PacketLogger capture (March 29)

Captured a live Strength Trainer workout via PacketLogger. Key findings:

- **Command format has additional structure**: The WHOOP app sends 12-byte payloads (not 2): `[preamble: 00 01 E7 41] [0x23] [seq] [cmd] [params: 01 01 00 00 00]`, plus a 4-byte CRC32 trailer.
- **Commands get ACK'd (type 0x24)** in the capture — strap echoes back the command byte and sequence number.
- **After TOGGLE_IMU_MODE, DATA_FROM_STRAP sends 1236-byte REALTIME_RAW_DATA (type 0x2B)** packets — the Maverick R21 format with separate accel/gyro channel arrays. This is the IMU data we want.

#### Phase 3: Direct BLE probe from macOS (March 29)

Built `packages/ble-probe` — a macOS CLI tool for interactive BLE probing. Connected directly to a Puffin-generation WHOOP strap ("WBB5BP0969399", service UUID `11500001-...`) after force-closing the WHOOP app on the phone.

**Critical finding: the strap requires BLE bonding/authentication before accepting commands.**

All commands — regardless of format, CRC, or sequence — receive a **0x26 NACK response with error code 0x049c (1180)**:

| Command | Format | Response |
|---------|--------|----------|
| TOGGLE_IMU_MODE (0x6A) | Full 12-byte payload + CRC32 from capture | 0x26 NACK, error 0x049c |
| TOGGLE_IMU_MODE (0x6A) | Full 12-byte payload, no CRC32 | 0x26 NACK, error 0x049c |
| GET_HELLO (0x91) | Full 12-byte payload | 0x26 NACK, error 0x049c |
| START_RAW_DATA (0x51) | Full 12-byte payload | 0x26 NACK, error 0x049c |
| Minimal `[0x23 0x6A]` | 2-byte payload | 0x26 NACK, error 0x049c |

The 0x26 response echoes the preamble and our sequence number, confirming the strap **parses** the frame correctly but **rejects** it at the application layer. No data flows on DATA_FROM_STRAP (0005) at all.

**Root cause**: The strap requires BLE bonding (established during the WHOOP app's initial setup flow on the phone). Without bonding, all commands are rejected. On iOS, piggybacking on the WHOOP app's bonded connection allows receiving passive data (console logs during sync), but our commands are still rejected because the bonding key belongs to the WHOOP app, not our app.

#### Revised path forward

The only viable paths to getting raw IMU data:

1. **Passive capture during Strength Trainer workouts (iOS)**: The WHOOP app sends TOGGLE_IMU_MODE from its bonded connection. The strap enters IMU mode and streams 0x2B packets on DATA_FROM_STRAP. Our iOS app, piggybacking via `retrieveConnectedPeripherals`, should be able to read these notifications passively. **This requires the user to start a Strength Trainer workout in the WHOOP app.**

2. **Reverse-engineer the WHOOP bonding/authentication flow**: Decompile the APK to find how the app establishes the bond and what error code 0x049c (1180) means. This would let us authenticate independently and send commands without the WHOOP app.

3. **MITM the protobuf upload**: Intercept the raw IMU data the WHOOP app uploads to `POST /weightlifting-service/v1/raw-data/protobuf` during Strength Trainer workouts.

#### BLE command enum (from APK decompilation)

Full command byte values from `EnumC6478e` in the decompiled APK (v5.439.0):

| Byte | Name | Notes |
|------|------|-------|
| 0x01 | LINK_VALID | First handshake command |
| 0x02 | GET_MAX_PROTOCOL_VERSION | |
| 0x03 | TOGGLE_REALTIME_HR | |
| 0x07 | REPORT_VERSION_INFO | |
| 0x0A | SET_CLOCK | |
| 0x16 | SEND_HISTORICAL_DATA | |
| 0x17 | HISTORICAL_DATA_RESULT | ACK for historical chunks |
| 0x22 | GET_DATA_RANGE | |
| 0x23 | GET_HELLO_HARVARD | Gen4 only, NOT generic "command type" |
| 0x33 | SET_DP_TYPE | (note: collides with REALTIME_IMU packet type) |
| 0x3F | SEND_R10_R11_REALTIME | |
| 0x51 | START_RAW_DATA | |
| 0x52 | STOP_RAW_DATA | |
| 0x69 | TOGGLE_IMU_MODE_HISTORICAL | = 105 decimal |
| 0x6A | TOGGLE_IMU_MODE | = 106 decimal |
| 0x73 | START_DEVICE_CONFIG_KEY_EXCHANGE | |
| 0x75 | START_FF_KEY_EXCHANGE | Feature flag key exchange |
| 0x91 | GET_HELLO | Newer straps (Maverick/Puffin) = 145 decimal |

**Important correction**: 0x23 is `GET_HELLO_HARVARD` (Gen4-specific handshake), NOT a generic "command packet type" as previously documented. The byte we were treating as "packet type 0x23 = COMMAND" in the frame format is actually the GET_HELLO_HARVARD command byte itself. The frame format documentation needs further investigation.

#### BLE bonding requirement (confirmed March 29, 2026)

**The strap requires BLE bonding before accepting ANY commands.** Tested with `packages/ble-probe` against a Puffin strap:

- Every command (LINK_VALID, GET_HELLO, TOGGLE_IMU_MODE, START_RAW_DATA) returns response type **0x26** with error code **0x049c (1180)**, regardless of frame format or CRC presence.
- The exact bytes from a successful PacketLogger capture (including valid CRC32) also get 0x049c when sent from an unbonded connection.
- The strap parses frames correctly (echoes sequence numbers, uses proper response structure) but rejects at the application layer.

This means direct command injection from an unbonded device is not possible. The strap's bonding is established during the WHOOP app's initial setup flow and tied to that app's BLE session.

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
