# Provider Guide Agents

> [!IMPORTANT]
> Read the [README.md](./README.md) first for the canonical overview of this package.

## Core Mandates
- **Provider Consistency**: When adding a new provider to the platform, ensure it is added to the appropriate `PROVIDER_GUIDE_CATEGORIES` in `src/provider-guide.ts`.
- **Dismissal Persistence**: Use `PROVIDER_GUIDE_SETTINGS_KEY` ("provider_guide_dismissed") when interacting with the `user_settings` table to track dismissal.

## Implementation Notes
- **Show Logic**: `shouldShowProviderGuide(connectedProviderCount, dismissed)` is the source of truth for visibility. If a user connects their first provider, the guide should automatically stop showing.
- **Provider Lists**: The `providerIds` in categories are subsets of the full provider list, focused on the most relevant ones for that category.
