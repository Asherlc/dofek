# Activity Overview Partial Measurements Design

## Goal

Show the distance and elevation totals that were recorded for activities even
when other activities in the selected period have no corresponding measurement.
Compare those partial totals when both the current and previous periods contain
at least one measurement.

## Current behavior

The activity overview query already uses `sumOrNullIf` for distance and
elevation, so its numeric totals include only non-null measurements. The query
also returns a non-null measurement count for each metric. The repository then
requires that count to equal the activity count before exposing the sum; this
turns a valid partial sum into an unavailable value.

## Design

The repository remains the owner of availability and comparison semantics.

- A distance or elevation total is available when at least one activity in the
  period has that measurement.
- The total is the server-computed sum of recorded values only. Missing
  activities contribute nothing to the sum.
- A measured numeric zero remains available and is rendered as zero.
- A period with no measurements remains unavailable with the existing
  server-authored reason.
- When both periods have available measurements, the comparison is the
  difference between their partial totals, regardless of whether either period
  has complete measurement coverage.
- If either period has no measurement, the comparison remains unavailable.

No API fields, database schema, ingestion behavior, read model, or client-side
calculation changes are needed. The existing web and mobile renderers already
display available server-provided values and comparison magnitudes.

The `sumOrNullIf` behavior relied on here is documented by ClickHouse’s
[`-OrNull` aggregate combinator](https://clickhouse.com/docs/sql-reference/aggregate-functions/combinators#-ornull),
which returns `NULL` when there are no values to aggregate.

## Testing

- Update repository unit coverage to prove partial distance and elevation sums
  are available and that partial current/previous totals are compared.
- Keep coverage for fully unavailable periods and measured zero values.
- Add web and mobile regression assertions that partial server-provided values
  render instead of unavailable copy, including their comparison text.
- Run the focused repository, format, web, and mobile test files, then run
  relevant lint/type checks before completion.

## Scope

This change is limited to activity overview mapping and its web/mobile
regression coverage. It does not add coverage labels, change activity detail
metrics, alter ingestion or ClickHouse models, or infer values for activities
without measurements.
