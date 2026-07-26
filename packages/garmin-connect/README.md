# @dofek/garmin-connect

Unofficial TypeScript client for private Garmin Connect web/mobile endpoints. It
supports the observed SSO-to-OAuth flow and reads activities, sleep, daily
health data, and training metrics.

This package is not affiliated with, endorsed by, or supported by Garmin.
Private endpoints and authentication pages may change without notice. For a
supported commercial integration, Garmin offers the official
[Garmin Connect Developer Program](https://developer.garmin.com/gc-developer-program/overview/);
this package does not use that program.

## Requirements and installation

Requires Node.js 22.14 or newer and its built-in
[`fetch`](https://nodejs.org/api/globals.html#fetch) implementation.

```sh
npm install @dofek/garmin-connect
```

## Quick start

Save this as `example.mjs`, set `GARMIN_EMAIL` and `GARMIN_PASSWORD`, then run
`node example.mjs`.

```js
import { GarminConnectClient } from "@dofek/garmin-connect";

const email = process.env.GARMIN_EMAIL;
const password = process.env.GARMIN_PASSWORD;
if (!email || !password) {
  throw new Error("Set GARMIN_EMAIL and GARMIN_PASSWORD");
}

const { client, tokens } = await GarminConnectClient.signIn(email, password);
const activities = await client.getActivities(0, 10);

console.log(
  activities.map(({ activityId, activityName }) => ({
    activityId,
    activityName,
  })),
);

// Store this value in encrypted storage, not in source control.
const credentialsToPersist = client.getTokens() ?? tokens;
console.log(`OAuth2 expires at ${credentialsToPersist.oauth2.expires_at}`);
```

Dates passed to daily and range methods use `YYYY-MM-DD`.

## Public API

Authentication and profile:

- `GarminConnectClient.signIn(email, password, domain?, fetch?)`
- `GarminConnectClient.fromTokens(tokens, domain?, fetch?)`
- `client.getTokens()`, `client.getDisplayName()`, and
  `client.getUserSettings()`

Activities and files:

- `getActivities`, `getActivityDetail`, and `downloadFitFile`

Daily health:

- `getDailySummary`, `getSleepData`, `getDailyHeartRate`,
  `getDailyStress`, `getBodyBatteryDaily`, `getBodyBatteryEvents`,
  `getHrvSummary`, `getDailyRespiration`, `getDailySpO2`,
  `getDailyIntensityMinutes`, `getDailySteps`, and `getFloors`

Training:

- `getTrainingStatus`, `getTrainingReadiness`, `getVo2Max`,
  `getRacePredictions`, `getHillScore`, and `getEnduranceScore`

Supported deep imports:

- `@dofek/garmin-connect/client` — client, throttle guidance constant, and
  Garmin-specific error classes.
- `@dofek/garmin-connect/parsing` — normalized activity, sleep, daily metric,
  training, HRV, stress, heart-rate, and activity-stream parsers.
- `@dofek/garmin-connect/sports` — sport mapping table and mapper.
- `@dofek/garmin-connect/types` — raw API and token interfaces.
- `@dofek/garmin-connect/oauth1` — low-level OAuth 1.0 header construction.

```ts
import { parseConnectSleep } from "@dofek/garmin-connect/parsing";
import type { GarminTokens } from "@dofek/garmin-connect/types";
```

## Authentication and persistence

The current implementation:

1. Loads Garmin's SSO pages and extracts their CSRF token and cookies.
2. Submits the user's email and password and extracts an SSO ticket.
3. Exchanges that ticket for OAuth1 credentials.
4. Exchanges OAuth1 credentials for an OAuth2 bearer token.

OAuth consumer credentials are not embedded in this package. The
[current implementation](https://github.com/Asherlc/dofek/blob/main/packages/garmin-connect/src/client.ts)
fetches them at runtime from the public
[`thegarth.s3.amazonaws.com/oauth_consumer.json`](https://thegarth.s3.amazonaws.com/oauth_consumer.json)
resource used by the observed flow. The package does embed observed Garmin
mobile-app user-agent identifiers.

Persist the complete `GarminTokens` result in encrypted storage. `fromTokens`
and authenticated API calls exchange the saved OAuth1 credential for a new
OAuth2 token when `expires_at` has passed. Call `getTokens()` after requests and
replace the stored value so refreshed OAuth2 metadata and `displayName` are
retained. If the OAuth1 credential is no longer accepted, sign in again.

Interactive MFA is not implemented. Accounts whose SSO response requires MFA
receive `GarminMfaRequiredError`; this client cannot complete that challenge.
Never log or commit passwords or token objects.

## Rate limits and errors

The client exports:

- `GarminMfaRequiredError` and `GarminAuthError` for authentication failures.
- `GarminRateLimitError` for `429` responses handled by the JSON API and OAuth
  exchange paths. It extends `ProviderRateLimitError` and exposes
  `retryAfterSeconds`, parsed from HTTP
  [`Retry-After`](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after)
  when available.
- `GarminApiError` for other API failures, with `statusCode`. The FIT download
  path reports all unsuccessful responses, including a possible `429`, as
  `GarminApiError`.

```ts
import {
  GARMIN_CONNECT_THROTTLE_MS,
  GarminApiError,
  GarminRateLimitError,
} from "@dofek/garmin-connect";

try {
  await client.getDailySummary("2026-07-01");
} catch (error) {
  if (error instanceof GarminRateLimitError) {
    console.error(
      `Retry after ${error.retryAfterSeconds ?? "an unspecified delay"} seconds`,
    );
  } else if (error instanceof GarminApiError) {
    console.error(`Garmin request failed with ${error.statusCode}`);
  }
  throw error;
}

// The constant is guidance; the client does not queue requests for callers.
await new Promise((resolve) => setTimeout(resolve, GARMIN_CONNECT_THROTTLE_MS));
```

## Parsing behavior

Activity durations and sleep durations use different upstream units; the
exported parsers apply the conversions expected by the currently observed
responses. Sleep-stage parsing overlays the dedicated REM series on Garmin's
sleep-level series, and stress parsing omits negative sentinel values.

## Project

- [Source](https://github.com/Asherlc/dofek/tree/main/packages/garmin-connect)
- [Report an issue](https://github.com/Asherlc/dofek/issues)
- [Contribute a pull request](https://github.com/Asherlc/dofek/pulls)
- License: [MIT](./LICENSE)
