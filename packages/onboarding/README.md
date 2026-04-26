# @dofek/onboarding

Provider guide visibility logic and provider categorization.

## Features

- **Provider Categorization**: Groups supported providers into logical categories like "Activity Tracking", "Sleep & Recovery", "Nutrition", etc.
- **Provider Guide Visibility**: Logic to determine when the provider guide should be presented to the user.
- **Settings Integration**: Shared key for persisting provider guide state.

## Implementation Details

### Categories
Providers are grouped into `PROVIDER_GUIDE_CATEGORIES`. Each category includes a title, description, and an array of `providerIds`. For example, "Nutrition" includes `cronometer-csv` and `fatsecret`.

### Display Logic
The `shouldShowProviderGuide` function determines if the guide should be shown. It returns `true` only if the user has zero connected providers and has not previously dismissed the guide.
