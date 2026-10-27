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
  [`activitySourceTreeWithHardware(tree, hardware)`](src/activity-source-hardware.ts)
  clones the source tree and nests hardware beneath its reporting record. Recording
  device facts enrich existing Apple Watch or Garmin device nodes; specific models,
  reported details, and power evidence use optional node `details`. Unmatched
  records remain separate reporting-source roots rather than implying import
  ancestry. This projection preserves the distinction between FIT creators and
  device inventory described in the linked Garmin activity-file specification.

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

### Device display names

[`deviceDisplayName` and `appleDeviceModel`](src/device-names.ts), exported from
`@dofek/providers/device-names`, resolve device labels for both clients and server
presentation. Source records retain their original identifiers and provider
provenance. Recognized Garmin model symbols such as `fr955`, `edge530`, and
`fenix8` become readable names without adding an edition or size; supplied
camel-case or underscore qualifiers remain part of the name. Readable branding,
custom names, and unrecognized identifiers remain intact. The existing
[Garmin catalog](https://apps.garmin.com/api/appsLibraryExternalServices/api/asw/deviceTypes)
provides the model-family spelling; no FIT SDK is imported into this package.

The checked-in [Apple device catalog](src/apple-device-catalog.ts) projects
identifier/name pairs from [AppleDB's public device API](https://api.appledb.dev/device/main.json),
using upstream revision
[`90134cb81b2dc60306b1bb694081e8e5692398f6`](https://github.com/littlebyteorg/appledb/tree/90134cb81b2dc60306b1bb694081e8e5692398f6)
(2026-10-25). It includes public Apple Watch, iPhone, all iPad families, and iPod
touch records, excluding `internal: true` entries. For example, `Watch6,9` resolves
to **Apple Watch Series 7 (GPS + Cellular, 45mm)**. The snapshot retains AppleDB's
[MIT license and copyright notice](https://github.com/littlebyteorg/appledb/blob/90134cb81b2dc60306b1bb694081e8e5692398f6/LICENSE).
Resolution uses this bundled snapshot without fetching a catalog at runtime.
The snapshot corrects the upstream `Watch5,11` size to 40mm, matching Apple's
[A2353/A2355 identification](https://support.apple.com/en-us/108056). Preserve
this correction when refreshing until the upstream record is corrected.

The [hardware projection](../server/src/models/activity-hardware.ts) uses the
resolved model in device headings and omits product codes and raw Apple model
identifiers from displayed details. Original provider payloads retain those facts.

To refresh, download the linked device API and record the corresponding
[upstream revision](https://api.github.com/repos/littlebyteorg/appledb/commits/main).
Select records whose `internal` field is not `true` and whose `type` is
`Apple Watch`, `iPhone`, `iPod touch`, or starts with `iPad`; expand each record's
`identifier` array into identifier/name pairs and sort identifiers. Reject
conflicting names for an identifier instead of silently choosing one. Replace
the snapshot, preserve the upstream license notice, update its revision/date
and this reference, then run the package tests and typecheck. Unknown identifiers
remain unchanged until a refreshed snapshot recognizes them.

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

Cloud push providers use **Updates automatically** and **Update history**.
Their **Last update processed** timestamp comes from `lastProcessedUpdateAt`:
the [provider API](../server/src/routers/sync.ts) queries successful ingestion
events on `push_ingest` operations with recorded output, through the
[sync repository](../server/src/repositories/sync-repository.ts). It does not
represent receipt time, a failed attempt, a permission-only notification, or
dashboard readiness. Historical polling logs are retained but are not
reclassified as incoming updates. No update history is a neutral first-update
state; missing authorization instead requests connection or reconnection.
The [shared presentation](src/sync-card-summary.ts) preserves newer downstream
processing and real error details, while [history labels](src/sync-log-presentation.ts)
give reconnect guidance only for authorization failures. Mobile-origin BLE
sources retain their mobile-specific synchronization flow. This distinction
matches [Garmin Starter's push-only delivery](https://developer.garmin.com/gc-developer-program/overview/).

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
