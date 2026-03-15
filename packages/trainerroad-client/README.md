# trainerroad-client

Unofficial TrainerRoad API client using reverse-engineered cookie-based authentication. Discovered via browser network inspection.

## Authentication

TrainerRoad uses classic web form login with CSRF protection. The sign-in flow:

1. GET the login page and extract the `__RequestVerificationToken` from the HTML
2. POST the login form with credentials and CSRF token
3. Extract the `SharedTrainerRoadAuth` cookie from the response
4. Use the cookie for all subsequent API calls

```typescript
import { TrainerRoadClient } from "trainerroad-client";

const { authCookie, username } = await TrainerRoadClient.signIn(
  "email@example.com",
  "password"
);

const client = new TrainerRoadClient(authCookie);
const activities = await client.getActivities(username, "2024-01-01", "2024-01-31");
```

## Data available

- **Activities** (cycling, running, virtual rides/runs) with completion date and duration
- **Training metrics** (TSS, normalized power, intensity factor)
- **Power and HR** (average, max)
- **Cadence and speed** (average, max)
- **Career data** (current FTP, weight)
- **Calories and elevation**

## API details

| Detail | Value |
|--------|-------|
| Base URL | `https://www.trainerroad.com` |
| Auth | Cookie-based form login with CSRF token |
| Cookie name | `SharedTrainerRoadAuth` |
| Cookie lifetime | ~30 days (estimated) |
| Refresh tokens | Not applicable -- re-authenticate when expired |
| Data format | JSON |
| Key quirk | `CompletedDate` is the end time; subtract `Duration` to get start time |

## Exports

- `TrainerRoadClient` -- API client class with `signIn()`, `getMemberInfo()`, `getActivities()`, `getCareer()`
- `mapTrainerRoadActivityType()` -- Map activity types considering indoor/outdoor
- `parseTrainerRoadActivity()` -- Parse activity into normalized format
- All response and parsed types
