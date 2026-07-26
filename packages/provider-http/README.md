# @dofek/provider-http

Fetch-compatible HTTP helpers for provider integrations that need typed rate-limit
and service-unavailable errors, `Retry-After` parsing, and optional adaptive
request admission.

## Install

```sh
npm install @dofek/provider-http
```

Requires Node.js 22.14 or newer and its built-in
[`fetch`](https://nodejs.org/api/globals.html#fetch) implementation.

## Usage

```ts
import {
  createRateLimitAwareFetch,
  ProviderRateLimitError,
} from "@dofek/provider-http";

const providerFetch = createRateLimitAwareFetch(fetch, {
  providerId: "example",
});

try {
  const response = await providerFetch("https://api.example.com/data");
  if (!response.ok) {
    throw new Error(`Provider returned HTTP ${response.status}`);
  }
  console.log(await response.json());
} catch (error) {
  if (error instanceof ProviderRateLimitError) {
    console.log(`Retry after ${error.retryAfterSeconds ?? "an unknown number of"} seconds`);
  } else {
    throw error;
  }
}
```

## Public API

| Import | Main exports |
| --- | --- |
| `@dofek/provider-http` | `createRateLimitAwareFetch`, `fetchWithRateLimitHandling`, `parseRetryAfterHeader`, `isServiceUnavailableStatus`, `ProviderRateLimitError`, `ProviderServiceUnavailableError`, and their option/store types |
| `@dofek/provider-http/rate-limit` | Alias of the root rate-limit API |
| `@dofek/provider-http/adaptive-rate-limit` | Adaptive budget state, serialization, admission-delay calculations, Strava quota parsing, defaults, constants, and `AdaptiveRateLimitStore` |

`AdaptiveRateLimitStore` is an interface: applications provide persistence and
coordination appropriate to their runtime.

## Error and request behavior

- HTTP `429` throws `ProviderRateLimitError`.
- HTTP `502`, `503`, and `504` throw `ProviderServiceUnavailableError`.
- Both errors expose the provider, status, response body, scope, optional user,
  and parsed `retryAfterSeconds`.
- Other HTTP error responses are returned unchanged, so callers must check
  `response.ok`.
- These helpers do not retry automatically. The caller decides whether and when
  to retry; an adaptive store can delay admission before a request.

No authentication or environment variables are required by this package.

## License and contributing

[MIT](./LICENSE). Source is in the
[Dofek repository](https://github.com/Asherlc/dofek/tree/main/packages/provider-http).
Please [open an issue](https://github.com/Asherlc/dofek/issues) for bugs or API
proposals, or [submit a pull request](https://github.com/Asherlc/dofek/pulls).
