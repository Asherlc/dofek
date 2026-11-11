# Providers-Meta Agents

> [!IMPORTANT]
> Read the [README.md](./README.md) first for the canonical overview of this package.

## Core Mandates
- **Sync with Asset Storage**: When adding a logo to [the provider catalog](src/provider-catalog.ts), verify the corresponding file exists in [`../web/src/public/logos/`](../web/src/public/logos/) and review both clients' `Brand/ProviderLogo → All Providers` stories. Vite serves this directory relative to the configured [`root: "src"`](../web/vite.config.ts); see [Vite's public directory documentation](https://vite.dev/guide/assets.html#the-public-directory).
- **Provider ID Normalization**: Some providers use multiple IDs (e.g., `apple-health` and `apple_health`). Ensure both are mapped in `PROVIDER_LABELS`.

## Implementation Notes
- **WHOOP Wear Locations**: The `WHOOP_WEAR_LOCATION_SETTING_KEY` ("whoop.wearLocation") is used to persist the user's preferred sensor placement.
- **Stat Ordering**: `DATA_TYPE_LABELS` defines the display order for statistics. Activities and Metric Streams are prioritized.
- **Fallback Logic**: `providerLabel(id)` returns the raw ID if no mapping exists in `PROVIDER_LABELS`.
