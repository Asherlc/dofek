# Providers

This directory contains implementations for various data providers (fitness trackers, smart scales, nutrition apps).

## Core Concepts

- **Provider Interface**: All providers implement the `Provider` interface (defined in `types.ts`).
- **Sync vs Import**: Providers are either `SyncProvider` (fetches data via API) or `ImportProvider` (processes uploaded files).
- **Authentication**: Supports OAuth 2.0 (`oauth`), OAuth 1.0 (`oauth1`), personal token (`token`), and credential-based (`credential`) authentication. **New sync providers must authenticate per user** — see `docs/adding-a-provider.md` and `provider-auth-policy.ts`.
- **Webhooks**: Many providers (Strava, Fitbit, Oura) support real-time updates via webhooks (`WebhookProvider`).

## Implementation Details

- **Registry**: All active providers are registered in `index.ts`.
- **HTTP Client**: Provider fetches pass through the shared `@dofek/provider-http` boundary for adaptive rate limiting and a two-minute request deadline. The deadline composes with a caller-provided abort signal; request-start timeouts use `ETIMEDOUT`, and native response-body `TimeoutError` failures are also retryable instead of leaving a BullMQ job active indefinitely. Node.js documents [`AbortSignal.timeout()` and `AbortSignal.any()`](https://nodejs.org/api/globals.html#class-abortsignal).
- **Validation**: `validate()` may gate app-level OAuth client config, but must not gate on per-user credentials. User auth is checked at sync time via `loadTokens()`.
- **UI visibility**: Providers that fail `validate()` are hidden until required app config is present. Users connect individually via Connect buttons.
- **Data Mapping**: Providers transform vendor-specific JSON into Dofek's internal schema modules (see `src/db/schema/`).
- **Activity absence tombstones**: Use `src/db/provider-activity-sync.ts`. Upsert activities with `upsertProviderActivity()` or `ProviderActivityListSync.upsert()`. After a completed authoritative activity-list fetch for the sync window, call `finishProviderActivityListSync()` or `ProviderActivityListSync.reconcile()`. Explicit delete/removed webhook events should call `markProviderActivityAbsent()`. Shared upserts never set `providerAbsentAt: null`; reconciliation clears tombstones for activities still present in the provider list. Do not reconcile when a provider response is partial because of rate limits, auth failures, or other fetch errors.

## Supported Providers

- **API/credential/OAuth sync providers**: Amazfit/Zepp, BodySpec, Concept2, Cycling Analytics, Eight Sleep, FatSecret, Garmin, Mountain Project, Oura, Peloton, Polar, Ride with GPS, Strava, TrainerRoad, Ultrahuman, VeloHero, Wahoo, Wger, WHOOP, Withings, Xert, Zwift.
- **Internal schedule providers**: Auto-Supplements materializes bounded,
  user-scoped supplement dose occurrences. It never writes food entries or
  infers that a planned dose was taken.
- **Import-only providers**: Cronometer CSV, FIT files, Garmin account exports, Kaya, Strong CSV, and Zepp OS App exports. FIT imports use Garmin's open FIT protocol and SDK-compatible files ([FIT SDK](https://developer.garmin.com/fit/overview/)).
- **Upload/native-mobile data sources**: Apple Health import and WHOOP BLE capture live outside this registry path in the web/mobile upload and native module flows.

The Fitbit, Suunto, COROS, Komoot, MapMyFitness, and Decathlon modules remain available for
historical provider IDs and future vendor onboarding, but are not loaded by the production server or
worker registries:

- Fitbit must be rebuilt for the Google Health API before the legacy Fitbit Web API is turned down
  in September 2026 ([Google Health API migration overview](https://developers.google.com/health/about)).
- Suunto requires organization/partner approval and development and production subscriptions
  ([Suunto API Zone onboarding](https://apizone.suunto.com/how-to-start)).
- COROS issues credentials after developer onboarding
  ([COROS API application](https://support.coros.com/hc/en-us/articles/17085887816340-Submitting-an-API-Application)).
- Komoot does not offer a public API and selects integration partners
  ([Komoot API support policy](https://support.komoot.com/hc/en-us/articles/10331570510618-komoot-API)).
- MapMyFitness limits personal API access to paid MVP accounts and up to ten users
  ([MapMyFitness developer portal](https://developer.mapmyfitness.com/)).
- Decathlon requires an approved application registration before issuing client credentials
  ([Decathlon login authorization guide](https://login-doc.decathlon.com/authorization.html)).

## Amazfit/Zepp

The Amazfit/Zepp provider uses the private Zepp/Mi Fit cloud API exposed to the Zepp web and mobile apps.

Users connect with their Zepp email and password via the standard credential auth modal. Tokens are stored per user and used for sync.

- `ZEPP_API_BASE_URL`: optional API base URL for region-specific hosts. Defaults to `https://api-mifit.zepp.com`.

Credential login uses the current Zepp US2 app flow: encrypted registration at
`https://api-user-us2.zepp.com/v2/registrations/tokens`, then token exchange at
`https://api-mifit-us2.zepp.com/v2/client/login` with Zepp `9.12.5` app
metadata. Do not use the older `account.huami.com` or `account.zepp.com` token
exchange hosts for credential login; Zepp rejects that stale request shape with
HTTP `400`.

The first sync slice reads `/v1/data/band_data.json` and stores decoded daily steps, distance, sleep sessions, and minute-level heart rate samples.

**Note:** Zepp accounts signed in via Xiaomi or Google SSO cannot authenticate with email/password login.

## Polar

Polar's OAuth token response includes the stable `x_user_id`, and AccessLink
access tokens do not expire unless a partner or user explicitly revokes them.
Dofek encrypts that account identifier alongside the OAuth credential so
account-erasure retries can address the same AccessLink registration without
rediscovering it through a revoked token. Existing Polar connections created
before this metadata was stored must reconnect before account erasure begins.
[Polar AccessLink authentication](https://www.polar.com/accesslink-api/#authentication).

Account-erasure revocation first checks the exact `/v3/users/{user-id}`
registration. Polar documents `204` as absent for that check and `204` as
successful deregistration for `DELETE`; other statuses fail closed. A replay
also accepts only a `401` response carrying the exact Bearer
`error="invalid_token"` challenge defined by OAuth, because Polar documents
these access tokens as non-expiring unless explicitly revoked. Normal Polar
reconnect remains stricter and requires confirmed deregistration.
[Polar AccessLink users](https://www.polar.com/accesslink-api/#users),
[OAuth 2.0 Bearer `invalid_token`](https://www.rfc-editor.org/rfc/rfc6750#section-3.1).

## OAuth authorization erasure

MapMyFitness stores the numeric user ID returned by the authenticated
`/v7.1/user/self/` resource with the encrypted OAuth credential. Account
erasure sends `DELETE /v7.1/oauth2/connection/?user_id=...&client_id=...` and
accepts only the documented `204` response. Connections created before the
user ID was stored must reconnect before erasure starts.
[MapMyFitness User resource](https://developer.mapmyfitness.com/docs/v71_User/),
[MapMyFitness OAuth 2 Revoke](https://developer.mapmyfitness.com/docs/v71_OAuth2ConnectionRevokeResource/).

Komoot account erasure deletes the user's refresh token through
`/v1/clients/{client_id}/refresh_tokens/` using HTTP Basic client
authentication and accepts only the documented `200` response. A legacy
connection without a refresh token must reconnect before erasure starts.
[Komoot OAuth 2 partner documentation](https://static.komoot.de/doc/auth/oauth2.html#v1_clients__client_id__refresh_tokens_).

Suunto account erasure calls the Authorization API's
`GET /oauth/deauthorize?client_id=...` operation with the user's Bearer token
and accepts only the documented `200` response.
[Suunto Authorization API](https://apizone.suunto.com/api-details#api=oauth2-api&operation=deauthorize).

COROS and Decathlon connections fail account-erasure activation while they
remain linked because their current public integration documentation does not
provide a server-side grant-revocation operation that Dofek can verify.
COROS users must first disconnect Dofek under the documented third-party app
settings, and Decathlon users must manually unlink Dofek; both must then
disconnect the provider in Dofek before starting erasure.
[COROS third-party app disconnection](https://support.coros.com/hc/en-us/articles/360040256591-Syncing-with-3rd-Party-Apps),
[Decathlon login logout documentation](https://login-doc.decathlon.com/logout.html).
