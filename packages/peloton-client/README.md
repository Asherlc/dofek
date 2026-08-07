# @dofek/peloton

Unofficial TypeScript client for Peloton's private member API. It includes
workout and performance-graph access, runtime response validation, PKCE token
exchange and refresh, and the observed Auth0 username/password browser flow.

This package is not affiliated with, endorsed by, or supported by Peloton.
The endpoints and automated login flow are undocumented implementation
details and may change without notice. Review the
[implementation](https://github.com/Asherlc/dofek/tree/main/packages/peloton-client/src)
before using it with an account you care about.

## Requirements and installation

Requires Node.js 22.14 or newer and its built-in
[`fetch`](https://nodejs.org/api/globals.html#fetch).

```sh
npm install @dofek/peloton
```

## Quick start: automated sign-in

Set `PELOTON_EMAIL` and `PELOTON_PASSWORD`, save this as `example.mjs`, and run
`node example.mjs`:

```js
import { PelotonClient } from "@dofek/peloton";
import { pelotonAutomatedLogin } from "@dofek/peloton/auth";

const email = process.env.PELOTON_EMAIL;
const password = process.env.PELOTON_PASSWORD;
if (!email || !password) {
  throw new Error("Set PELOTON_EMAIL and PELOTON_PASSWORD");
}

const tokens = await pelotonAutomatedLogin(email, password);
const client = new PelotonClient(tokens.accessToken);
const workouts = await client.getWorkouts(0, 20);

console.log(workouts.data);
```

`pelotonAutomatedLogin` drives the currently observed Auth0 Universal Login
HTML flow. Auth0 documents Universal Login as a browser authentication
experience, so automation is inherently more fragile than opening the
authorization URL in a user-controlled browser.
[Auth0 Universal Login documentation](https://auth0.com/docs/authenticate/login/auth0-universal-login)

Treat the password, access token, and refresh token as secrets. Do not log or
commit them. Multi-factor authentication, bot checks, account policy, or an
upstream page change can prevent automated login.

## Browser authorization with PKCE

For applications that can receive Peloton's configured callback, create a
PKCE authorization request, retain the verifier, and exchange the callback
code:

```ts
import {
  createPelotonAuthorization,
  exchangePelotonAuthorizationCode,
} from "@dofek/peloton/auth";

const authorization = createPelotonAuthorization();
console.log("Open this URL:", authorization.url);

// Obtain `code` from the callback URL in your application.
const tokens = await exchangePelotonAuthorizationCode(
  code,
  authorization.codeVerifier,
);
```

The verifier must remain private and be paired with the same authorization
request. PKCE is standardized by
[RFC 7636](https://www.rfc-editor.org/rfc/rfc7636), and Auth0 describes the
[authorization-code flow with PKCE](https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow-with-pkce).

## Refreshing tokens

Persist the complete token set in encrypted storage. Before API use, compare
`expiresAt` with the current time. Refresh an expired token and atomically
replace the stored set:

```ts
import { refreshPelotonAccessToken } from "@dofek/peloton/auth";

if (!tokens.refreshToken) {
  throw new Error("Peloton did not return a refresh token; sign in again");
}

const refreshed = await refreshPelotonAccessToken(tokens.refreshToken);
```

If Peloton does not rotate the refresh token, the returned token set retains
the one supplied to `refreshPelotonAccessToken`.

## API client

```ts
import { PelotonClient } from "@dofek/peloton/client";

const client = new PelotonClient(accessToken);

const userId = await client.getUserId();
const page = await client.getWorkouts(0, 20);
const graph = await client.getPerformanceGraph(page.data[0].id, 5);
```

- `getUserId()` retrieves and caches the current Peloton member ID.
- `getWorkouts(page?, limit?)` returns a validated workout page joined with
  ride and instructor details.
- `getPerformanceGraph(workoutId, everyN?)` returns validated metric samples;
  `everyN` is the requested sampling interval in seconds.

All remote JSON crosses a
[`zod`](https://zod.dev/) schema boundary. A successful HTTP response whose
shape does not match the currently observed API throws
`PelotonResponseError`.

## Parsing

```ts
import {
  parsePerformanceGraph,
  parseWorkout,
} from "@dofek/peloton/parsing";

const workout = parseWorkout(page.data[0]);
const series = parsePerformanceGraph(graph, 5);
```

`parseWorkout` maps Peloton disciplines to the canonical activity types from
`@dofek/training`, converts Unix timestamps to `Date`, and retains useful
source metadata. `parsePerformanceGraph` adds a seconds offset to every metric
sample. It does not aggregate, merge, or discard samples.

## Errors and rate limits

- `PelotonAuthenticationError` indicates an API `401`.
- `PelotonServiceError` represents other unsuccessful Peloton API responses
  and exposes `statusCode` and `responseBody`.
- `PelotonAuthFlowError` identifies the failed authentication stage and may
  include HTTP diagnostics.
- `PelotonResponseError` identifies an invalid successful response.
- `ProviderRateLimitError` and `ProviderServiceUnavailableError` come from
  `@dofek/provider-http` for `429` and transient `502`/`503`/`504` responses.

Declare `@dofek/provider-http` directly if your application imports its error
classes. Its retry-delay parsing follows the HTTP `Retry-After` semantics in
[RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after).

## Public modules

- `@dofek/peloton` — API client and base URL.
- `@dofek/peloton/auth` — login, authorization-code exchange, refresh, and
  token types.
- `@dofek/peloton/client` — API client and base URL.
- `@dofek/peloton/errors` — typed package errors.
- `@dofek/peloton/parsing` — pure workout and graph parsers.
- `@dofek/peloton/types` — Zod schemas and inferred raw API types.

## Project

- [Source](https://github.com/Asherlc/dofek/tree/main/packages/peloton-client)
- [Report an issue](https://github.com/Asherlc/dofek/issues)
- [Contribute a pull request](https://github.com/Asherlc/dofek/pulls)
- License: [MIT](./LICENSE)
