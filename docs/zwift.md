# Zwift API (Unofficial)

Unofficial/reverse-engineered API used by the Zwift game client and companion app. There is no official public API. Zwift may change endpoints at any time without notice.

Primary sources: [rally25rs/zwift-api-wrapper](https://github.com/rally25rs/zwift-api-wrapper) (TypeScript, most complete), [strukturunion-mmw/zwift-api-documentation](https://github.com/strukturunion-mmw/zwift-api-documentation).

## Authentication

Zwift uses Keycloak OpenID Connect with a resource owner password grant (username + password directly, no browser redirect).

### Token endpoint

```
POST https://secure.zwift.com/auth/realms/zwift/protocol/openid-connect/token
Content-Type: application/x-www-form-urlencoded

client_id=Zwift Game Client
grant_type=password
username=<email>
password=<password>
```

### Token response

```json
{
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "expires_in": 21600,
  "token_type": "Bearer"
}
```

- Store `access_token`, `refresh_token`, and compute `expires_at = expires_in * 1000 + Date.now()`.
- Use `Authorization: Bearer <access_token>` on all API calls.
- Refresh before expiry using the same endpoint with `grant_type=refresh_token` and `refresh_token=<token>`.

### Refresh flow

```
POST https://secure.zwift.com/auth/realms/zwift/protocol/openid-connect/token
Content-Type: application/x-www-form-urlencoded

client_id=Zwift Game Client
grant_type=refresh_token
refresh_token=<refresh_token>
```

### Required default headers

All requests to the API host should include:

```
Platform: OSX
Source: Game Client
User-Agent: CNL/3.30.8 (macOS 13 Ventura; Darwin Kernel 22.4.0) zwift/1.0.110983 curl/7.78.0
```

Some endpoints require `Zwift-Api-Version: 2.7` (e.g., `/api/game_info`).

## Base URLs

| Service | URL |
|---------|-----|
| Auth | `https://secure.zwift.com` |
| API | `https://us-or-rly101.zwift.com` |
| ZwiftPower | `https://zwiftpower.com` |

## Zwift API Endpoints

All paths are relative to `https://us-or-rly101.zwift.com`.

### Profile

#### GET /api/profiles/{athleteId}

Returns the full profile for any athlete.

Response type: `ZwiftProfile`

```typescript
{
  id: number;
  publicId: string;               // UUID
  firstName: string;
  lastName: string;
  male: boolean;
  age: number;
  dob: string;                    // "mm/dd/yyyy"
  height: number;                 // cm
  weight: number;                 // grams (divide by 1000 for kg)
  ftp: number;                    // watts
  emailAddress: string;
  countryAlpha3: string;
  countryCode: number;
  useMetric: boolean;
  riding: boolean;
  connectedToStrava: boolean;
  connectedToTrainingPeaks: boolean;
  connectedToGarmin: boolean;
  connectedToWithings: boolean;
  connectedToFitbit: boolean;
  connectedToZwiftPower: boolean;
  createdOn: string;              // "2020-09-07T17:53:34.375+0000"
  totalDistance: number;           // meters
  totalDistanceClimbed: number;   // meters
  totalTimeInMinutes: number;
  totalWattHours: number;
  totalExperiencePoints: number;
  achievementLevel: number;
  // Running stats
  totalRunDistance: number;
  totalRunTimeInMinutes: number;
  totalRunCalories: number;
  runTime1miInSeconds: number;
  runTime5kmInSeconds: number;
  runTime10kmInSeconds: number;
  runTimeHalfMarathonInSeconds: number;
  runTimeFullMarathonInSeconds: number;
  // Equipment
  powerSourceType: string;
  powerSourceModel: string;
  virtualBikeModel: string;
  // Privacy
  privacy: {
    approvalRequired: boolean;
    displayWeight: boolean;
    minor: boolean;
    privateMessaging: boolean;
    defaultFitnessDataPrivacy: boolean;
    defaultActivityPrivacy: string;    // "PUBLIC" | "PRIVATE"
  };
  socialFacts: {
    profileId: number;
    followersCount: number;
    followeesCount: number;
    followerStatusOfLoggedInPlayer: string;
    followeeStatusOfLoggedInPlayer: string;
    isFavoriteOfLoggedInPlayer: boolean;
  } | null;
}
```

### Power Profile

#### GET /api/power-curve/power-profile

Returns the authenticated user's power curve and zFTP.

```typescript
{
  zftp: number;                   // watts
  zmap: number;                   // watts (max aerobic power)
  vo2max: number;                 // ml/kg/min
  validPowerProfile: boolean;
  cpBestEfforts: {
    pointsWatts: Record<string, { value: number; date: string }>;
    // Key is duration in seconds, e.g. "1020": { value: 264.0, date: "2023-10-25T..." }
    pointsWattsPerKg: Record<string, { value: number; date: string }>;
  };
  relevantCpEfforts: Array<{
    watts: number;
    wattsKg: number;
    cpLabel: string;              // "5 sec", "1 min", "5 min", "20 min"
    duration: number;             // seconds
    cpTimestamp: string;
  }>;
  category: string;               // "A", "B", "C", "D", "E"
  categoryWomen: string;
  weightInGrams: number;
  metricsTimestamp: string;
}
```

### Activities

#### GET /api/profiles/{athleteId}/activities

Returns recent activities for an athlete. Supports pagination with `?start=N&limit=N`.

Response type: `ZwiftActivitySummary[]`

```typescript
{
  id_str: string;                  // unique activity ID as string
  id: number;                      // numeric activity ID
  profileId: number;
  worldId: number;
  name: string;
  sport: string;                   // "CYCLING" | "RUNNING"
  startDate: string;               // "2023-10-24T23:08:36.323+0000"
  endDate: string;
  lastSaveDate: string;
  duration: string;                // "1:4" (hours:minutes)
  distanceInMeters: number;
  totalElevation: number;          // meters
  avgWatts: number;
  calories: number;
  movingTimeInMs: number;
  privacy: string;                 // "PUBLIC"
  privateActivity: boolean;
  autoClosed: boolean;
  fitFileBucket: string;           // S3 bucket for .fit file
  fitFileKey: string;              // S3 key: "prod/{athleteId}/{hash}-{activityIdStr}"
  primaryImageUrl: string | null;
  profile: ZwiftShortProfile;
}
```

#### GET /api/activities/{activityId}?fetchSnapshots={bool}&fetchEvent={bool}

Returns detailed activity data including heart rate, power, cadence, speed, and fitness data URLs.

```typescript
{
  avgHeartRate: number;
  maxHeartRate: number;
  maxWatts: number;
  avgCadenceInRotationsPerMinute: number;
  maxCadenceInRotationsPerMinute: number;
  avgSpeedInMetersPerSecond: number;
  maxSpeedInMetersPerSecond: number;
  percentageCompleted: number;
  profileFtp: number;              // watts at time of activity
  profileMaxHeartRate: number;
  fitnessData: {
    status: string;                // "AVAILABLE"
    fullDataUrl: string;           // URL to download detailed fitness data
    smallDataUrl: string;
  };
  rideOnTimes: number[];           // seconds into ride when ride-ons received
  eventInfo?: {
    id: number;
    eventSubGroupId: number;
    name: string;
    sport: string;
    durationInSeconds: number;
    distanceInMeters: number;
    laps: number;
  };
  subgroupResults: {
    topResults: ZwiftActivityAthleteResult[];
    nearPlayerResults: ZwiftActivityAthleteResult[];
  };
  notableMoments: Array<{
    notableMomentTypeId: number;
    activityId: number;
    incidentTime: number;
    priority: number;
    aux1: string;
    aux2: string;
  }>;
  socialInteractions: Array<{
    profile: { id: number; publicId: string; firstName: string; lastName: string; };
    proximityTimeScore: number;
    timeDuration: number;
  }>;
}
```

### Activity Fitness Data (Streams)

#### GET {fitnessData.fullDataUrl}

The URL comes from the activity detail response. Returns second-by-second data streams.

```typescript
{
  powerInWatts: number[];
  cadencePerMin: number[];
  heartRate: number[];
  distanceInCm: number[];
  speedInCmPerSec: number[];
  timeInSec: number[];
  altitudeInCm: number[];
  latlng: Array<[number, number]>;
}
```

### Activity Feed

#### GET /api/activity-feed/feed/?limit=30&includeInProgress=false&feedType=JUST_ME

Returns the authenticated user's recent activity feed.

```typescript
Array<{
  id: number;
  id_str: string;
  profile: {
    id: string;
    firstName: string;
    lastName: string;
    imageSrc: string;
  };
  worldId: number;
  name: string;
  sport: string;
  startDate: string;
  endDate: string;
  distanceInMeters: number;
  totalElevation: number;
  calories: number;
  movingTimeInMs: number;
  avgSpeedInMetersPerSecond: number;
  activityRideOnCount: number;
  activityCommentCount: number;
  privacy: string;
  eventId: string | number | null;
}>
```

### Social

#### GET /api/profiles/{athleteId}/followees?start=0&limit=100

Paginated list of who an athlete follows.

#### GET /api/profiles/{athleteId}/followers?start=0&limit=100

Paginated list of an athlete's followers.

```typescript
// Both return:
Array<{
  id: number;
  followerId: number;
  followeeId: number;
  status: string;                  // "IS_FOLLOWING"
  isFolloweeFavoriteOfFollower: boolean;
  followerProfile: ZwiftShortProfile | null;  // populated for /followers
  followeeProfile: ZwiftShortProfile | null;  // populated for /followees
}>
```

#### POST /api/profiles/{us}/following/{them}

Follow another athlete. Body: `{ followeeId: them, followerId: us }`

#### POST /api/search/profiles

Search for athletes. Body: `{ query: "search text" }`. Paginated.

### Events

#### GET /api/events/{eventId}

Returns full event details including subgroups, schedule, and entrant counts.

#### GET /api/events/subgroups/entrants/{subgroupId}?type=all&participation=signed_up

Returns profiles of signed-up entrants. Paginated.

#### POST /api/events/subgroups/signup/{subgroupId}

Sign up for an event subgroup.

#### GET /api/race-results/entries?event_subgroup_id={id}&start=0&limit=100

Paginated race results for an event subgroup.

### Private Events / Meetups

#### GET /api/private_event/feed?organizer_only_past_events=false&start_date={ISO}&end_date={ISO}

Returns private events/meetups feed.

#### GET /api/private_event/{id}

Returns a specific private event.

### Game Info

#### GET /api/game_info

Requires header `Zwift-Api-Version: 2.7`. Returns maps, routes, achievements, segments, jerseys, bike frames, training plans, and world schedules.

### Notifications

#### GET /api/notifications

Returns the authenticated user's notifications (ride-ons, follows, etc.).

## ZwiftPower Endpoints

ZwiftPower uses a separate cookie-based SSO auth flow through Zwift's OAuth. Authentication requires:

1. `GET https://zwiftpower.com/ucp.php?mode=login&login=external&oauth_service=oauthzpsso` -> 302
2. Follow redirect to `secure.zwift.com` login form
3. Submit credentials -> 302 chain back to ZwiftPower
4. Session cookies (`phpbb3_lswlk_sid`, `phpbb3_lswlk_u`) are set

### GET https://zwiftpower.com/cache3/profile/{athleteId}_all.json

Athlete's recent race/event results with detailed power data.

### GET https://zwiftpower.com/cache3/results/{eventId}_zwift.json

Event results from Zwift's perspective.

### GET https://zwiftpower.com/cache3/results/{eventId}_view.json

Detailed event results with per-athlete power breakdowns (5s, 15s, 30s, 60s, 120s, 300s, 1200s power).

### GET https://zwiftpower.com/api3.php?do=critical_power_profile&zwift_id={athleteId}&zwift_event_id={eventId}&type=watts

Critical power profile data.

### GET https://zwiftpower.com/api3.php?do=analysis&zwift_id={athleteId}&zwift_event_id={eventId}

Detailed ride analysis with second-by-second power, HR, elevation data.

## Pagination

Most list endpoints support `?start=N&limit=N` query params. Default limit is typically 100. The zwift-api-wrapper uses a page limit of 10 pages by default.

## Rate Limiting

No documented rate limits, but Zwift may throttle or block excessive requests. The zwift-api-wrapper supports connection pooling (round-robin credentials) to distribute load.

## Notes

- Zwift does not have 2FA/MFA support for the game client auth, so the password grant works.
- The `id` vs `id_str` pattern exists because JavaScript loses precision on large numbers. Always use `id_str` for activity IDs.
- Weight is stored in grams (multiply by 0.001 for kg).
- Distance is in meters for activities, centimeters for fitness data streams.
- Speed is in m/s for activities, cm/s for fitness data streams.
- Altitude is in cm in fitness data streams.
- FIT files can be downloaded from S3 using the `fitFileBucket` and `fitFileKey` from activity summaries.
