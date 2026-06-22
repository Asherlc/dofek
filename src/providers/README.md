# Providers

This directory contains implementations for various data providers (fitness trackers, smart scales, nutrition apps).

## Core Concepts

- **Provider Interface**: All providers implement the `Provider` interface (defined in `types.ts`).
- **Sync vs Import**: Providers are either `SyncProvider` (fetches data via API) or `ImportProvider` (processes uploaded files).
- **Authentication**: Supports OAuth 2.0 (`oauth`), OAuth 1.0 (`oauth1`), and credential-based (`credential`) authentication. **New sync providers must authenticate per user** — see `docs/adding-a-provider.md` and `provider-auth-policy.ts`.
- **Webhooks**: Many providers (Strava, Fitbit, Oura) support real-time updates via webhooks (`WebhookProvider`).

## Implementation Details

- **Registry**: All active providers are registered in `index.ts`.
- **HTTP Client**: A shared `HttpClient` in `http-client.ts` handles rate limiting, retries, and logging.
- **Validation**: `validate()` may gate app-level OAuth client config, but must not gate on per-user credentials. User auth is checked at sync time via `loadTokens()`.
- **UI visibility**: Providers that fail `validate()` are hidden until required app config is present. Users connect individually via Connect buttons.
- **Data Mapping**: Providers transform vendor-specific JSON into Dofek's internal schema (see `src/db/schema.ts`).
- **Activity absence tombstones**: Use `src/db/provider-activity-sync.ts`. Upsert activities with `upsertProviderActivity()` or `ProviderActivityListSync.upsert()`. After a completed authoritative activity-list fetch for the sync window, call `finishProviderActivityListSync()` or `ProviderActivityListSync.reconcile()`. Explicit delete/removed webhook events should call `markProviderActivityAbsent()`. Shared upserts never set `providerAbsentAt: null`; reconciliation clears tombstones for activities still present in the provider list. Do not reconcile when a provider response is partial because of rate limits, auth failures, or other fetch errors.

## Supported Providers

- **API sync providers**: Amazfit/Zepp, BodySpec, Concept2, Coros, Cycling Analytics, Decathlon, Eight Sleep, FatSecret, Garmin, Komoot, MapMyFitness, Peloton, Ride with GPS, Strava, Suunto, TrainerRoad, Ultrahuman, VeloHero, Wahoo, Wger, Withings, Xert, Zwift.
- **Import-only providers**: Cronometer CSV, Strong CSV.
- **Planned via native/mobile flows rather than this directory**: Apple Health and WHOOP BLE capture live in the mobile app and native modules.

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

The first sync slice reads `/v1/data/band_data.json` and stores decoded daily steps, distance, active calories, sleep sessions, and minute-level heart rate samples.

**Note:** Zepp accounts signed in via Xiaomi or Google SSO cannot authenticate with email/password login.
