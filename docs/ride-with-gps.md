# Ride with GPS Provider

## Authentication

Dofek's current integration behavior is defined by the
[provider configuration](../src/providers/ride-with-gps.ts) and
[shared OAuth helper](../src/auth/oauth.ts):

- `RWGPS_CLIENT_ID` and `RWGPS_CLIENT_SECRET` are required.
- Authorization uses `https://ridewithgps.com/oauth/authorize`.
- Token exchange uses `https://ridewithgps.com/oauth/token.json`, sends the
  client secret in the request body, and requests the `user` scope.
- PKCE is not enabled for this integration.

These are repository-observed integration choices, not claims about every
client type Ride with GPS supports. Historical production evidence in
[PR #219](https://github.com/Asherlc/dofek/pull/219),
[PR #231](https://github.com/Asherlc/dofek/pull/231), and
[PR #245](https://github.com/Asherlc/dofek/pull/245) shows token responses that
omitted `expires_in` and `refresh_token`. The shared OAuth helper assigns a
one-year local expiry when `expires_in` is absent; after that, the
[token resolver](../src/auth/resolve-tokens.ts) fails explicitly when no refresh
token is available, so the user must reconnect.

## Sync

Dofek uses the current Ride with GPS API contracts documented by the live
[OpenAPI specification](https://ridewithgps.com/api/v1/openapi.yaml):

- `GET /api/v1/sync.json?since=<ISO8601>&assets=trips` supplies the incremental
  change feed and next cursor.
- `GET /api/v1/trips.json` supplies paginated inventory for reconciliation.
- `GET /api/v1/trips/{id}.json` supplies trip metadata and track points.

Only trips are ingested. `deleted` and `removed` feed actions mark the trip
absent. Inventory reconciliation also marks trips absent when a complete scan
no longer returns them. Failed feed-item processing prevents cursor advancement;
an incomplete inventory scan does not perform inventory-based deletion.

The identity call currently uses the legacy
`GET /users/current.json` endpoint. The live OpenAPI specification now declares
`GET /api/v1/users/current`; verify the production provider response and update
the implementation plus tests before changing this documented integration
boundary.

## Track Points

Trip track points use compact keys:

| Key | Meaning | Unit |
|-----|---------|------|
| `x` | Longitude | Degrees |
| `y` | Latitude | Degrees |
| `d` | Distance from start | Meters |
| `e` | Elevation | Meters |
| `t` | Timestamp | Unix seconds |
| `s` | Speed | Kilometers per hour |
| `T` | Temperature | Celsius |
| `h` | Heart rate | Beats per minute |
| `c` | Cadence | Revolutions per minute |
| `p` | Power | Watts |

Dofek skips points without `x`, `y`, or `t`, converts speed to meters per
second, and publishes location plus available elevation, temperature, heart
rate, cadence, and power samples to the metric stream.

## Historical Authentication Investigation

The confidential-client behavior was established through production failures
and is preserved in [PR #219](https://github.com/Asherlc/dofek/pull/219),
[PR #231](https://github.com/Asherlc/dofek/pull/231), and
[PR #245](https://github.com/Asherlc/dofek/pull/245). A
[dated snapshot of the provider's HTML authentication page](https://web.archive.org/web/20260304124306/https://ridewithgps.com/api/v1/doc/authentication)
is historical evidence, not the current API reference.
