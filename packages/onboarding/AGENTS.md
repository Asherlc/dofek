# Onboarding Agents

> [!IMPORTANT]
> Read the [README.md](./README.md) first for the canonical overview of this package.

## Core Mandates
- **Provider Consistency**: When adding a new provider to the platform, ensure it is added to the appropriate `ONBOARDING_CATEGORIES` in `src/onboarding.ts`.
- **Dismissal Persistence**: Use `ONBOARDING_SETTINGS_KEY` ("onboarding_dismissed") when interacting with the `user_settings` table to track dismissal.

## Implementation Notes
- **Show Logic**: `shouldShowOnboarding(connectedProviderCount, dismissed)` is the source of truth for visibility. If a user connects their first provider, onboarding should automatically stop showing.
- **Provider Lists**: The `providerIds` in categories are subsets of the full provider list, focused on the most relevant ones for that category.
