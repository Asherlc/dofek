# @dofek/xert

TypeScript client for Xert authentication, token refresh, observed activity
paging, runtime response validation, and conversion to provider-agnostic
activity records.

Xert publishes an API reference that documents its password and refresh-token
grants, including the `xert_public` client credentials. The paginated activity
response consumed here is an observed Xert web API shape rather than the
activity-list representation in that reference. See the
[Xert API documentation](https://www.xertonline.com/API.html).

This package is not affiliated with, endorsed by, or supported by Xert or Baron
Biosystems. Undocumented endpoints and response shapes may change without
notice.

## Requirements and installation

Requires Node.js 22.14 or newer and its built-in
[`fetch`](https://nodejs.org/api/globals.html#fetch) implementation.

```sh
npm install @dofek/xert
```

## Quick start

```ts
import { XertClient } from "@dofek/xert";
import { parseXertActivity } from "@dofek/xert/parsing";

const email = process.env.XERT_EMAIL;
const password = process.env.XERT_PASSWORD;
if (!email || !password) {
  throw new Error("Set XERT_EMAIL and XERT_PASSWORD");
}

const token = await XertClient.signIn(email, password);
const client = new XertClient(token.accessToken);
const activities = await client.listActivities({
  from: Math.floor(Date.parse("2026-07-01T00:00:00Z") / 1000),
});

console.log(activities.map(parseXertActivity));
```

`from` is a Unix timestamp in seconds. `page` defaults to `0`, and `limit`
defaults to `50`.

## Authentication and token refresh

`XertClient.signIn(email, password, fetch?, credentials?)` uses the resource
owner password grant documented by Xert. It returns:

- `accessToken`
- `refreshToken`
- `expiresAt`
- `scopes`

The library defaults to the documented `xert_public` client ID and secret. To
use different credentials, pass them explicitly:

```ts
const token = await XertClient.signIn(
  email,
  password,
  fetch,
  { clientId: "client-id", clientSecret: "client-secret" },
);
```

The library never reads environment variables. Applications decide how to load
configuration and must store account passwords, access tokens, and refresh
tokens as password-equivalent secrets.

Refresh before `expiresAt`:

```ts
const refreshed = await XertClient.refreshToken(token.refreshToken!);
```

The standalone `signInToXert` and `refreshXertToken` functions expose the same
operations. If Xert does not return a replacement refresh token,
`refreshXertToken` retains the supplied token.

## Public API

- `new XertClient(accessToken, fetch?)`
- `XertClient.signIn(email, password, fetch?, credentials?)`
- `XertClient.refreshToken(refreshToken, fetch?, credentials?)`
- `client.listActivities({ from, page?, limit? })`
- `signInToXert(...)`
- `refreshXertToken(...)`
- `DEFAULT_XERT_CLIENT_CREDENTIALS`
- `XertAuthenticationError`
- `XertApiError`

Supported deep imports:

- `@dofek/xert/client` — authentication, refresh, and API client.
- `@dofek/xert/parsing` — sport mapping and normalized activity parsing.
- `@dofek/xert/types` — Zod schemas and TypeScript types.

All token and activity responses cross a
[Zod](https://zod.dev/) runtime-validation boundary. A response-shape change
therefore throws `ZodError` instead of returning unchecked data.

## Errors and rate limits

Rejected authentication and refresh requests throw
`XertAuthenticationError`. Other unsuccessful activity requests throw
`XertApiError`. Both expose `statusCode` and `responseBody`.

The shared HTTP wrapper throws `ProviderRateLimitError` for `429` and
`ProviderServiceUnavailableError` for `502`, `503`, and `504`, retaining a
parsed
[`Retry-After`](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after)
value when supplied.

If your application handles these classes directly, declare
`@dofek/provider-http` as a direct dependency:

```ts
import {
  ProviderRateLimitError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
```

## Project

- [Source](https://github.com/Asherlc/dofek/tree/main/packages/xert-client)
- [Report an issue](https://github.com/Asherlc/dofek/issues)
- [Contribute a pull request](https://github.com/Asherlc/dofek/pulls)
- License: [MIT](./LICENSE)
