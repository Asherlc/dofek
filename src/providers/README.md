# Providers

This directory contains implementations for various data providers (fitness trackers, smart scales, nutrition apps).

## Core Concepts

- **Provider Interface**: All providers implement the `Provider` interface (defined in `types.ts`).
- **Sync vs Import**: Providers are either `SyncProvider` (fetches data via API) or `ImportProvider` (processes uploaded files).
- **Authentication**: Supports OAuth 2.0 (`oauth`), OAuth 1.0 (`oauth1`), and credential-based (`credential`) authentication.
- **Webhooks**: Many providers (Strava, Fitbit, Oura) support real-time updates via webhooks (`WebhookProvider`).

## Implementation Details

- **Registry**: All active providers are registered in `index.ts`.
- **HTTP Client**: A shared `HttpClient` in `http-client.ts` handles rate limiting, retries, and logging.
- **Validation**: Each provider has a `validate()` method to ensure environment variables (API keys) are present.
- **UI visibility**: Providers that fail `validate()` are intentionally hidden from the UI until their required config is present.
- **Data Mapping**: Providers transform vendor-specific JSON into Dofek's internal schema (see `src/db/schema.ts`).
- **Activity absence tombstones**: Activity syncs that fetch an authoritative provider activity list must call `reconcileProviderActivityAbsence()` for the covered time window. Explicit delete/removed webhook events should call `markProviderActivityAbsent()`. Activity upserts must clear `providerAbsentAt` so restored provider activities become visible again. Do not reconcile when a provider response is partial because of rate limits, auth failures, or other fetch errors.

## Supported Providers

- **API sync providers**: Amazfit/Zepp, BodySpec, Concept2, Coros, Cycling Analytics, Decathlon, Eight Sleep, FatSecret, Garmin, Komoot, MapMyFitness, Peloton, Ride with GPS, Strava, Suunto, TrainerRoad, Ultrahuman, VeloHero, Wahoo, Wger, Withings, Xert, Zwift.
- **Import-only providers**: Cronometer CSV, Strong CSV.
- **Planned via native/mobile flows rather than this directory**: Apple Health and WHOOP BLE capture live in the mobile app and native modules.

## Amazfit/Zepp

The Amazfit/Zepp provider uses the private Zepp/Mi Fit cloud API exposed to the Zepp web and mobile apps. It is configured with:

- `ZEPP_APP_TOKEN`: app token from the Zepp account/session.
- `ZEPP_USER_ID`: numeric Zepp user ID.
- `ZEPP_API_BASE_URL`: optional API base URL for region-specific hosts. Defaults to `https://api-mifit.zepp.com`.

The first sync slice reads `/v1/data/band_data.json` and stores decoded daily steps, distance, active calories, sleep sessions, and minute-level heart rate samples.
