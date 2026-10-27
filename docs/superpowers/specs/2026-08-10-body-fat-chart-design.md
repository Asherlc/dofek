# Body Fat Percentage Chart

## Goal

Add a standalone body-fat-percentage trend chart to the Body experience on web
and the equivalent Recovery/body-composition area on mobile.

## Scope

- Reuse the existing server-owned body-composition measurements and the user's
  selected body time range.
- Add a web chart beside Trend Weight and Recomposition.
- Extend the mobile Recovery response with dated body-fat readings and render a
  compact percentage trend near Trend Weight.
- Preserve explicit loading, error, and insufficient-data states.
- Add focused unit/component tests for the chart, page integration, mobile
  rendering, and the mobile response contract/service.

## Data flow

The web chart will consume `bodyAnalytics.weightOverview.recomposition`, whose
rows already contain `date` and `bodyFatPct`. The chart will render those values
as percentages without deriving or aggregating them in client code.

The mobile recovery service will load the existing repository recomposition
rows for the selected range and expose only the dated `bodyFatPct` values in a
new response field. The mobile client will render that server-provided series
with the existing SVG-based `SparkLine` component.

The mobile body-fat query will use the same selected range as the Recovery
query. Existing weight data, body decision context, and weight prediction stay
unchanged.

## UI behavior

### Web

- Section title: `Body Fat Percentage`.
- Chart y-axis label: `%`.
- Tooltip values use the shared body-composition formatter and show the date.
- Fewer than two usable readings shows an explicit insufficient-data message.
- Loading and existing query error behavior use the page's established chart
  and query-state components.

### Mobile

- Add a `Body Fat %` card near `Trend Weight`.
- Show the latest value and a compact percentage SparkLine when readings exist.
- Do not show a misleading zero/empty chart when there are no readings.
- Format values with the shared body-composition formatter.

## Testing

- Web chart tests verify rendered series values, percentage tooltip formatting,
  and insufficient-data behavior.
- Web BodyPage tests verify the new chart is wired to the existing overview
  response.
- Mobile contract/service tests verify the new response field is populated
  from repository recomposition data and respects the selected date range.
- Mobile Recovery tests verify the card and SparkLine receive body-fat values.

## Non-goals

- No new database tables, columns, or provider-specific storage.
- No client-side smoothing, averaging, or body-fat calculations.
- No replacement of the existing Recomposition chart.
- No changes to the selected time-range controls or body analytics semantics.
