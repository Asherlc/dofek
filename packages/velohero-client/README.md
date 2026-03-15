# velohero-client

Unofficial VeloHero API client using reverse-engineered session authentication. Based on the [tapiriik](https://github.com/cpfair/tapiriik) reference implementation.

## Authentication

VeloHero uses a simple SSO endpoint that returns a session token. The token is used as a cookie for subsequent requests.

```typescript
import { VeloHeroClient } from "velohero-client";

const { sessionCookie, userId } = await VeloHeroClient.signIn(
  "email@example.com",
  "password"
);

const client = new VeloHeroClient(sessionCookie);
const workouts = await client.getWorkouts("2024-01-01", "2024-01-31");
```

## Data available

- **Workouts** across 12+ sport types (cycling, running, swimming, MTB, hiking, rowing, etc.)
- **Distance** (in km, converted to meters by parser)
- **Duration** (HH:MM:SS format)
- **Heart rate** (average, max)
- **Power** (average, max)
- **Cadence** (average, max)
- **Elevation** (ascent, descent)
- **Calories**

## API details

| Detail | Value |
|--------|-------|
| Base URL | `https://app.velohero.com` |
| Auth | POST `/sso` with username/password, returns session token |
| Cookie name | `VeloHero_session` |
| Session lifetime | ~24 hours (estimated) |
| Workouts endpoint | `/export/workouts/json` |
| Data format | JSON (all numeric values as strings) |
| Key quirk | All values are strings -- distance in km, duration in HH:MM:SS |

## Exports

- `VeloHeroClient` -- API client class with `signIn()`, `getWorkouts()`, `getWorkout()`
- `mapVeloHeroSport()` -- Map sport IDs to normalized types
- `VELOHERO_SPORT_MAP` -- Full sport ID mapping
- `parseVeloHeroWorkout()` -- Parse workout (handles string-to-number conversion, km-to-m)
- `parseDurationToSeconds()` -- Parse HH:MM:SS to seconds
- All response and parsed types
