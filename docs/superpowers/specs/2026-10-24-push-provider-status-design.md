# Push provider status wording

The approved web and mobile previews describe automatic incoming updates separately from connection and authorization health. Garmin's Starter integration is [push only](https://developer.garmin.com/gc-developer-program/overview/); the product must not prescribe a manual API sync it cannot perform.

## Behavior

- Cloud push providers show **Updates automatically**.
- A connected source with no recorded ingestion outcome shows **Waiting for first update**. Silence alone is neutral.
- **Last update processed** means successful push ingestion with actual emitted output, not delivery acceptance, an attempted job, a lifecycle notification, or dashboard readiness.
- Active work says **Processing Garmin data**; a successful ingestion says **Garmin update processed**; failure says **Couldn't process the latest Garmin update**. Preserve the server's actionable error message and the last successful processing timestamp.
- History is **Update history**, with matching empty states and accessibility labels. Historical polling attempts must not be presented as official push updates.
- Connection/authorization labels use the existing [provider-health contract](../../../packages/providers-meta/src/provider-health.ts). Reconnect guidance requires an actual authorization failure. Processing errors never offer manual Sync or unconditional automatic retry promises.
- Preserve polling providers' scheduled sync/freshness behavior and mobile-origin BLE-specific controls and copy. Shared presentation lives in `@dofek/providers` and both clients render it.

## Approach

A copy-only substitution leaves misleading timestamp and history evidence. The chosen approach reuses the existing [processing operation ledger](../../../src/processing/processing-event-store.ts) and its `push_ingest` kind, adds a nullable `lastProcessedUpdateAt` provider field, and presents push ingestion outcomes through existing history response shapes. No new storage, dependencies, receipt timestamp, or cutover heuristic is needed. New push evidence is recorded prospectively; old polling records remain stored and are not reclassified.

The user approved the screenshot direction and requested a PR. Exact text may adapt to context while preserving these semantics. Screenshots are illustrative, not runtime evidence.
