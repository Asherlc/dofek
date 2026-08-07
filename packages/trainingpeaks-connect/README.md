# @dofek/trainingpeaks

Unofficial TypeScript client for private TrainingPeaks web endpoints. It reads
athlete workouts, profile data, Performance Management Chart data, personal
records, calendar notes, and workout analysis.

This package is not affiliated with, endorsed by, or supported by
TrainingPeaks. Its cookie flow and undocumented endpoints may change without
notice.

## Requirements and installation

Requires Node.js 22.14 or newer and its built-in
[`fetch`](https://nodejs.org/api/globals.html#fetch) implementation.

```sh
npm install @dofek/trainingpeaks
```

## Quick start

Log in to `app.trainingpeaks.com` in a browser and copy the value of its
`Production_tpAuth` cookie. Save this example as `example.mjs`, set
`TRAININGPEAKS_AUTH_COOKIE` and `TRAININGPEAKS_ATHLETE_ID`, then run
`node example.mjs`.

```js
import { TrainingPeaksConnectClient } from "@dofek/trainingpeaks";

const savedCookie = process.env.TRAININGPEAKS_AUTH_COOKIE;
const athleteId = Number(process.env.TRAININGPEAKS_ATHLETE_ID);
if (!savedCookie || !Number.isInteger(athleteId)) {
  throw new Error("Set TRAININGPEAKS_AUTH_COOKIE and TRAININGPEAKS_ATHLETE_ID");
}

const refreshedCookie =
  await TrainingPeaksConnectClient.refreshCookie(savedCookie);
const { accessToken, expiresIn } =
  await TrainingPeaksConnectClient.exchangeCookieForToken(refreshedCookie);
const client = new TrainingPeaksConnectClient(accessToken);
const workouts = await client.getWorkouts(
  athleteId,
  "2026-07-01",
  "2026-07-07",
);

console.log({ expiresIn, workouts: workouts.length });
// Replace the saved cookie with refreshedCookie in encrypted storage.
```

Dates passed to range methods use `YYYY-MM-DD`.

## Public API

Authentication:

- `TrainingPeaksConnectClient.refreshCookie(cookie, fetch?)` returns the
  replacement `Production_tpAuth` cookie from the observed refresh endpoint.
- `TrainingPeaksConnectClient.exchangeCookieForToken(cookie, fetch?)` returns
  `accessToken` and `expiresIn` in seconds.

Data:

- `getUser()`
- `getWorkouts(athleteId, startDate, endDate)` and
  `getWorkout(athleteId, workoutId)`
- `getWorkoutFitUrl(athleteId, workoutId)` — constructs the FIT download URL;
  the caller remains responsible for making an authenticated download request.
- `getPerformanceManagement(athleteId, startDate, endDate, options?)`
- `getPersonalRecords(athleteId, sport, recordType, startDate?, endDate?)`,
  where `sport` is `"Bike"` or `"Run"`.
- `getCalendarNotes(athleteId, startDate, endDate)`
- `getWorkoutAnalysis(workoutId, athleteId)`

Supported deep imports:

- `@dofek/trainingpeaks/client` — client class.
- `@dofek/trainingpeaks/parsing` — workout and Performance Management Chart
  parsers plus decimal-hour conversion.
- `@dofek/trainingpeaks/sports` — sport mapping table and mapper.
- `@dofek/trainingpeaks/types` — raw token, workout, analysis, profile, record,
  calendar-note, and chart interfaces.

```ts
import { parseTrainingPeaksWorkout } from "@dofek/trainingpeaks/parsing";
import type { TrainingPeaksWorkout } from "@dofek/trainingpeaks/types";
```

## Authentication and persistence

The [current implementation](https://github.com/Asherlc/dofek/blob/main/packages/trainingpeaks-connect/src/client.ts)
does not accept a username and password or use embedded application
credentials. It exchanges the browser-created `Production_tpAuth` cookie for a
bearer access token.

Treat both values as password-equivalent secrets. Persist the latest cookie and
token expiry in encrypted storage. The package does not refresh bearer tokens
directly: refresh the saved cookie, exchange it for a new token, replace the
stored cookie, and construct a new client. If cookie refresh fails because the
browser session is no longer accepted, log in through the TrainingPeaks site
again and capture a new cookie.

## Request constraints

The currently observed workout endpoint accepts at most 90 days per
`getWorkouts` call, as recorded alongside the
[implemented method](https://github.com/Asherlc/dofek/blob/main/packages/trainingpeaks-connect/src/client.ts).
The client does not validate or split longer spans, so callers performing
historical syncs must divide them into windows of 90 days or less.

Each client instance targets a minimum 150 ms interval between its API calls.
This is local pacing, not a guarantee against upstream throttling; coordinate
concurrent clients separately.

## Rate limits and errors

The shared
[rate-limit wrapper](https://github.com/Asherlc/dofek/blob/main/packages/provider-http/src/rate-limit.ts)
throws `ProviderRateLimitError` for `429` and
`ProviderServiceUnavailableError` for `502`, `503`, and `504`. Both expose
`providerId`, `statusCode`, `responseBody`, and `retryAfterSeconds`. The latter
follows the HTTP
[`Retry-After`](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after)
header when present. Other unsuccessful responses throw a regular `Error`
containing the response status and body.

If your application handles these error classes directly, declare
`@dofek/provider-http` as a direct dependency:

```sh
npm install @dofek/provider-http
```

```ts
import {
  ProviderRateLimitError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";

try {
  await client.getUser();
} catch (error) {
  if (
    error instanceof ProviderRateLimitError ||
    error instanceof ProviderServiceUnavailableError
  ) {
    console.error(error.providerId, error.statusCode, error.retryAfterSeconds);
  }
  throw error;
}
```

## Project

- [Source](https://github.com/Asherlc/dofek/tree/main/packages/trainingpeaks-connect)
- [Report an issue](https://github.com/Asherlc/dofek/issues)
- [Contribute a pull request](https://github.com/Asherlc/dofek/pulls)
- License: [MIT](./LICENSE)
