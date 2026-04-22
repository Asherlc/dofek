# Documentation

Architectural records, provider guides, and reverse engineering research for Dofek.

## Architecture & Schema

- `schema.md`: Explains the "Raw Data Only" philosophy. Lists columns we intentionally do not store (e.g., distance, calories) because they are derivable from raw sensor streams.
- `schema.dbml` / `schema.puml`: Automatically generated ER diagrams of the `fitness` schema.
- `adding-a-provider.md`: Step-by-step guide for implementing new data sources using the `SyncProvider` or `ImportProvider` interfaces.

## Reverse Engineering Guides

Dofek specializes in deep integration with fitness platforms that lack public APIs.

- `reverse-engineering-apis.md`: The canonical guide to our research methods:
  - **APK Decompilation**: Using `jadx` to extract internal API endpoints and data models from Android apps.
  - **Browser Inspection**: Capturing XHR/Fetch traffic from web applications.
  - **Proxy Interception**: Using `mitmproxy` or PacketLogger for mobile traffic.
- `reverse-engineering-walkthrough.md`: A complete end-to-end example of reverse-engineering a new service.
- `whoop-ble-protocol.md`: Detailed breakdown of the WHOOP 4.0 BLE protocol, including frame formats (Maverick 8-byte header), CRC16-MODBUS/CRC32 implementation, and sensor packet structures (types 0x2B, 0x33, 0x34).

## Provider Specifics

| Provider | Key Features / Research |
|----------|------------------------|
| **WHOOP** (`whoop.md`) | Internal Cognito auth, `weightlifting-service` for Strength Trainer sets/reps, R21 raw IMU data capture. |
| **Apple Health** (`apple-health.md`) | Detailed mapping of `HKQuantityType` to `sensor_sample` channels. |
| **Oura** (`oura.md`) | Focus on readiness, sleep stages, and proprietary stress/resilience metrics. |
| **Garmin Connect** | Research into the complex 5-step SSO flow (OAuth1 → OAuth2 exchange). |
| **Zwift** (`zwift.md`) | Reverse-engineered Keycloak auth and activity detail endpoints. |
| **TrainerRoad** (`trainerroad.md`) | Cookie-based form login with CSRF extraction. |
| **Peloton** (`peloton.md`) | WebSocket-based real-time metrics capture research. |
| **Eight Sleep** (`bodyspec.md`) | Hardcoded client credentials discovered via APK. |

## Operations

- `ci-debugging.md`: Pro-tips for diagnosing CI failures, specifically how to extract Swift compiler errors from truncated iOS build logs using `gh api`.
- `testing.md`: Practical patterns for test assertions with chainable DB mocks (`values(...)` payload checks, guarding against accidental `values([])` inserts).
- `xcode-cloud.md`: Configuration and troubleshooting for our automated iOS build pipeline.
- `provider-api-audit.md`: Periodic review of provider API health and data coverage.
- `metric-stream-timescaledb-runbook.md`: Production runbook to convert `fitness.metric_stream` to a Timescale hypertable and enable compression safely.
- `bugsink.md`: Runbook for investigating Bugsink issues/events from terminal (auth, canonical API flow, stacktrace retrieval).

## CI Preview Apps

- Storybook previews are active via `review-app-storybook.yml` (PR artifacts uploaded to R2).
- The old web preview workflow (`review-app-web.yml`) has been removed; do not reintroduce it as commented-out config.
