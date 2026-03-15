# trainingpeaks-connect

Unofficial TrainingPeaks internal API client using cookie-based authentication. Based on community reverse engineering work, primarily [freekode/tp2intervals](https://github.com/freekode/tp2intervals) and [JamsusMaximus/trainingpeaks-mcp](https://github.com/JamsusMaximus/trainingpeaks-mcp).

## Why this exists

TrainingPeaks' Partner API requires partnership approval (personal use blocked) and has significant limitations: metrics are write-only, Performance Management Chart data (CTL/ATL/TSB) is unavailable, and many workout fields require Premium accounts. The internal web API provides full access to all data.

## Authentication

TrainingPeaks does not have a programmatic login endpoint. You must obtain the `Production_tpAuth` cookie from a browser session:

1. Log in at [app.trainingpeaks.com](https://app.trainingpeaks.com)
2. Open DevTools -> Application -> Cookies
3. Copy the value of `Production_tpAuth`

```typescript
import { TrainingPeaksConnectClient } from "trainingpeaks-connect";

// Exchange cookie for Bearer token
const { accessToken } = await TrainingPeaksConnectClient.exchangeCookieForToken(cookieValue);

// Create client
const client = new TrainingPeaksConnectClient(accessToken);

// Get user to find athleteId
const user = await client.getUser();
const athleteId = user.user.athletes[0].athleteId;

// Fetch workouts
const workouts = await client.getWorkouts(athleteId, "2024-01-01", "2024-03-31");

// Get Performance Management Chart (CTL/ATL/TSB)
const pmc = await client.getPerformanceManagement(athleteId, "2024-01-01", "2024-06-30");
```

Cookie can be refreshed programmatically:
```typescript
const newCookie = await TrainingPeaksConnectClient.refreshCookie(oldCookieValue);
```

## Data available

### Not in Partner API (internal only)
- **Performance Management Chart** -- CTL (fitness), ATL (fatigue), TSB (form) time series
- **Read metrics** -- Partner API is write-only for metrics
- **Personal records** -- Power peaks, speed records by sport
- **Workout analysis** -- Full time-series channels, zone analysis, lap data (via separate analysis API)
- **Calendar notes** -- Coach/athlete notes

### Workout fields (Premium accounts)
- Power: average, normalized, max
- Heart rate: average, max, min
- TSS, Intensity Factor
- Cadence, elevation gain/loss, calories
- Feeling (1-10), RPE (1-10)
- Tags, coach/athlete comments

## API details

| Detail | Value |
|--------|-------|
| Primary API | `https://tpapi.trainingpeaks.com` |
| Analysis API | `https://api.peakswaresb.com` |
| Auth | Cookie → Bearer token exchange |
| Token lifetime | ~1 hour |
| Cookie lifetime | Several weeks (refreshable) |
| Rate limiting | ~150ms between requests recommended |
| Max date range | 90 days for workout queries |
| Key quirk | `totalTime` is in decimal hours (1.25 = 1h15m) |

## Sport type mapping

| Family ID | Sport |
|-----------|-------|
| 1 | Swimming |
| 2 | Cycling |
| 3 | Running |
| 4 | Walking |
| 5 | Rowing |
| 6 | Skiing |
| 7 | Strength |
| 8 | Yoga |
| 9 | Hiking |
| 10 | Other |
| 11 | Triathlon |
| 12 | Rest/Day Off |
| 13 | Cardio |

## Exports

- `TrainingPeaksConnectClient` -- API client with cookie auth, workouts, PMC, personal records, workout analysis
- `mapTrainingPeaksSport()` -- Map workout type family ID to normalized sport
- `TRAINING_PEAKS_SPORT_MAP` -- Full sport family ID mapping
- `parseTrainingPeaksWorkout()` -- Parse workout with decimal hours → seconds conversion
- `parseTrainingPeaksPmc()` -- Parse PMC entry with readable field names (fitness/fatigue/form)
- `decimalHoursToSeconds()` -- Convert TrainingPeaks time format
- All response and parsed types
