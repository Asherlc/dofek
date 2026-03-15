# TrainerRoad API (Unofficial)

Unofficial/reverse-engineered API. TrainerRoad has no public API. All endpoints were discovered by inspecting the web app's network traffic. TrainerRoad may change these at any time.

Primary sources: [quinnsprouse/trainerroad-cli](https://github.com/quinnsprouse/trainerroad-cli) (most complete and recent, Feb 2026), [freekode/tp2intervals](https://github.com/freekode/tp2intervals) (Kotlin/Spring), [stuwilkins/python-trainerroad](https://github.com/stuwilkins/python-trainerroad), [pierceboggan/trainerroad-companion](https://github.com/pierceboggan/trainerroad-companion).

## Authentication

Cookie-based authentication via form login. No OAuth, no API keys.

### Login flow

1. **GET** `https://www.trainerroad.com/app/login?ReturnUrl=%2Fapp%2Fcareer%2F{username}`
   - Parse hidden form inputs: `ReturnUrl`, `__RequestVerificationToken`

2. **POST** `https://www.trainerroad.com/app/login`
   ```
   Content-Type: application/x-www-form-urlencoded

   Username=<email>&Password=<password>&ReturnUrl=<from step 1>&__RequestVerificationToken=<from step 1>
   ```

3. **Success**: HTTP 302 redirect to `/app/career/{username}`
   - Response sets `Set-Cookie: SharedTrainerRoadAuth=...`
   - This cookie is the sole auth mechanism for all subsequent requests.

### Auth cookie

All authenticated requests must include:
```
Cookie: SharedTrainerRoadAuth=<value>
```

Some endpoints also observe these headers:
```
trainerroad-jsonformat: camel-case
tr-cache-control: use-cache
```

### Cookie validation

To check if a cookie is still valid:
```
GET /app/api/member-info
Cookie: SharedTrainerRoadAuth=<value>
```
Returns member info on success, error on invalid/expired cookie.

## Base URL

```
https://www.trainerroad.com
```

All endpoints below are relative to this base.

## Core Data Endpoints

### GET /app/api/member-info

Returns the authenticated user's profile. Use this to get `memberId` and `username` needed by other endpoints.

```typescript
{
  MemberId: number;
  Username: string;
  // Additional profile metadata
}
```

### GET /app/api/react-calendar/{memberId}/timeline

The main data endpoint. Returns a compact summary of all activities, planned workouts, events, and annotations. Use this as the starting point to discover IDs for detail endpoints.

```typescript
{
  activities: Array<{
    id: number;                    // numeric activity ID
    // summary fields
  }>;
  plannedActivities: Array<{
    id: string;                    // UUID string
    // summary fields
  }>;
  events: Array<...>;
  annotations: Array<...>;
}
```

### GET /app/api/calendar/activities/{username}?startDate={YYYY-MM-DD}&endDate={YYYY-MM-DD}

Returns activities within a date range.

```typescript
Array<{
  Id: string;
  Date: string;                    // ISO datetime
  CompletedRide: {
    Name: string;
    Date: string;                  // ISO datetime
    IsOutside: boolean;
    Tss: number;
    EstimatedDuration: number;     // seconds
    Duration: number;              // seconds
    Distance: number;              // distance in km
    WorkoutRecordId: number;
  } | null;
  Activity: {
    Id: string;
  } | null;
}>
```

### Detail endpoints (require `ids` header)

These endpoints return 400 unless the `ids` header is present.

#### GET /app/api/react-calendar/{memberId}/activities
- Header: `ids: <comma-separated numeric IDs>`

#### GET /app/api/react-calendar/{memberId}/planned-activities
- Header: `ids: <comma-separated UUID strings>`

#### GET /app/api/react-calendar/{memberId}/personal-records
- Header: `ids: <comma-separated IDs>`

Get IDs from the `/timeline` response first.

## Activity Export

### POST /app/api/activities/{activityId}/exports/fit

Returns a FIT file for the given activity. Response is a binary file (application/octet-stream).

### GET /cycling/rides/download/{activityId}

Alternative: downloads a TCX file for the activity (older endpoint, may still work).

## Performance Data

### GET /app/api/career/{username}/new

Career summary including current FTP.

```typescript
{
  ftp: number;                     // watts
  weightKg: number;
  // plan flags, career stats
}
```

### GET /app/api/career/{memberId}/levels

Progression levels keyed by progression ID and timestamp.

### POST /app/api/personal-records/for-date-range/{memberId}?rowType=...&indoorOnly=...

Returns personal power records for date ranges.

Request body:
```json
[{"Slot": 1, "StartDate": "2013-05-10", "EndDate": "2026-02-23"}]
```

Response:
```typescript
{
  results: [{
    personalRecords: Array<...>
  }]
}
```

### GET /app/api/onboarding/power-ranking?memberId={memberId}

Power percentile rankings by duration.

### GET /app/api/ai-ftp-detection/can-use-ai-ftp/{memberId}

AI FTP detection eligibility.

```typescript
{
  can: boolean;
  reason: string;
  // additional detection data
}
```

### GET /app/api/calendar/aiftp/{memberId}/ai-failure-status

AI FTP failure status code.

## TSS / Training Load (Public)

### GET /app/api/tss/{username}

**No authentication required** for public profiles. Returns day-level training stress data.

Use header `trainerroad-jsonformat: camel-case` for camelCase keys.

```typescript
{
  tssByDay: Array<Array<{          // nested week/day arrays
    tss: number;
    plannedTssTrainerRoad: number;
    plannedTssOther: number;
    hasRides: boolean;             // unreliable for completion detection
  }>>;
}
```

From this data you can compute:
- CTL (Chronic Training Load / "Fitness"): 42-day exponentially weighted average of TSS
- ATL (Acute Training Load / "Fatigue"): 7-day exponentially weighted average of TSS
- TSB (Training Stress Balance / "Form"): CTL - ATL

## Workout Library

### GET /app/api/workouts/workout-profiles-by-zone

Returns the zone/profile catalog and duration buckets for filtering.

### POST /app/api/workouts

Search/browse the workout library.

Request body:
```json
{
  "pageNumber": 0,
  "pageSize": 50,
  "isDescending": false,
  "sortProperty": "...",
  "searchText": "",
  "progressions": {
    "profileIds": [],
    "progressionIds": []
  },
  "durations": { /* bucket booleans */ },
  "workoutInstructions": { "yup": false, "nope": false },
  "workoutTypes": { "outside": false }
}
```

Response:
```typescript
{
  predicate: { totalCount: number };
  workouts: Array<{
    id: number;
    workoutName: string;
    duration: number;              // seconds
    tss: number;
    intensityFactor: number;
    progressionId: number;
    progressionLevel: number;
    profileId: number;
    profileName: string;
    isOutside: boolean;
    hasInstructions: boolean;
  }>;
}
```

### POST /app/api/workouts/by-id

Fetch specific workouts by ID. Body is an array of numeric IDs: `[18128, 52417]`.

### GET /app/api/workoutdetails/{workoutId}

Returns full workout details with interval structure.

```typescript
{
  Workout: {
    Details: {
      Id: number;
      WorkoutName: string;
      WorkoutDescription: string;
      GoalDescription: string;
      IsOutside: boolean;
      Tss: number;
      Duration: number;
    };
    IntervalData: Array<{
      Start: number;               // seconds
      End: number;                 // seconds
      Name: string;
      IsFake: boolean;
      TestInterval: boolean;
      StartTargetPowerPercent: number;
    }>;
    workoutData: Array<{
      seconds: number;             // milliseconds (despite the name)
      ftpPercent: number;          // percentage of FTP (e.g. 75 = 75%)
    }>;
  };
}
```

### GET /app/api/workouts/{workoutId}/summary
### GET /app/api/workouts/{workoutId}/levels
### GET /app/api/workouts/{workoutId}/chart-data

Additional workout metadata endpoints.

### GET /app/api/careerworkouts

Returns all workouts in the user's career/history (older endpoint).

## Calendar Management

### GET /app/api/calendar/plannedactivities/{plannedActivityId}

Full planned workout/activity record.

### GET /app/api/calendar/plannedactivities/{plannedActivityId}/alternates/{category}

Get alternate workout suggestions. Categories: `similar`, `easier`, `harder`, `longer`, `shorter`.

### PUT /app/api/react-calendar/planned-activity/{plannedActivityId}/move

```json
{"newDate": {"year": 2026, "month": 3, "day": 13}}
```

### PUT /app/api/react-calendar/planned-activity/{plannedActivityId}/replace-with-alternate

```json
{"alternateWorkoutId": 1056132, "updateDuration": false}
```

### PUT /app/api/react-calendar/planned-activity/{plannedActivityId}/switch-to-inside
### PUT /app/api/react-calendar/planned-activity/{plannedActivityId}/switch-to-outside

### POST /app/api/calendar/plannedactivities/{plannedActivityId}/copy/{YYYY-MM-DD}

Copy a planned activity to another date. Returns 204.

### DELETE /app/api/calendar/plannedactivities/{plannedActivityId}

Delete a planned activity.

### POST /app/api/react-calendar/planned-tr-workout

Add a workout to calendar (may be unreliable -- observed HTTP 500s).

### POST /app/api/calendar/plannedactivities/workout

Alternative add-workout endpoint (also observed as unreliable).

## TrainNow / AI Workouts

### GET /app/api/train-now

Account-level TrainNow state.

```typescript
{
  hasTrainingPlan: boolean;
  hasPlanWorkoutToday: boolean;
  hasCompletedWorkoutToday: boolean;
}
```

### POST /app/api/train-now

Get AI workout suggestions.

Request: `{"duration": 60, "numSuggestions": 10}`

Response:
```typescript
{
  recommendedCategory: string;
  suggestions: {
    Attacking: Array<...>;
    Climbing: Array<...>;
    Endurance: Array<...>;
  };
  hasRpePredictionServiceFailure: boolean;
}
```

### GET /app/api/workout-information?ids=524179,265545

Enrich TrainNow suggestion IDs with workout card details.

## Notes

- **Cookie expiry**: The `SharedTrainerRoadAuth` cookie persists across sessions but will eventually expire. Validate with `/app/api/member-info` before use.
- **No rate limiting documented**, but be respectful. The web app makes requests in normal browsing patterns.
- **FIT export** is the best way to get detailed ride data (power, HR, cadence streams). The calendar endpoints only provide summary metrics (TSS, duration, distance).
- **The `workoutData.seconds` field is actually in milliseconds** despite the name. Divide by 1000 to get actual seconds.
- **The `hasRides` flag in TSS data is unreliable**. Use `tss > 0` (specifically `TssTrainerRoad + TssOther > 0`) to detect completed workouts.
- **Calendar write operations can be flaky**. Always verify changes by re-fetching the calendar state.
- **Add-workout endpoints have been observed returning HTTP 500** while still sometimes creating the calendar entry. Always reconcile against the refreshed calendar.
- **Profile rider page** at `/profile/rider-information` contains FTP, weight, timezone, gender, and privacy settings as form fields. The Python library reads/writes these via HTML scraping with CSRF tokens.

## Recommended Integration Strategy

For a sync provider:

1. Login once, persist the `SharedTrainerRoadAuth` cookie.
2. `GET /app/api/member-info` to get `memberId` and `username`.
3. `GET /app/api/calendar/activities/{username}?startDate=...&endDate=...` for activity list.
4. `POST /app/api/activities/{activityId}/exports/fit` to download FIT files for detailed data.
5. `GET /app/api/career/{username}/new` for current FTP/weight.
6. `GET /app/api/tss/{username}` for TSS history (public, no auth needed).
