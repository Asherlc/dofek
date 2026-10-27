# Provider Stats Availability Design

## Problem

`sync.providers` uses ClickHouse provider statistics to infer whether push-only
providers have sent data. It currently catches provider-stat query failures and
substitutes an empty array. That makes an unavailable analytics dependency
indistinguishable from a successful query returning zero records, so connected
push-only providers are reported as disconnected.

The clients compound the issue differently:

- TanStack Query exposes `data` as the last successfully resolved query data,
  distinguishes first-load failures with `isLoadingError`, and distinguishes
  refetch failures with `isRefetchError`
  ([TanStack Query `useQuery` reference](https://tanstack.com/query/latest/docs/framework/react/reference/useQuery)).
- The mobile provider screen explicitly discards that retained data whenever the
  query has an error.
- The web provider panel continues using retained data, but does not surface the
  provider inventory refresh error.

## Chosen Approach

Fail `sync.providers` when provider statistics are unavailable and let the
existing [tRPC infrastructure sanitizer](../../../packages/server/src/trpc.ts)
expose the failure as the retryable
`SERVICE_UNAVAILABLE` analytics error:

> Analytics data is temporarily unavailable. Please retry in a minute.

Both clients will continue rendering any retained successful provider data while
also displaying the query error. A first-load failure has no retained data, so
the clients show the specific error instead of manufacturing disconnected
providers.

This approach was selected over adding an `unknown` authorization value to the
provider response. A nullable authorization state would widen the server schema
and every client consumer, and a successful response containing `unknown` would
replace previously known cached state instead of preserving it.

## Server Behavior

`sync.providers` will no longer convert `getProviderStats()` rejection into an
empty result. The provider-stat promise will reject, which prevents the router
from returning any fabricated authorization values.

The existing infrastructure error middleware will sanitize recognized
ClickHouse availability errors into `SERVICE_UNAVAILABLE` and the established
retry message. The sanitizer's
[focused tests](../../../packages/server/src/routers/trpc.test.ts) verify this
repository-specific error mapping and Sentry reporting. Existing logging and
Sentry reporting remain responsible for
capturing the underlying dependency failure without exposing internal details to
clients.

When the provider-stat query succeeds, the existing mapping remains unchanged:

- A push-only provider with `metricStream > 0` is authorized.
- A push-only provider with no row or `metricStream === 0` is not authorized.
- Token-backed and import providers retain their existing authorization logic.

## Client Behavior

### Web

The data sources panel will render `providers.data` whenever it exists, even if a
background refetch also set `providers.error`. TanStack Query documents `data`
as the last successfully resolved value and separately exposes refetch errors
([TanStack Query `useQuery` reference](https://tanstack.com/query/latest/docs/framework/react/reference/useQuery)).
It will add an error panel using the server-provided message so users know the
displayed inventory could not be refreshed.

On an initial failure, no provider inventory is available. The same error panel
is shown and no server providers are rendered.

### Mobile

The provider screen will stop replacing `providers.data` with an empty array
when `providers.error` is present. It will render retained provider cards and
the existing error panel together during a background refetch failure.

On an initial failure, `providers.data` remains absent, so only local sources
such as Apple Health and the existing specific error panel are shown.

No client computes or guesses provider authorization. Both clients continue to
render only the last server-computed values held in the query cache.

## Testing

Server tests will be changed test-first to prove:

- A provider-stat rejection causes `sync.providers` to reject instead of
  returning `authorized: false`.
- The underlying failure is still logged and reported.
- A successful zero-data provider-stat query still returns push-only providers
  with `authorized: false`.

Web and mobile component tests will be added test-first to provide provider data
and a simultaneous query error, then verify:

- The cached connected provider remains rendered.
- The retryable error message is visible.

Focused server, web, and mobile unit tests will run after each change, followed
by the repository's relevant lint and type-check validation.

## Scope

This change does not add retries, persistence mechanisms, new authorization
states, or analytics fallbacks. It relies on the existing tRPC error sanitizer
and TanStack Query cache semantics, changing only the incorrect server fallback
and the clients' presentation of retained query data.
