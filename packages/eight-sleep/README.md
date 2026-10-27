# @dofek/eight-sleep

Unofficial TypeScript client for the private API used by Eight Sleep clients. It
retrieves trend days containing sleep sessions, sleep-stage data, daily
biometrics, and heart-rate samples.

This package is not affiliated with, endorsed by, or supported by Eight Sleep.
It uses undocumented endpoints and an observed app authentication flow, so
either may change without notice.

## Requirements and installation

Requires Node.js 22.14 or newer and its built-in
[`fetch`](https://nodejs.org/api/globals.html#fetch) implementation.

```sh
npm install @dofek/eight-sleep
```

## Quick start

Save this as `example.mjs`, set `EIGHT_SLEEP_EMAIL` and
`EIGHT_SLEEP_PASSWORD`, then run `node example.mjs`.

```js
import { EightSleepClient } from "@dofek/eight-sleep";

const email = process.env.EIGHT_SLEEP_EMAIL;
const password = process.env.EIGHT_SLEEP_PASSWORD;
if (!email || !password) {
  throw new Error("Set EIGHT_SLEEP_EMAIL and EIGHT_SLEEP_PASSWORD");
}

const { accessToken, expiresIn, userId } = await EightSleepClient.signIn(
  email,
  password,
);
const client = new EightSleepClient(accessToken, userId);
const trends = await client.getTrends("UTC", "2026-07-01", "2026-07-07");

console.log({ expiresIn, days: trends.days.length });
```

`getTrends(timezone, fromDate, toDate)` expects `YYYY-MM-DD` dates. The
[current client implementation](https://github.com/Asherlc/dofek/blob/main/packages/eight-sleep/src/client.ts)
always requests all sessions with model version `v2`.

## Public API

- `EightSleepClient.signIn(email, password, fetch?)` returns `accessToken`,
  `expiresIn` in seconds, and `userId`.
- `new EightSleepClient(accessToken, userId, fetch?)` creates an authenticated
  client. Supplying `fetch` is useful for custom transport instrumentation.
- `client.getTrends(timezone, fromDate, toDate)` retrieves raw trend days and
  their nested sessions and time series.

Supported deep imports:

- `@dofek/eight-sleep/client` — client and observed app credential constants.
- `@dofek/eight-sleep/parsing` — `parseEightSleepTrendDay`,
  `parseEightSleepDailyMetrics`, and `parseEightSleepHeartRateSamples`.
- `@dofek/eight-sleep/types` — raw response interfaces.

For example:

```ts
import { parseEightSleepDailyMetrics } from "@dofek/eight-sleep/parsing";
import type { EightSleepTrendDay } from "@dofek/eight-sleep/types";
```

## Authentication and persistence

The [current implementation](https://github.com/Asherlc/dofek/blob/main/packages/eight-sleep/src/client.ts)
sends a password-grant request with client credentials observed in the Eight
Sleep Android application. Those `EIGHT_SLEEP_CLIENT_ID` and
`EIGHT_SLEEP_CLIENT_SECRET` values identify the upstream app; they are
intentionally visible in this package and are not a substitute for the user's
email and password.

Persist the returned `accessToken`, `userId`, and calculated expiry in encrypted
storage. The package does not implement a refresh-token flow. Once the access
token expires, call `signIn` again and replace the persisted credentials. Never
log or commit user credentials or access tokens.

## Rate limits and errors

The shared
[rate-limit wrapper](https://github.com/Asherlc/dofek/blob/main/packages/provider-http/src/rate-limit.ts)
throws `ProviderRateLimitError` for `429` and
`ProviderServiceUnavailableError` for `502`, `503`, and `504`. Both expose
`providerId`, `statusCode`, `responseBody`, and `retryAfterSeconds`. The latter
follows the HTTP
[`Retry-After`](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after)
header when the upstream response provides it. Other unsuccessful responses
throw a regular `Error` containing the response status and body.

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
  await client.getTrends("UTC", "2026-07-01", "2026-07-07");
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

The parsers convert raw duration seconds to minutes. Daily metrics come from
the observed `sleepQualityScore` structure; `parseEightSleepTrendDay` derives
awake time from presence time minus sleep time, and
`parseEightSleepHeartRateSamples` reads samples nested under sessions.

## Project

- [Source](https://github.com/Asherlc/dofek/tree/main/packages/eight-sleep)
- [Report an issue](https://github.com/Asherlc/dofek/issues)
- [Contribute a pull request](https://github.com/Asherlc/dofek/pulls)
- License: [MIT](./LICENSE)
