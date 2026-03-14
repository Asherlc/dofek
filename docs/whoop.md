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
| Strength workouts | `GET /weightlifting-service/v2/weightlifting-workout/{activityId}` | Discovered, not yet synced. Exercise-level data: sets, reps, weight, muscle groups, MSK strain. |
| Heart rate | `GET /metrics-service/v1/metrics/user/<userId>` | 6-second interval time series. |
| Journal | `GET /behavior-impact-service/v1/impact` | Behavior/journal entries with impact scores. |

### Key implementation notes

- The cycles BFF limits queries to **200-day windows** — the provider loops in chunks.
- Strength Trainer workouts (sport_id=123) include an `msk_score` object with muscular load metrics, but this is aggregate only — no exercise-level data.

## Strength Trainer Data (exercises, sets, reps, weight)

### Status: Discovered via APK decompilation (March 2026)

Exercise-level strength data is available through the **`weightlifting-service`** — a separate internal microservice discovered by decompiling the WHOOP Android APK and probing the endpoints live. This service was not found during earlier endpoint probing because the service name (`weightlifting-service`) was not guessable from the public API surface.

### Key endpoint

**`GET /weightlifting-service/v2/weightlifting-workout/{activityId}`** returns full exercise-level data for a workout activity. The `activityId` is the UUID activity ID from the cycles BFF workout response.

Response includes:
- **Exercise details**: exercise name, equipment, muscle groups, movement pattern, laterality
- **Sets**: reps, weight (kg), duration, MSK volume per set
- **Workout-level metrics**: total effective volume (kg), raw/scaled MSK strain, cardio strain, strain contribution split
- **Zone durations**: time in each intensity zone (0-100%)

Example response shape:
```json
{
  "zone_durations": { "zone90_to100_duration": 0, ... },
  "workout_groups": [{
    "workout_exercises": [{
      "sets": [{
        "weight_kg": 0,
        "number_of_reps": 0,
        "msk_total_volume_kg": 255.876,
        "time_in_seconds": 60,
        "during": "['2026-03-12T21:37:00.000Z','2026-03-12T21:37:00.001Z')",
        "complete": true
      }],
      "exercise_details": {
        "exercise_id": "FRONTPLANKELBOW",
        "name": "Front Plank",
        "equipment": "BODY",
        "exercise_type": "STRENGTH",
        "muscle_groups": ["CORE"],
        "volume_input_format": "TIME"
      }
    }]
  }],
  "activity_id": "uuid",
  "total_effective_volume_kg": 2047.008,
  "raw_msk_strain_score": 0.0288,
  "scaled_msk_strain_score": 2.85552,
  "cardio_strain_score": 1.549,
  "cardio_strain_contribution_percent": 0.329,
  "msk_strain_contribution_percent": 0.671
}
```

### All discovered weightlifting-service endpoints

#### Working (GET)

| Endpoint | Description |
|----------|-------------|
| `GET /weightlifting-service/v2/weightlifting-workout/{activityId}` | Full exercise-level workout data |
| `GET /weightlifting-service/v1/exercise` | Full exercise catalog (~500+ exercises, flat array) |
| `GET /weightlifting-service/v2/exercise` | Same catalog, wrapped in `{"exercises": [...]}` |
| `GET /weightlifting-service/v1/link-workout` | UI data for linking workouts (templates, AI chat config) |
| `GET /weightlifting-service/v2/workout-template/{templateId}` | Workout template with planned exercises/sets |
| `GET /weightlifting-service/v2/workout-library` | WHOOP pre-built workout templates |
| `GET /weightlifting-service/v3/workout-library` | Same (v3) |
| `GET /weightlifting-service/v3/prs` | Personal records |

#### Write endpoints (POST, confirmed to exist via 405/422 responses)

| Endpoint | Description |
|----------|-------------|
| `POST /weightlifting-service/v2/weightlifting-workout/activity` | Create/link workout to activity |
| `POST /weightlifting-service/v2/custom-exercise` | Create custom exercise |
| `POST /weightlifting-service/v3/workout-template` | Create workout template |
| `POST /weightlifting-service/v2/performance-profile` | Write performance profile |
| `POST /weightlifting-service/v2/weightlifting-workout/link-cardio-workout` | Link cardio workout |
| `POST /weightlifting-service/v1/raw-data/protobuf` | Upload raw strap data |

#### Other paths (from APK decompilation, not all tested)

- `GET /weightlifting-service/v1/exercise/{exerciseId}`
- `GET /weightlifting-service/v2/custom-exercise/{exerciseId}`
- `GET /weightlifting-service/v1/share/{sharedWorkoutId}`
- `GET /weightlifting-service/v1/share/{workoutTemplateId}`
- `GET /weightlifting-service/v2/workout-template/{workoutTemplateKey}`
- `GET /weightlifting-service/v2/prebuilt-workout-template/{workoutTemplateId}`
- `GET /weightlifting-service/v1/link-workout-notification-dismissal/{activityId}`

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

1. Add a `getStrengthWorkout()` method to `WhoopInternalClient` that calls `GET /weightlifting-service/v2/weightlifting-workout/{activityId}`
2. Sync exercise-level data into the existing `strength_workout` / `strength_set` tables
3. Consider syncing the exercise catalog (`GET /weightlifting-service/v2/exercise`) for exercise metadata

### Investigation history

<details>
<summary>Earlier investigation (pre-APK decompilation)</summary>

#### Initial CORS-blocked endpoints

These endpoints returned CORS preflight errors (not 404) from the browser, suggesting they exist but are restricted to non-browser clients:

| Endpoint | Status |
|----------|--------|
| `/developer/v2/activity/strength-trainer` | CORS-blocked from browser. **Returns 404 from Node** — false positive. |
| `/fitness-service/v1/*` | CORS-blocked from browser. **Returns 404 from Node** — all path variations tested. |
| `/activities-service/v1/activities` | CORS-blocked from browser. **Returns 404 from Node**. |

#### Tested and confirmed 404 from Node

A comprehensive probe of ~45 endpoint variations was run from Node.js using a valid Cognito access token. **All returned 404.** This includes:
- `/developer/v2/activity/strength-trainer`
- `/fitness-service/v1/{exercises,workouts,strength,users/*/workouts,...}`
- `/strength-trainer-service/v1/*`
- `/msk-service/v1/*`, `/msk/v1/*`
- `/training-service/v1/*`
- `/workout-bff/v1/*`, `/workout-details-bff/v1/*`
- `/coach-service/v1/*`
- `/activities-service/v1/{activities,workout}/*`

The service name `weightlifting-service` was not among the guessed prefixes, which is why APK decompilation was needed.
</details>

### Community context

There is an [active feature request](https://www.community.whoop.com/t/api-for-strength-trainer/10517) on the WHOOP community forum for official API access to Strength Trainer exercise data. As of March 2026, it has not been added to the public developer API.
