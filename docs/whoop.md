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
| Heart rate | `GET /metrics-service/v1/metrics/user/<userId>` | 6-second interval time series. |
| Journal | `GET /behavior-impact-service/v1/impact` | Behavior/journal entries with impact scores. |

### Key implementation notes

- The cycles BFF limits queries to **200-day windows** — the provider loops in chunks.
- Strength Trainer workouts (sport_id=123) include an `msk_score` object with muscular load metrics, but this is aggregate only — no exercise-level data.

## Strength Trainer Data (exercises, sets, reps, weight)

### Status: Not yet accessible

The WHOOP app allows users to log individual exercises, sets, reps, and weight via the Strength Trainer feature. This data is stored on WHOOP's servers but is **not exposed through the public developer API** and **not shown in the web app** (mobile-only UI).

### Candidate endpoints

These endpoints returned CORS preflight errors (not 404) from the browser, suggesting they exist but are restricted to non-browser clients:

| Endpoint | Status |
|----------|--------|
| `/developer/v2/activity/strength-trainer` | CORS-blocked from browser. **Returns 404 from Node** — may be a false positive, or may require different auth/headers. |
| `/fitness-service/v1/*` | CORS-blocked from browser. **Returns 404 from Node** — all path variations tested. |
| `/activities-service/v1/activities` | CORS-blocked from browser. **Returns 404 from Node**. |

### Tested and confirmed 404 from Node (March 2026)

A comprehensive probe of ~45 endpoint variations was run from Node.js using a valid Cognito access token. **All returned 404.** This includes:
- `/developer/v2/activity/strength-trainer`
- `/fitness-service/v1/{exercises,workouts,strength,users/*/workouts,...}`
- `/strength-trainer-service/v1/*`
- `/msk-service/v1/*`, `/msk/v1/*`
- `/training-service/v1/*`
- `/workout-bff/v1/*`, `/workout-details-bff/v1/*`
- `/coach-service/v1/*`
- `/activities-service/v1/{activities,workout}/*`

**Important caveat**: This account had no Strength Trainer workouts logged at the time of testing. Some endpoints may only exist/respond once workout data exists. The CORS errors observed from the browser may also indicate the endpoints require mobile-app-specific client credentials or headers.

### Recommended next step: proxy the mobile app

The Strength Trainer UI is **mobile-only** (not in the web app). To discover the exercise-level API:
1. Install mitmproxy: `brew install mitmproxy`
2. Configure phone to proxy through Mac
3. Open a Strength Trainer workout in the Whoop app
4. Capture the API calls — look for requests to `api.prod.whoop.com` that contain exercise/set data

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

1. Run the exploration script to discover which endpoints return exercise-level data
2. Alternatively, proxy the WHOOP iOS app (Charles Proxy / mitmproxy) while viewing a Strength Trainer workout to capture the exact API calls
3. Once the endpoint and response shape are known, add a `getStrengthWorkout()` method to `WhoopInternalClient` and sync into the existing `strength_workout` / `strength_set` tables

### Community context

There is an [active feature request](https://www.community.whoop.com/t/api-for-strength-trainer/10517) on the WHOOP community forum for official API access to Strength Trainer exercise data. As of March 2026, it has not been added to the public developer API.
