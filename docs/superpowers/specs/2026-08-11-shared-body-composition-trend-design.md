# Shared Body-Composition Trend

## Goal

Present Weight and Body Fat in one shared body-composition surface on web and
iOS. A Weight / Body Fat selector changes both the summary grid and the trend
chart, so the selected metric has one coherent set of numbers and
visualization.

## Scope

- Replace separate weight-prediction and body-fat trend presentation with one
  selector-controlled surface on web and iOS.
- Add a server-authored Body Fat trend and prediction response that uses the
  same interpolation, smoothing, regression, confidence, and
  data-sufficiency rules as Trend Weight.
- Show the selected metric's headline, period-change grid, and chart with a
  dashed future projection.
- Keep the existing Recomposition chart unchanged.

## Data flow

`BodyAnalyticsRepository` remains the sole owner of trend calculation. It
will produce Body Fat trend points and prediction values from the existing
deduplicated body-composition measurements. The API returns those values in
the existing web overview and mobile recovery contracts. Neither client
smooths, estimates rates, or projects values.

Raw body-fat measurements remain stored and available as raw data. The
displayed Body Fat trend is an estimated series, just as Trend Weight is.

## Presentation

The shared card header contains a two-option selector: `Weight` and `Body
Fat`.

### Weight

Weight retains the existing fields:

- current Trend Weight and observed scale reading;
- rate, 7-day, 14-day, and 30-day changes;
- daily energy balance when available;
- goal estimate when a weight goal exists; and
- smoothed trend with an optional dashed projection.

### Body Fat

Body Fat uses the same layout and state handling, with values formatted as
percentages or percentage points:

- current estimated Body Fat and observed reading;
- rate, 7-day, 14-day, and 30-day changes;
- dashed future projection when the data is sufficient; and
- an explicit insufficient-data explanation when the trend or prediction
  cannot be calculated.

Body Fat does not show calorie balance, a goal, or a goal date. Those fields
cannot be derived responsibly from a body-fat percentage trend alone.

The selector falls back to the metric with available data when the initially
selected metric has none. It keeps the user-selected metric when both have
data.

## Error handling

- The existing body-composition query error remains visible and preserves any
  cached result during a background refetch.
- Each selected metric renders its own server-authored empty or
  insufficient-data state; clients do not substitute zeroes or fabricate
  estimates.

## Testing

Write tests before implementation for:

- server calculation of Body Fat smoothed points, rate, period changes, and
  projection under the same sufficiency rules as Weight;
- tRPC and mobile contracts exposing the new server-authored values;
- web selector changes affecting both the summary grid and chart;
- iOS selector changes affecting both the summary grid and SparkLine; and
- unavailable/insufficient Body Fat states without changing Weight behavior.

## Non-goals

- New body-fat storage, migrations, or provider-specific fields.
- Client-side metric calculations.
- Body-fat calorie-balance, goal, or goal-date estimates.
- Changes to raw measurement ingestion or the Recomposition chart.
