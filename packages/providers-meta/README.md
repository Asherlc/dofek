# @dofek/providers-meta

Metadata and statistics for data providers.

## Features

- **Activity hardware**: The [hardware contract](src/activity-hardware.ts) carries
  server-normalized FIT file creators, provider-reported recording devices,
  observed sensors, source apps, coarse equipment categories, provider provenance,
  optional device details, and reported power-meter/estimated-power evidence.
  FIT creators may be export platforms; observed FIT devices are inventory
  evidence, not per-sample attribution; see
  [Garmin's activity-file description](https://developer.garmin.com/fit/articles/file-types/activity.html).

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

### Garmin recording-device thumbnails

The [Garmin model lookup](src/garmin-devices.ts) supplies product thumbnails for
recognized recording-device names to the web and iOS provider-icon components.
Its checked-in snapshot comes from Garmin's [Connect IQ device
catalog](https://apps.garmin.com/api/appsLibraryExternalServices/api/asw/deviceTypes),
including the catalog's alternate model names. Matching normalizes accents,
trademarks, punctuation, and an optional Garmin prefix. Unknown or ambiguous
models retain the Garmin logo; failed image loads also return to that logo.

The snapshot prefers verified transparent Garmin product images when available,
otherwise retaining the catalog's thumbnail URL. Images load on demand; there
is no runtime catalog fetch. Product images represent a model and may group
sizes; they do not establish the recording device's color or SKU. Refresh the
snapshot from the linked catalog when adding a newly supported device, preserve
complete alternate model names, omit standalone edition/display qualifiers,
and verify the resulting image before changing its URL.

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

Provider detail summaries use
[`providerSyncStatusPresentation`](src/sync-card-summary.ts) to compare recorded
sync outcomes with processing evidence. Missing outcome history receives a
neutral presentation; newer processing retains its progress and details.
The [provider API](../server/src/routers/sync.ts) supplies recent outcomes and
successful-sync timestamps separately from connection and authorization state.

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
