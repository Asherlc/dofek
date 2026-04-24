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

## Supported Providers

- **API sync providers**: BodySpec, Concept2, Coros, Cycling Analytics, Decathlon, Eight Sleep, FatSecret, Garmin, Komoot, MapMyFitness, Peloton, Ride with GPS, Strava, Suunto, TrainerRoad, Ultrahuman, VeloHero, Wahoo, Wger, Withings, Xert, Zwift.
- **Import-only providers**: Cronometer CSV, Strong CSV.
- **Planned via native/mobile flows rather than this directory**: Apple Health and WHOOP BLE capture live in the mobile app and native modules.
