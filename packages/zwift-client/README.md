# zwift-client

Unofficial Zwift API client using the reverse-engineered Keycloak authentication. The client ID (`Zwift Game Client`) is embedded in the game client and is publicly known.

## Authentication

Zwift uses Keycloak OpenID Connect with a resource owner password grant. Supports token refresh.

```typescript
import { ZwiftClient } from "zwift-client";

const { accessToken, refreshToken, expiresIn } = await ZwiftClient.signIn(
  "email@example.com",
  "password"
);

// Decode JWT to get athlete ID
const payload = JSON.parse(
  Buffer.from(accessToken.split(".")[1], "base64").toString()
);
const athleteId = Number(payload.sub);

const client = new ZwiftClient(accessToken, athleteId);
const activities = await client.getActivities(0, 20);
```

## Data available

- **Activities** (cycling, running) with summaries
- **Activity streams** -- second-by-second power, HR, cadence, speed, altitude, GPS
- **Athlete profile** (weight, height, FTP, total distances)
- **Power curve** with zFTP, zMAP, VO2max, and critical power efforts

## API details

| Detail | Value |
|--------|-------|
| Auth URL | `https://secure.zwift.com/auth/realms/zwift/protocol/openid-connect/token` |
| API Base URL | `https://us-or-rly101.zwift.com` |
| Auth | Keycloak password grant |
| Client ID | `Zwift Game Client` |
| Refresh tokens | Supported |
| Data format | JSON |
| Unit quirks | Speed in cm/s, altitude in cm, distance in cm, weight in grams |

## Exports

- `ZwiftClient` -- API client class
- `mapZwiftSport()` -- Map Zwift sport strings to normalized types
- `parseZwiftActivity()` -- Parse activity summary into normalized format
- `parseZwiftFitnessData()` -- Parse second-by-second stream data (handles cm-to-m conversion)
- `ZWIFT_AUTH_URL`, `ZWIFT_API_BASE` -- URL constants
- All response and parsed types
