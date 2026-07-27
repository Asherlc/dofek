# @dofek/trainerroad

Unofficial TypeScript client for private TrainerRoad web endpoints. It signs in
through the observed HTML form flow and retrieves member information,
activities, and career data.

This package is not affiliated with, endorsed by, or supported by TrainerRoad.
Its authentication page and undocumented endpoints may change without notice.

## Requirements and installation

Requires Node.js 22.14 or newer and its built-in
[`fetch`](https://nodejs.org/api/globals.html#fetch) implementation.

```sh
npm install @dofek/trainerroad
```

## Quick start

Save this as `example.mjs`, set `TRAINERROAD_USERNAME` and
`TRAINERROAD_PASSWORD`, then run `node example.mjs`.

```js
import { TrainerRoadClient } from "@dofek/trainerroad";

const login = process.env.TRAINERROAD_USERNAME;
const password = process.env.TRAINERROAD_PASSWORD;
if (!login || !password) {
  throw new Error("Set TRAINERROAD_USERNAME and TRAINERROAD_PASSWORD");
}

const { authCookie, username } = await TrainerRoadClient.signIn(
  login,
  password,
);
const client = new TrainerRoadClient(authCookie);
const activities = await client.getActivities(
  username,
  "2026-07-01",
  "2026-07-07",
);

console.log(activities);
```

Dates passed to `getActivities` use `YYYY-MM-DD`.

## Public API

- `TrainerRoadClient.signIn(username, password, fetch?)` returns the observed
  `SharedTrainerRoadAuth` cookie value and canonical account username.
- `new TrainerRoadClient(authCookie, fetch?)` creates a session-backed client.
- `client.getMemberInfo()` retrieves the current member's ID and username.
- `client.getActivities(username, startDate, endDate)` retrieves scheduled and
  completed calendar activities.
- `client.getCareer(username)` retrieves career data such as FTP and weight.

Supported deep imports:

- `@dofek/trainerroad/client` — client class.
- `@dofek/trainerroad/parsing` — activity type mapping and
  `parseTrainerRoadActivity`.
- `@dofek/trainerroad/types` — raw member, activity, and career interfaces.

```ts
import { parseTrainerRoadActivity } from "@dofek/trainerroad/parsing";
import type { TrainerRoadActivity } from "@dofek/trainerroad/types";
```

## Authentication and persistence

The [current implementation](https://github.com/Asherlc/dofek/blob/main/packages/trainerroad-client/src/client.ts)
loads `/app/login`, extracts the `__RequestVerificationToken` CSRF field and
initial cookies, submits the login form, and returns the
`SharedTrainerRoadAuth` cookie set by the response. It does not use embedded
application credentials.

Treat `authCookie` as a password-equivalent session secret and keep it in
encrypted storage. The package cannot inspect its expiry and has no cookie
refresh endpoint. If an authenticated request begins failing, call `signIn`
again and replace the stored cookie. Never log or commit the cookie or account
password.

## Rate limits and errors

The shared
[rate-limit wrapper](https://github.com/Asherlc/dofek/blob/main/packages/provider-http/src/rate-limit.ts)
throws `ProviderRateLimitError` for `429` and
`ProviderServiceUnavailableError` for `502`, `503`, and `504`. Both expose
`providerId`, `statusCode`, `responseBody`, and `retryAfterSeconds`. The latter
follows the HTTP
[`Retry-After`](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after)
header when present. Other unsuccessful API responses throw a regular `Error`;
a failed login without the expected session cookie also throws `Error`.

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
  await client.getCareer(username);
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

## Parsing behavior

`parseTrainerRoadActivity` maps the currently observed activity names and
`IsOutside` flag to canonical activity types. It treats `CompletedDate` as the
end time and derives the start by subtracting `Duration`.

## Project

- [Source](https://github.com/Asherlc/dofek/tree/main/packages/trainerroad-client)
- [Report an issue](https://github.com/Asherlc/dofek/issues)
- [Contribute a pull request](https://github.com/Asherlc/dofek/pulls)
- License: [MIT](./LICENSE)
