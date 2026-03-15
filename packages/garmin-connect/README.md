# garmin-connect

Unofficial TypeScript client for the Garmin Connect internal API. Provides access to granular health and training data that is not available through the official Garmin Health API.

## Why this exists

The official Garmin Health API provides basic daily summaries, but the internal Connect API (used by the Garmin Connect mobile app and web interface) exposes significantly more data:

- **Training Status** (Productive/Peaking/Recovery/Overreaching)
- **Training Readiness** score with component breakdowns
- **Training Load** (acute, chronic, balance, ratio)
- **VO2 Max** (separate values for running and cycling)
- **Body Battery** time-series (not just daily totals)
- **Stress** time-series (minute-by-minute)
- **HRV Status** with 7-day baseline trending
- **Activity streams** (second-by-second HR, power, cadence, GPS)
- **FIT file downloads**
- **Race Predictions**, Hill Score, Endurance Score
- **Sleep** with granular stages, SpO2 epochs, and movement data
- **Heart rate** time-series throughout the day

## Authentication

Authentication uses Garmin's SSO flow (same as the mobile app):

1. Login with email/password via Garmin SSO
2. Extract SSO ticket from response
3. Exchange ticket for OAuth1 token (OAuth 1.0a signed request)
4. Exchange OAuth1 for OAuth2 token
5. All API calls use the OAuth2 Bearer token

The OAuth consumer key/secret is fetched dynamically from a public S3 endpoint (same approach as the [garth](https://github.com/matin/garth) Python library).

```typescript
import { GarminConnectClient } from "garmin-connect";

// Sign in (first time)
const { client, tokens } = await GarminConnectClient.signIn(
  "user@example.com",
  "password"
);

// Save tokens for later use
saveToDatabase(tokens);

// Restore from saved tokens (subsequent uses)
const client = await GarminConnectClient.fromTokens(savedTokens);
```

## Usage

```typescript
// Daily summary
const summary = await client.getDailySummary("2024-01-15");

// Training metrics
const status = await client.getTrainingStatus("2024-01-15");
const readiness = await client.getTrainingReadiness("2024-01-15");

// Time-series data
const stress = await client.getDailyStress("2024-01-15");
const heartRate = await client.getDailyHeartRate("2024-01-15");

// HRV
const hrv = await client.getHrvSummary("2024-01-15");

// Body battery
const bodyBattery = await client.getBodyBatteryDaily("2024-01-15");

// Sleep
const sleep = await client.getSleepData("2024-01-15");

// Activities
const activities = await client.getActivities(0, 20);
const detail = await client.getActivityDetail(activityId);
const fitFile = await client.downloadFitFile(activityId);

// Scores
const vo2max = await client.getVo2Max("2024-01-01", "2024-01-15");
const racePredictions = await client.getRacePredictions();
const hillScore = await client.getHillScore("2024-01-01", "2024-01-15");
const endurance = await client.getEnduranceScore("2024-01-01", "2024-01-15");

// Respiration & SpO2
const respiration = await client.getDailyRespiration("2024-01-15");
const spo2 = await client.getDailySpO2("2024-01-15");
```

## Parsing

Pure parsing functions are provided to normalize raw API responses:

```typescript
import {
  parseConnectActivity,
  parseConnectSleep,
  parseConnectDailySummary,
  parseTrainingStatus,
  parseTrainingReadiness,
  parseHrvSummary,
  parseStressTimeSeries,
  parseHeartRateTimeSeries,
  parseActivityDetail,
} from "garmin-connect";
```

## Exported modules

| Module | Description |
|--------|-------------|
| `client.ts` | `GarminConnectClient` — authentication and API methods |
| `types.ts` | TypeScript interfaces for all API response shapes |
| `parsing.ts` | Pure parsing functions and normalized output types |
| `oauth1.ts` | Minimal OAuth 1.0a signing for the auth flow |

## Credits

Authentication flow reverse-engineered from:
- [garth](https://github.com/matin/garth) — Python Garmin SSO library
- [python-garminconnect](https://github.com/cyberjunky/python-garminconnect) — Python Garmin Connect API wrapper
