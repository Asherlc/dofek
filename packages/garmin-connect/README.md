# garmin-connect

Unofficial Garmin Connect internal API client using the reverse-engineered SSO authentication flow. Based on the [garth](https://github.com/matin/garth) Python library and [python-garminconnect](https://github.com/cyberjunky/python-garminconnect).

## Why this exists

Garmin's official Health API (via developer program) provides limited data: activities, sleep, daily summaries, and body composition. The internal Connect API exposes **significantly more** data that Garmin shows in their app but doesn't surface through the official API:

- HRV (Heart Rate Variability) with nightly readings
- Body Battery with charge/drain values
- Stress levels with per-minute time series
- Training Readiness scores
- Training Status and load
- Race predictions
- Endurance and Hill scores
- Fitness age
- Second-by-second heart rate time series
- SpO2 time series
- FIT/TCX/GPX file downloads

## Authentication

Garmin uses a multi-step SSO flow with CSRF tokens, session cookies, OAuth1 ticket exchange, and finally OAuth2 tokens. Supports MFA.

```typescript
import { GarminConnectClient } from "garmin-connect";

const result = await GarminConnectClient.signIn("email@example.com", "password");

if (result.type === "mfa_required") {
  const mfaResult = await GarminConnectClient.verifyMfa(result, "123456");
  // Use mfaResult.oauth2.accessToken
}

if (result.type === "success") {
  const client = new GarminConnectClient(result.oauth2.accessToken);
  const activities = await client.searchActivities(0, 20);
  const sleep = await client.getSleepData("2024-01-15");
  const hrv = await client.getHrv("2024-01-15");
}
```

## Data available

### From internal API (NOT in official API)
- **HRV** -- nightly readings, weekly average, baseline, status
- **Body Battery** -- charge/drain values, time series
- **Stress** -- average level, duration breakdown, per-minute values
- **Training Readiness** -- composite score with sleep, recovery, HRV components
- **Training Status** -- load balance, 7-day and 28-day loads
- **Race Predictions** -- 5K, 10K, half marathon, marathon times
- **Max Metrics** -- VO2max (running + cycling), fitness age
- **Endurance Score** -- overall score, exhaustion level
- **Hill Score** -- strength and endurance factors
- **Heart Rate Time Series** -- second-by-second values
- **SpO2 Time Series** -- individual readings throughout night
- **Fitness Age** -- with component scores (BMI, vigorous minutes, resting HR, body fat)
- **Intensity Minutes** -- moderate vs vigorous breakdown
- **FIT/TCX/GPX Downloads** -- raw activity files

### From both official and internal API
- **Activities** with full metrics (HR, power, cadence, elevation, TSS, training effect)
- **Sleep** with stage breakdowns and scores
- **Daily Summary** (steps, distance, calories, floors)
- **Weight / Body Composition**

## API details

| Detail | Value |
|--------|-------|
| SSO URL | `https://sso.garmin.com/sso` |
| API Base URL | `https://connect.garmin.com` |
| OAuth URL | `https://connectapi.garmin.com/oauth-service/oauth` |
| Auth | SSO form login → OAuth1 ticket → OAuth2 token |
| MFA | Supported (SMS + TOTP) |
| User-Agent | `com.garmin.android.apps.connectmobile` |
| Data format | JSON |
| Key quirk | Weight in grams, distances sometimes in meters, sometimes km |

## SSO flow (5 steps)

1. `GET /sso/embed` -- initialize session cookies
2. `GET /sso/signin` -- extract CSRF token from HTML
3. `POST /sso/signin` -- submit credentials, receive SSO ticket
4. `GET oauth/preauthorized?ticket=...` -- exchange ticket for OAuth1 token
5. `POST oauth/exchange/user/2.0` -- exchange OAuth1 for OAuth2 access/refresh tokens

## Exports

- `GarminConnectClient` -- API client class with 20+ endpoint methods
- `mapGarminConnectSport()` -- Map activity type keys to normalized types
- `GARMIN_CONNECT_SPORT_MAP` -- Full sport key mapping (80+ activities)
- `parseGarminConnectActivity()` -- Parse activity with all training metrics
- `parseGarminConnectSleep()` -- Parse sleep with scores and SpO2
- `parseGarminConnectDailySummary()` -- Parse daily metrics with body battery and stress
- `parseGarminConnectWeight()` -- Parse weight (grams-to-kg, visceral fat, metabolic age)
- `parseGarminConnectHrv()` -- Parse HRV with baseline and status
- All response and parsed types
