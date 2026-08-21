# @dofek/whoop

Unofficial TypeScript client for reverse-engineered WHOOP account and internal
data APIs, including Cognito sign-in, MFA, token refresh, continuous metrics,
cycles, sleep, journal, workouts, and Strength Trainer details.

This package is not affiliated with, endorsed by, or supported by WHOOP. Most
endpoints in this client are private implementation details observed from WHOOP
clients and may change without notice. Use only with an account and data you are
authorized to access.

For supported integrations, prefer the official WHOOP Developer Platform where
its scopes cover your use case. WHOOP documents its supported authorization-code
OAuth flow and token lifecycle in its
[official OAuth documentation](https://developer.whoop.com/docs/developing/oauth).

## Requirements

- Node.js 22.14 or newer

## Install

```sh
npm install @dofek/whoop
```

## Sign in, including MFA

```ts
import { WhoopClient } from "@dofek/whoop";
import type { WhoopAuthToken } from "@dofek/whoop/types";

const email = process.env.WHOOP_EMAIL;
const password = process.env.WHOOP_PASSWORD;
if (!email || !password) {
  throw new Error("Set WHOOP_EMAIL and WHOOP_PASSWORD");
}

const result = await WhoopClient.signIn(email, password);
let token: WhoopAuthToken;

if (result.type === "verification_required") {
  const code = process.env.WHOOP_MFA_CODE;
  if (!code) {
    throw new Error(
      `Set WHOOP_MFA_CODE with the current ${result.method.toUpperCase()} code`,
    );
  }
  token = await WhoopClient.verifyCode(
    result.session,
    code,
    email,
    result.method,
  );
} else {
  token = result.token;
}

const client = new WhoopClient(token);
const heartRate = await client.getHeartRate(
  "2026-01-01T00:00:00Z",
  "2026-01-02T00:00:00Z",
);

console.log(heartRate);
```

`signIn` returns the discriminated union `WhoopSignInResult`:

- `{ type: "success", token }` when no additional verification is required.
- `{ type: "verification_required", session, method }` for an SMS or TOTP
  challenge. Pass all three values, plus the username and code, to
  `verifyCode`.

`WhoopClient.authenticate` remains available for accounts without MFA. It
throws when MFA is required; new code should normally use `signIn` and
`verifyCode`.

## Refresh lifecycle

`WhoopClient` does not refresh itself. Persist the refresh token and original
numeric user ID securely, refresh before `expiresInSeconds` elapses, then
construct a new client:

```ts
const refreshed = await WhoopClient.refreshAccessToken(token.refreshToken);

token = {
  accessToken: refreshed.accessToken,
  refreshToken: refreshed.refreshToken,
  userId: refreshed.userId ?? token.userId,
  expiresInSeconds: refreshed.expiresInSeconds,
};

const refreshedClient = new WhoopClient(token);
```

The refresh flow normally reuses the supplied Cognito refresh token because the
observed refresh response does not issue a replacement. Resolving `userId`
during refresh is best-effort; retain the original value as shown above.

Treat access tokens, refresh tokens, MFA sessions, and credentials as secrets.

## Client API

Authentication and construction:

- `WhoopClient.signIn(username, password, fetch?)`
- `WhoopClient.verifyCode(session, code, username, method, fetch?)`
- `WhoopClient.refreshAccessToken(refreshToken, fetch?)`
- `WhoopClient.authenticate(username, password, fetch?)`
- `new WhoopClient(token, fetch?, onRequest?)`

Metrics and activity data:

- `getHeartRate(start, end, step = 6)`
- `getSteps(start, end, step = 300)`
- `getMetricValues(name, start, end, step)`
- `getCycles(start, end, limit = 200)`
- `listDeveloperWorkouts({ limit?, nextToken? })`
- `listDeveloperWorkoutIdsInWindow(windowStart, windowEnd)`
- `getSleep(sleepId)`
- `getWeightliftingWorkout(activityId)`; returns `null` for an observed `404`
- `getStrainDeepDive(date)` and `getJournal(start, end)`; both return `unknown`
  because these private response shapes are not stable

The optional `onRequest` constructor callback receives a `WhoopRequestEvent`
for internal data requests, including status, attempt, and parsed
`Retry-After`.

## Types and deep imports

The root exports:

- `WhoopClient`
- `WhoopRateLimitError`
- `WhoopMetricUnavailableError`
- `WhoopRequestEvent`
- `WHOOP_API_THROTTLE_MS`

Response and authentication types are exported from `types`:

```ts
import type {
  WhoopAuthToken,
  WhoopCycle,
  WhoopDeveloperWorkoutListResponse,
  WhoopHrValue,
  WhoopMetricValue,
  WhoopSignInResult,
  WhoopSleepRecord,
  WhoopVerificationMethod,
  WhoopWeightliftingWorkoutResponse,
} from "@dofek/whoop/types";
```

Pure helpers have separate entry points:

```ts
import { mapSportId, mapV2ActivityType } from "@dofek/whoop/sports";
import { parseDuringRange } from "@dofek/whoop/utils";
```

## Rate limits and errors

Actual package behavior:

- Most HTTP `429` responses throw `WhoopRateLimitError` immediately. The error
  exposes `statusCode`, `responseBody`, and `retryAfterSeconds`.
- The exported `WHOOP_API_THROTTLE_MS` value is advisory; `WhoopClient` does not
  automatically delay requests.
- `listDeveloperWorkouts` retries service-unavailable failures up to three
  times after the first attempt. Those retries are immediate and apply to
  `502`, `503`, `504`, and the observed developer-workout `500`; they do not
  apply to `429`.
- Other internal data methods do not automatically retry.
- Unsupported heart-rate or steps metric responses (`400` or `404`) become
  `WhoopMetricUnavailableError`.
- Service-unavailable responses handled by the shared HTTP layer throw
  `ProviderServiceUnavailableError` from
  `@dofek/provider-http/rate-limit`.
- Cognito failures and other non-success responses generally throw `Error`
  containing the observed service error. Runtime validation of developer
  workout pages may also throw a Zod validation error.

Use `retryAfterSeconds` when available and apply a caller-controlled retry
policy appropriate for the operation.

## Observed private protocol

- Data base URL: `https://api.prod.whoop.com`
- Internal API version parameter: `7`
- Internal data authorization: `Authorization: Bearer <access token>`
- Account sign-in: Cognito `USER_PASSWORD_AUTH` through WHOOP's observed auth
  proxy
- MFA challenges: `SOFTWARE_TOKEN_MFA` and `SMS_MFA`
- Refresh: Cognito `REFRESH_TOKEN_AUTH`

These details document observed behavior and are distinct from WHOOP's
supported, consent-based Developer Platform.

## Project

- [Source](https://github.com/Asherlc/dofek/tree/main/packages/whoop-whoop)
- [Issues](https://github.com/Asherlc/dofek/issues)
- [Pull requests](https://github.com/Asherlc/dofek/pulls)
- [MIT License](./LICENSE)
