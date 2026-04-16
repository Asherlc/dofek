# Providers-Meta Agents

> [!IMPORTANT]
> Read the [README.md](./README.md) first for the canonical overview of this package.

## Core Mandates
- **Sync with Asset Storage**: When adding a logo to `SVG_LOGOS` or `PNG_LOGOS`, verify the corresponding file exists in the web package's `public/logos/` directory.
- **Provider ID Normalization**: Some providers use multiple IDs (e.g., `apple-health` and `apple_health`). Ensure both are mapped in `PROVIDER_LABELS`.

## Implementation Notes
- **WHOOP Wear Locations**: The `WHOOP_WEAR_LOCATION_SETTING_KEY` ("whoop.wearLocation") is used to persist the user's preferred sensor placement.
- **Stat Ordering**: `DATA_TYPE_LABELS` defines the display order for statistics. Activities and Metric Streams are prioritized.
- **Fallback Logic**: `providerLabel(id)` returns the raw ID if no mapping exists in `PROVIDER_LABELS`.
