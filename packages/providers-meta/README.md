# @dofek/providers-meta

Metadata and statistics for data providers.

## Features

- **Provider Identity**: Mapping of provider IDs to human-readable labels and logo types (SVG vs PNG).
- **WHOOP Wear Locations**: Definitions and parsing for WHOOP-specific sensor placement (wrist, bicep, etc.).
- **Provider Stats**: Utilities for aggregating and labeling record counts across different data types (activities, sleep, nutrition, etc.).

## Implementation Details

### Logos and Branding

- `PROVIDER_LABELS` provides the canonical display name for each provider.
- `resolveProviderProvenance` pairs that display name with the provider ID for
  server-authored source details. Clients should render the label by default
  and reserve the ID for explicit technical diagnostics.
- `SVG_LOGOS` and `PNG_LOGOS` sets determine the file format for provider icons.
- `BRAND_COLORS` provides fallback colors for providers without dedicated logos (e.g., `bodyspec` uses `#00B4D8`).

### WHOOP Wear Locations

Supported locations are defined in `WHOOP_WEAR_LOCATIONS`. The `parseWhoopWearLocation` function ensures any input defaults to `wrist` if invalid.

### Statistics

The `ProviderStats` interface tracks counts for 11 data types. `providerStatsBreakdown` returns only non-zero entries with their human-readable labels (defined in `DATA_TYPE_LABELS`).

### Provider Health

Use [`providerHealth`](src/provider-health.ts) as the shared presentation contract for web and
mobile provider status. It keeps connection state separate from authorization state and exposes
`requiresReconnect` as the canonical signal for reconnect actions. A provider can therefore remain
connected while its authorization needs attention; providers that require no authorization report
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
