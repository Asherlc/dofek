# @dofek/onboarding

Onboarding flow logic and provider categorization.

## Features

- **Provider Categorization**: Groups supported providers into logical categories like "Activity Tracking", "Sleep & Recovery", "Nutrition", etc.
- **Onboarding Visibility**: Logic to determine when the onboarding flow should be presented to the user.
- **Settings Integration**: Shared key for persisting onboarding state.

## Implementation Details

### Categories
Providers are grouped into `ONBOARDING_CATEGORIES`. Each category includes a title, description, and an array of `providerIds`. For example, "Nutrition" includes `cronometer-csv` and `fatsecret`.

### Display Logic
The `shouldShowOnboarding` function determines if the flow should be shown. It returns `true` only if the user has zero connected providers and has not previously dismissed the onboarding (as indicated by the `dismissed` flag).
