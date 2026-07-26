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

- **API/credential/OAuth sync providers**: Amazfit/Zepp, BodySpec, Concept2, Cycling Analytics, Eight Sleep, FatSecret, Garmin, Oura, Peloton, Polar, Ride with GPS, Strava, TrainerRoad, Ultrahuman, VeloHero, Wahoo, Wger, WHOOP, Withings, Xert, Zwift.
- **Config-based sync providers**: Auto-Supplements.
- **Import-only providers**: Cronometer CSV, FIT files, Garmin account exports, Kaya, Strong CSV, and Zepp OS App exports. FIT imports use Garmin's open FIT protocol and SDK-compatible files ([FIT SDK](https://developer.garmin.com/fit/overview/)).
- **Upload/native-mobile data sources**: Apple Health import and WHOOP BLE capture live outside this registry path in the web/mobile upload and native module flows.

The Fitbit, Suunto, COROS, Komoot, MapMyFitness, and Decathlon modules remain available for
historical provider IDs and future vendor onboarding, but are not loaded by the production server or
worker registries. See the root README's
[provider inventory](../../README.md#provider-implementations-not-registered-in-production) for the
current vendor-access constraints and primary sources.

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
