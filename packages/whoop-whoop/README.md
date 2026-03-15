# whoop-whoop

Unofficial WHOOP API client using the internal Cognito-based authentication. Reverse-engineered from the WHOOP mobile app and web client.

## Authentication

WHOOP uses AWS Cognito proxied through their own endpoint. The client supports:

- Email/password sign-in via `USER_PASSWORD_AUTH`
- MFA challenges (SMS and TOTP)
- Token refresh via `REFRESH_TOKEN_AUTH`

```typescript
import { WhoopClient } from "whoop-whoop";

const result = await WhoopClient.signIn("email@example.com", "password");
if (result.type === "authenticated") {
  const client = new WhoopClient(result.token);
  const cycles = await client.getCycles("2024-01-01", "2024-01-31");
}
```

## Data available

- **Cycles** with embedded recovery, sleep, and workout data
- **Sleep** with stage breakdowns (light, deep, REM, awake)
- **Recovery** scores (HRV, resting HR, SpO2, skin temp)
- **Workouts** with strain, HR zones, and calories
- **Strength training** with exercise-level sets, reps, and weight (discovered via APK decompilation)
- **Heart rate** streams at 6-second intervals
- **Journal entries** with behavioral impact scores

## API details

| Detail | Value |
|--------|-------|
| Base URL | `https://api.prod.whoop.com` |
| Auth | Cognito `USER_PASSWORD_AUTH` |
| Cognito Client ID | `37365lrcda1js3fapqfe2n40eh` |
| Auth Endpoint | `/auth-service/v3/whoop/` |
| Data format | JSON |
| Pagination | 200-day window limit on cycles |

## Exports

- `WhoopClient` -- API client class
- `mapSportId()` -- Map WHOOP sport IDs to normalized activity types
- `WHOOP_SPORT_MAP` -- Full sport ID mapping (70+ activities)
- `parseDuringRange()` -- Parse Postgres range strings
- All response types (`WhoopCycle`, `WhoopSleepRecord`, etc.)
