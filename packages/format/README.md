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
- **Date Labels**: `formatDateShort`, `formatDateMedium`, `formatDateLong`, `formatMonthYear`, and `formatWeekdayShort` provide shared human-readable date labels. Use `formatDateYmd` for local query dates and `formatDateYmdInTimeZone` when the date key must be computed in a named timezone.
- **Time Labels**: `formatDateTime`, `formatTimeOnly`, `formatWeekdayTime`, and the legacy `formatTime` wrapper provide shared human-readable time labels.
- **Relative Time**: `formatRelativeTime` provides human-readable strings like "just now", "5m ago", "2h ago", and "3d ago".
- **Durations**: `formatDurationMinutes`, `formatDurationSeconds`, and `formatDurationRange` format time spans as "Xh Ym", "Xm", or "Xs".
- **Hour Formatting**: `formatHour` converts decimal hours to localized 12/24-hour strings, normalizing Unicode non-breaking spaces for consistent display.

### Numeric Formatting

- `formatNumber`: Safely formats finite numbers with fixed decimals; returns `--` for `NaN` or `Infinity`.
- `formatPercent`: Converts 0–1 ratios to percentage strings.
- `formatSigned`: Prefixes positive values with `+`.

### Domain Metric Formatting

Use the shared domain helpers from `@dofek/format/format` anywhere these values are displayed:
- Nutrition values: `formatNutritionNumber`, `formatCalories`, `formatGrams`, and `formatNutritionAmount` use 0 decimals.
- Body composition values: `formatBodyCompositionNumber` and `formatBodyCompositionPercent` use 1 decimal.
- Recovery and training values: `formatHRV`, `formatSpO2`, `formatSteps`, `formatIntensity`, and `formatTrainingLoad` use 0 decimals; `formatSteps` also groups thousands.
- Dates and times: use the shared date/time helpers above instead of direct `toLocaleDateString`, `toLocaleTimeString`, `toLocaleString`, or ad hoc `toISOString().slice(0, 10)` in display code. Use `formatTableCellValue` for generic table cells and detail modals that may contain dates or timestamps.
- Time spans: `formatDurationMinutes`, `formatDurationSeconds`, and `formatDurationRange` provide human-readable durations.

These helpers use `Intl.NumberFormat` with fixed fraction options and `style: "unit"` where the JavaScript runtime supports the unit. `kcal` is appended manually because current runtimes do not expose a standard kilocalorie unit identifier.

### Activity Data States (`activity-data-state.ts`)

Server-authored activity values use a discriminated state: `available`, `missing`, `stale`, `failed`, `processing`, or `conflicting`. Every non-available state carries a reason so clients can explain why a value is not displayed instead of substituting zero, a dash, or an empty value.
