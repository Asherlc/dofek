# @dofek/format

Platform-agnostic formatting utilities for units, dates, durations, and numbers. Shared between web and mobile.

## Implementation Details

### Units and Conversions (`units.ts`)
The `UnitConverter` class provides a unified interface for converting and labeling metric data based on the user's `UnitSystem` ("metric" or "imperial").
- **Locale Detection**: `detectUnitSystem(locale)` automatically selects imperial for "US", "MM", and "LR".
- **Weight**: Converts kg to lbs using a factor of `2.20462`.
- **Temperature**: Converts Celsius to Fahrenheit using `(9/5) + 32`.
- **Pace**: Handles `/km` and `/mi` labels and conversions.

### Date and Time (`format.ts`)
- **Robust Parsing**: `parseValidDate` normalizes Postgres-style timestamps (space-separated) for JS engines like Hermes (React Native) and older Safari that only support ISO 8601.
- **Relative Time**: `formatRelativeTime` provides human-readable strings like "just now", "5m ago", "2h ago", and "3d ago".
- **Durations**: `formatDurationMinutes` and `formatDurationRange` format time spans as "Xh Ym" or just "Xm".
- **Hour Formatting**: `formatHour` converts decimal hours to localized 12/24-hour strings, normalizing Unicode non-breaking spaces for consistent display.

### Numeric Formatting
- `formatNumber`: Safely formats finite numbers with fixed decimals; returns `--` for `NaN` or `Infinity`.
- `formatPercent`: Converts 0–1 ratios to percentage strings.
- `formatSigned`: Prefixes positive values with `+`.
