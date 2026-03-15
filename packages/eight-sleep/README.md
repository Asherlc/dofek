# eight-sleep-client

Unofficial Eight Sleep API client using reverse-engineered authentication. Credentials extracted from the Eight Sleep Android app.

## Authentication

Eight Sleep uses a proprietary OAuth2 flow with hardcoded client credentials. No refresh tokens are issued -- re-authenticate when the token expires.

```typescript
import { EightSleepClient } from "eight-sleep-client";

const { accessToken, userId, expiresIn } = await EightSleepClient.signIn(
  "email@example.com",
  "password"
);

const client = new EightSleepClient(accessToken, userId);
const trends = await client.getTrends("America/New_York", "2024-01-01", "2024-01-31");
```

## Data available

- **Sleep sessions** with stage breakdowns (light, deep, REM, awake)
- **Sleep quality scores** (overall, HRV, respiratory rate, heart rate)
- **Sleep routine scores** (latency, consistency)
- **Daily metrics** (resting HR, HRV, respiratory rate)
- **Temperature** (bed and room)
- **Heart rate time series** from sleep sessions
- **Toss and turn** count

## API details

| Detail | Value |
|--------|-------|
| Auth Base URL | `https://auth-api.8slp.net/v1` |
| API Base URL | `https://client-api.8slp.net/v1` |
| Auth | OAuth2 password grant with hardcoded client credentials |
| Token endpoint | `/tokens` |
| User-Agent | `okhttp/4.9.3` (Android) |
| Refresh tokens | Not supported -- re-authenticate |
| Data format | JSON |

## Exports

- `EightSleepClient` -- API client class with `signIn()` and `getTrends()`
- `parseEightSleepTrendDay()` -- Parse a trend day into a sleep session
- `parseEightSleepDailyMetrics()` -- Extract HRV, resting HR, respiratory rate
- `parseEightSleepHeartRateSamples()` -- Extract HR time series from sessions
- All response and parsed types
