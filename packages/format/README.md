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
- **Date Labels**: `formatDateShort`, `formatDateMedium`, `formatDateLong`, and `formatWeekdayShort` provide shared human-readable date labels. Use `formatDateYmd` for local query dates and `formatDateYmdInTimeZone` when the date key must be computed in a named timezone. See [the formatting helpers](src/format.ts).
- **Time Labels**: `formatDateTime`, `formatTimeOnly`, and the `formatTime` wrapper provide shared human-readable time labels. See [the formatting helpers](src/format.ts).
- **Localization**: Date/time labels follow the device locale and time zone, including its 12/24-hour clock convention. Pass `locale` or `timeZone` options for an explicit display context. API date keys remain `YYYY-MM-DD`. This uses the standard [Intl.DateTimeFormat locale and time-zone defaults](https://tc39.es/ecma402/#sec-createdatetimeformat).
- **Relative Time**: `formatRelativeTime` provides human-readable strings like "just now", "5m ago", "2h ago", and "3d ago".
- **Durations**: `formatDurationMinutes`, `formatDurationSeconds`, and `formatDurationRange` format time spans as "Xh Ym", "Xm", or "Xs".
- **Hour Formatting**: `formatHour` converts decimal hours to localized 12/24-hour strings, normalizing Unicode non-breaking spaces for consistent display.

### Numeric Formatting

- `formatNumber`: Safely formats finite numbers with fixed decimals; returns `--` for `NaN` or `Infinity`.
- `formatSigned`: Prefixes positive values with `+`.

### Domain Metric Formatting

Use the shared domain helpers from `@dofek/format/format` anywhere these values are displayed:
- Nutrition values: `formatNutritionNumber`, `formatCalories`, `formatGrams`, and `formatNutritionAmount` use 0 decimals.
- Body composition values: [`formatBodyCompositionNumber`](src/format.ts) uses 1 decimal.
- Recovery and training values: `formatHRV`, `formatSpO2`, `formatSteps`, `formatIntensity`, and `formatTrainingLoad` use 0 decimals; `formatSteps` also groups thousands.
- Dates and times: use the shared date/time helpers above instead of direct `toLocaleDateString`, `toLocaleTimeString`, `toLocaleString`, or ad hoc `toISOString().slice(0, 10)` in display code. Use `formatTableCellValue` for generic table cells and detail modals that may contain dates or timestamps.
- Time spans: `formatDurationMinutes`, `formatDurationSeconds`, and `formatDurationRange` provide human-readable durations.

These helpers use `Intl.NumberFormat` with fixed fraction options and `style: "unit"` where the JavaScript runtime supports the unit. `kcal` is appended manually because current runtimes do not expose a standard kilocalorie unit identifier.

### Activity Data States (`activity-data-state.ts`)

Server-authored activity values use a discriminated state: `available`, `missing`, `stale`, `failed`, `processing`, or `conflicting`. Every non-available state carries a reason so clients can explain why a value is not displayed instead of substituting zero, a dash, or an empty value.

### Climbing Context (`climbing-context.ts`)

Formats current Area paths, independent rope methods, scope-labelled recorded
outcomes, recorded attempt counts, and wall angles for web and mobile. Unknown
angle units remain labelled unknown. Clients render the supplied outcome and
count; the server derives free-rock result labels from the recorded attempt
facts. See the [shared model](../training/src/climbing-log.ts) and
[formatters](src/climbing-context.ts).

The [log formatter](src/climbing-log.ts) labels distinct recorded attempt styles once per
card and formats known counts as `Attempts: N`, omitting unknown counts supplied
as null by the [server contract](../server/src/contracts/climbing-log-contracts.ts).
Whole-climb summaries show the outcome
when recorded; pitch summaries retain their pitch label. Attempt details include
known outcomes, methods, protection, and Yes/No facts, omitting missing values
and internal references.


### Climbing cards

[Climbing summaries](src/climbing-log.ts) distinguish known unfinished attempts
(“Attempted”) from reaching the top (“Completed”), following
[Garmin's completion labels and separate fall count](https://www8.garmin.com/manuals/webhelp/GUID-BD965919-30AA-4EB5-95D7-A899658C50EB/EN-US/GUID-D67857E8-04FB-44CA-9D58-B77AB8D50F83.html).
Confirmed sends retain their result labels instead of a redundant “Completed”
label. Onsight and Flash also suppress redundant attempt counts. Pitch results
retain their scope. Rope methods and recorded falls or hangs appear as separate
text badges, grouped by recorded attempt style through the
[shared label formatter](src/climbing-log.ts). The
[Mountain Project forum discussion](https://www.mountainproject.com/forum/topic/124980013/onsight-vs-flash-vs-redpoint)
distinguishes Fell/Hung from a clean send without guaranteeing arrival at the top.
Unknown completion stays unlabeled even when the attempt is
known not to be a clean send; falling or hanging alone does not establish whether
the climber reached the top. See the
[server contract](../server/src/contracts/climbing-log-contracts.ts) and
[canonical send projection](../../drizzle/0148_compute_climbing_attempt_outcome.sql).

The [web card](../web/src/pages/activity-detail/components/ClimbingLogEntryCard.tsx)
and [mobile card](../mobile/components/ClimbingLogEntryCard.tsx) render outcome
and attempt-style labels as text badges, separately from attempt counts and pitch
context. Both use the [shared outcome formatter](src/climbing-log.ts) and
[semantic color palette](../scoring/src/colors.ts).
