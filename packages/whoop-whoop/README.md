# whoop-whoop

Unofficial WHOOP API client using WHOOP's internal Cognito-based authentication. This is not based on the official WHOOP developer API — it uses the same endpoints as the WHOOP mobile app and web dashboard.

## Features

- **Cognito authentication** — sign in with email/password, with MFA (SMS and TOTP) support
- **Token refresh** — refresh expired access tokens without re-authenticating
- **Heart rate** — fetch granular heart rate data for a time range
- **Cycles** — fetch physiological cycles with recovery scores, sleep, and workouts
- **Sleep** — fetch detailed sleep records with stage breakdowns and sleep scores
- **Workouts** — workout data with strain, heart rate zones, and distance
- **Weightlifting** — exercise-level strength training data (sets, reps, weight, muscle groups)
- **Journal** — behavioral journal / impact data
- **Sport ID mapping** — translate WHOOP's numeric sport IDs to human-readable names

## Usage

### Authentication

```typescript
import { WhoopClient } from "whoop-whoop";

// Simple sign-in (no MFA)
const token = await WhoopClient.authenticate("email@example.com", "password");
const client = new WhoopClient(token);

// Sign-in with MFA
const result = await WhoopClient.signIn("email@example.com", "password");
if (result.type === "verification_required") {
  const token = await WhoopClient.verifyCode(
    result.session,
    "123456", // MFA code
    "email@example.com",
  );
  const client = new WhoopClient(token);
}

// Refresh an expired token
const refreshed = await WhoopClient.refreshAccessToken(token.refreshToken);
```

### Fetching data

```typescript
const heartRate = await client.getHeartRate("2025-01-01T00:00:00Z", "2025-01-02T00:00:00Z");
const cycles = await client.getCycles("2025-01-01T00:00:00Z", "2025-01-07T00:00:00Z");
const sleep = await client.getSleep(sleepId);
const strengthData = await client.getWeightliftingWorkout(activityId);
```

### Sport ID mapping

```typescript
import { mapSportId } from "whoop-whoop";

mapSportId(0);  // "running"
mapSportId(45); // "weightlifting"
mapSportId(97); // "spin"
```

### Utilities

```typescript
import { parseDuringRange } from "whoop-whoop";

// Parse WHOOP's Postgres range format into Date objects
const { start, end } = parseDuringRange("['2025-01-01T10:00:00Z','2025-01-01T11:00:00Z')");
```

## API

### `WhoopClient`

| Method | Description |
|---|---|
| `WhoopClient.signIn(email, password)` | Sign in, returns token or MFA challenge |
| `WhoopClient.verifyCode(session, code, email)` | Complete MFA verification |
| `WhoopClient.authenticate(email, password)` | Sign in (no MFA accounts only) |
| `WhoopClient.refreshAccessToken(refreshToken)` | Refresh an expired access token |
| `client.getHeartRate(start, end, step?)` | Fetch heart rate samples |
| `client.getCycles(start, end, limit?)` | Fetch physiological cycles |
| `client.getSleep(sleepId)` | Fetch a sleep record |
| `client.getJournal(start, end)` | Fetch journal/impact data |
| `client.getWeightliftingWorkout(activityId)` | Fetch strength training details |

### `mapSportId(sportId: number): string`

Maps a numeric WHOOP sport ID to a human-readable activity name. Returns `"other"` for unknown IDs.

### `parseDuringRange(during: string): { start: Date; end: Date }`

Parses WHOOP's Postgres range format (e.g., `"['2025-01-01T10:00:00Z','2025-01-01T11:00:00Z')"`) into start and end `Date` objects.
