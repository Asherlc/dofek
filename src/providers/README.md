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
- **Data Mapping**: Providers transform vendor-specific JSON into Dofek's internal schema (see `src/db/schema.ts`).

## Supported Providers

- **Wearables**: Apple Health, Fitbit, Oura, Garmin, WHOOP, Polar, Suunto.
- **Nutrition**: Cronometer (CSV), FatSecret.
- **Fitness**: Peloton, Strava, Zwift, TrainerRoad, Concept2, Ride with GPS.
- **Body Comp**: BodySpec (DEXA), Withings.
- **Recovery**: Eight Sleep.
- **Strength**: Strong (CSV), Wger.
