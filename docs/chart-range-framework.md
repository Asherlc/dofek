# Selected Chart Range Framework

Backend selected-chart endpoints should share one range model instead of each
router inventing its own `days` parsing, default, and SQL predicates. The
framework lives around the selected chart range manifest and `ChartRange` value
object in `packages/server/src/lib/`.

## Shape

Use one endpoint manifest as the registry for every selected-range chart:

- `endpoint`: stable tRPC endpoint key, such as `power.powerCurve`.
- `defaultDays`: the finite range used when the client omits `days`.
- `routerFile`: the server router that owns the endpoint.
- `input`: one of the supported input shapes, currently `days`, `dateRange`,
  or `custom`.

The manifest is the only place a selected chart's backend default range should
be declared. Do not add duplicate default-day constants in routers,
repositories, or clients.

## Route Builders

Routers should use the selected chart route builders instead of hand-writing
range schemas:

- `selectedChartRangeQuery(endpoint, ttlMs, resolve)` for `{ days }` inputs.
- `selectedChartDateRangeQuery(endpoint, ttlMs, resolve)` for
  `{ days, endDate }` inputs.
- `selectedChartCustomRangeQuery(endpoint, ttlMs, schema, resolve)` when the
  endpoint needs extra fields alongside `days`.

Each builder validates `days`, applies the manifest default when `days` is
omitted, and injects `range: ChartRange` into the resolver. Resolver code should
pass that value object to repositories rather than passing nullable numbers
around.

Use `custom` for any selected chart endpoint with fields beyond the framework's
standard input shape. For example, `{ days, endDate, limit, offset,
activityTypes }` is custom because pagination and filters are part of the API
contract, even though it also has an `endDate`.

## Range Semantics

`ChartRange` is the backend value object for selected chart ranges:

- `ChartRange.fromDays(30)` means the finite trailing 30-day range.
- `ChartRange.fromDays(null)` means All, modeled as an infinite lower bound.
- Omitted `days` does not mean All. It means "use this endpoint's manifest
  default".

This distinction matters for API compatibility. A client that sends no `days`
should keep getting the chart's normal default window. A client that sends
`days: null` explicitly asks for all available history.

For finite ranges, `ChartRange` owns lower-bound predicates and parameter maps
for Postgres and ClickHouse. For All, predicate helpers return no lower-bound
clause and parameter helpers omit the `days` parameter. Warmup ranges should use
`range.withWarmupDays(extraDays)` so All stays infinite while finite ranges
expand predictably.

## Repository Contract

Repository methods that serve selected charts should accept `ChartRange`:

```ts
async getPowerCurve(userId: string, range: ChartRange) {
  // Use range predicates and params inside SQL construction.
}
```

Avoid signatures like `days: number | null` once a route has parsed selected
chart input. The repository should not need to remember that `null` means All,
which default belongs to the endpoint, or which SQL parameters must disappear
for an unbounded query. That policy belongs in the builder plus value object.

If a repository also needs `endDate`, keep it separate:

```ts
async listSleep(userId: string, endDate: string, range: ChartRange) {
  // Date-window lower bounds come from range helpers.
}
```

## Add-A-Chart Checklist

1. Add one manifest entry for the tRPC endpoint with `defaultDays`,
   `routerFile`, and `input`.
2. Pick the matching route builder: `days`, `dateRange`, or `custom`.
3. In the resolver, pass `range` to the repository. Do not pass raw `input.days`
   past the router boundary.
4. Update the repository method to accept `ChartRange`.
5. Build SQL lower bounds and query params through `ChartRange` helpers.
6. Preserve the semantics: omitted `days` uses the endpoint default,
   `days: null` means All.
7. Add or update tests for the route default, explicit finite ranges, and
   explicit All where the chart behavior depends on the distinction.
