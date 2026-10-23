# @dofek/providers-meta

Metadata and statistics for data providers.

## Features

- **Activity origin**: The [origin contract](src/activity-origin.ts) identifies
  the closest available recording or explicitly unresolved attribution. Field
  priorities never establish recording origin.

- **Provider Identity**: Mapping of provider IDs to human-readable labels and logo types (SVG vs PNG).
- **WHOOP Wear Locations**: Definitions and parsing for WHOOP-specific sensor placement (wrist, bicep, etc.).
- **Provider Stats**: Utilities for aggregating and labeling record counts across different data types (activities, sleep, nutrition, etc.).

## Implementation Details

### Logos and Branding

- `PROVIDER_LABELS` provides the canonical display name for each provider.
- [`providerLogoType` and `providerLogoId`](src/providers.ts) resolve provider icons from the [provider catalog](src/provider-catalog.ts).
- [`BRAND_COLORS`](src/provider-catalog.ts) provides fallback colors for providers without dedicated logos (e.g., `dofek` uses `#4A9D8E`).

### WHOOP Wear Locations

Supported locations are defined in `WHOOP_WEAR_LOCATIONS`. The `parseWhoopWearLocation` function ensures any input defaults to `wrist` if invalid.

### Statistics

The [ProviderStats interface](src/provider-stats.ts) tracks counts for ten data
types, including `climbingLogEntries` with the label “Climbing log”.
`providerStatsBreakdown` returns every entry, including zero-valued counts, with
its human-readable label. The [server statistics repository](../server/src/repositories/sync-repository.ts)
counts retained climbing logs directly, including undated and provider-absence
records, without multiplying counts by their grades or attempts.

### Provider Health

The [manual connection contract](src/provider-connection.ts) distinguishes public
profile identity from an access token. Both clients use that capability to show
profile input as text and protect access-token input, without inferring the
connection kind from the provider's name or catalog entry.

Use [`providerHealth`](src/provider-health.ts) as the shared presentation contract for web and
mobile provider status. It keeps connection state separate from authorization state and exposes
`requiresReconnect` as the canonical signal for reconnect actions. Providers requiring reconnection
display a warning connection status of Disconnected even when credentials remain saved (see the
[shared status contract](src/provider-health.ts)); providers that require no authorization report
authorization as not required.

Processing-status presentation helpers, including dataset-scoped failure messages, live in
[`processing-status.ts`](src/processing-status.ts).

### Disconnect and Data Deletion

Use [`providerDangerZoneCopy`](src/provider-disconnect.ts) for the shared web/mobile impact
wording. Disconnect removes saved authorization and stops future syncs while retaining imported
records. **Delete All Data** is a separate operation that permanently removes imported
provider records without changing connection state. The server enforces those semantics through
[`deleteProviderAuthorization`](../../src/db/tokens.ts) and
[`requestProviderDataDeletion`](../server/src/repositories/provider-detail-repository.ts).

Provider sync-history entries use
[`sync-log-presentation.ts`](src/sync-log-presentation.ts) to turn structured status and
authorization reasons into the same actionable summary on web and mobile. Clients keep the raw
status, authorization reason, error, and log identifier available separately as diagnostics.
