# @dofek/zwift

Unofficial TypeScript client for Zwift's private game-client API, including
account sign-in, profiles, activities, fitness streams, and power curves.

This package is not affiliated with, endorsed by, or supported by Zwift. It
uses private endpoints and observed game-client headers rather than a supported
public API contract; any of them may change without notice.

Review [Zwift's Terms of Service](https://support.zwift.com/en_us/terms-of-service-HJt7VBYyH)
and obtain prior authorization where required. The current terms restrict
unauthorized applications and automated interaction with the Zwift platform.
Use only with an account and data you are authorized to access.

## Requirements

- Node.js 22.14 or newer

## Install

```sh
npm install @dofek/zwift
```

## Quick start

```ts
import { ZwiftClient } from "@dofek/zwift";

const username = process.env.ZWIFT_USERNAME;
const password = process.env.ZWIFT_PASSWORD;
if (!username || !password) {
  throw new Error("Set ZWIFT_USERNAME and ZWIFT_PASSWORD");
}

const tokens = await ZwiftClient.signIn(username, password);

// getAuthenticatedProfile() does not use the constructor's athlete ID.
const bootstrapClient = new ZwiftClient(tokens.accessToken, "me");
const profile = await bootstrapClient.getAuthenticatedProfile();

const client = new ZwiftClient(tokens.accessToken, String(profile.id));
const activities = await client.getActivities(0, 20);

console.log({
  athleteId: profile.id,
  activityCount: activities.length,
});
```

This resolves the athlete ID from `/api/profiles/me` before making endpoints
that require `/api/profiles/{athleteId}`.

## Token lifecycle

`signIn` and `refreshToken` each return:

```ts
{
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // seconds
}
```

`ZwiftClient` does not refresh itself. Persist the refresh token securely,
refresh before `expiresIn` elapses, and construct a new client:

```ts
const refreshed = await ZwiftClient.refreshToken(tokens.refreshToken);
const refreshedClient = new ZwiftClient(
  refreshed.accessToken,
  String(profile.id),
);
```

Replace the stored refresh token with the one returned by every successful
refresh. Treat passwords and both tokens as secrets.

Both static authentication methods and the constructor accept an optional
compatible `fetch` implementation as their final argument.

## Client API

Authentication and constants:

- `ZwiftClient.signIn(username, password, fetch?)`
- `ZwiftClient.refreshToken(refreshToken, fetch?)`
- `ZWIFT_AUTH_URL`
- `ZWIFT_API_BASE`

Authenticated client methods:

- `getAuthenticatedProfile()` fetches the current account's profile.
- `getProfile()` fetches the constructor's athlete ID.
- `getActivities(start = 0, limit = 20)` lists that athlete's activities.
- `getActivityDetail(activityId)` requests detail with snapshots.
- `getFitnessData(url)` fetches a fitness-stream URL.
- `getPowerCurve()` fetches the authenticated athlete's power profile.

`getFitnessData` sends the bearer token to the supplied URL. Pass only a URL
returned by Zwift, such as `activity.fitnessData?.fullDataUrl`; never pass
untrusted user input.

## Types and deep imports

Response types are exported from `types`:

```ts
import type {
  ZwiftActivityDetail,
  ZwiftActivitySummary,
  ZwiftFitnessData,
  ZwiftPowerCurve,
  ZwiftProfile,
  ZwiftTokenResponse,
} from "@dofek/zwift/types";
```

Provider-neutral parsing helpers are exported from `parsing`:

```ts
import {
  mapZwiftSport,
  parseZwiftActivity,
  parseZwiftFitnessData,
  type ParsedZwiftActivity,
  type ParsedZwiftStreamSample,
} from "@dofek/zwift/parsing";
```

`parseZwiftFitnessData(data, activityStart)` aligns the observed parallel
sample arrays and converts centimeters to meters and centimeters per second to
meters per second.

## Rate limits and errors

Actual package behavior:

- HTTP `429` throws `ProviderRateLimitError` from
  `@dofek/provider-http/rate-limit`. Its `retryAfterSeconds` property is parsed
  from `Retry-After` when present.
- HTTP `502`, `503`, and `504` throw `ProviderServiceUnavailableError` from the
  same module.
- Other unsuccessful authentication and API responses throw `Error` containing
  the HTTP status; most methods also include the response body.
- The client does not automatically sleep, refresh a token, or retry.
- Successful private responses are represented by TypeScript interfaces, not
  runtime-validated schemas. Be prepared for upstream shape changes.

## Observed private protocol

- Auth URL:
  `https://secure.zwift.com/auth/realms/zwift/protocol/openid-connect/token`
- API base: `https://us-or-rly101.zwift.com`
- Observed client ID: `Zwift Game Client`
- Sign-in grant: password
- Refresh grant: refresh token
- Observed request identity headers: `Platform: OSX`, `Source: Game Client`,
  and a macOS game-client `User-Agent`
- API authorization: `Authorization: Bearer <access token>`

These details document observed behavior; they are not promises made by Zwift.

## Project

- [Source](https://github.com/Asherlc/dofek/tree/main/packages/zwift-client)
- [Issues](https://github.com/Asherlc/dofek/issues)
- [Pull requests](https://github.com/Asherlc/dofek/pulls)
- [MIT License](./LICENSE)
