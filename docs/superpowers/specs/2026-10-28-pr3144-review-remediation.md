# PR 3144 review remediation

The user approved fixing valid review findings, rerunning CI, then merging. They
explicitly chose versioning the existing running API response. The protected
merge of reviewed head `5f130c59067ed5e8f5edae95cfcfd7a94fb0c6dd` was rejected
while new [CodeRabbit feedback](https://github.com/Asherlc/dofek/pull/3144#pullrequestreview-5691619749)
remained unresolved. Administrator bypass is outside this chosen direction.

## Required behavior

- Preserve raw step identities, source-bundle grain, ambiguity rejection, and
  same-source overlap policy. Resolve every retained name's most-specific device
  rule, then choose the best configured bundle priority with a stable name/rule
  tie-break. Unmatched names do not override matched device rules. This replaces
  the nondeterministic representative described by [ClickHouse `any`](https://clickhouse.com/docs/reference/aggregate-functions/reference/any).
- Repair and rollback finish a finite canonical cadence scope in disjoint batches
  of at most 100 before rebuilding dependent summaries. Retain old aliases before
  upstream regrouping, expand the refreshed scope, freeze its canonical key list,
  build exact batches, and verify every key advanced. Keep the ordinary 100-key
  model limit. Empty scopes initialize an empty target; missing prerequisites,
  incomplete batches, and nonconvergence fail visibly.
- Keep old running responses as the default; updated clients explicitly request
  `responseVersion: 2`. Preserve old required numeric fields without fabricating
  missing values; the new format retains partial runs and nullable measurements.
  Use permanent response negotiation on existing procedures, following the
  [existing response-version pattern](../../../packages/training/src/climbing-log-response.ts),
  with separate cache keys and shared runtime response validation. No new alias
  procedure or transitional bridge. Both web and mobile request the new format.
- Invalid running responses render an actionable error and report unexpected
  validation failures. Preserve valid stale data and server error messages.
- Push each non-additive HealthKit type before querying the next type. Keep
  additive statistics/menstrual records on their existing final upload path.
- Step-only workout writes restore presence and reconcile canonical groups under
  the existing group lock in one Postgres transaction. Partial uploads never
  reconcile absence. Keep raw sensor writes and anchor acknowledgment semantics.
- Narrow running-workout discovery to actual parent intervals rather than gaps
  in a page-wide min/max range, in both discovery passes. Preserve authoritative
  workout associations and every page parent; no truncation or premature anchor
  acknowledgment. Querying sample time ranges follows [HealthKit predicates](https://developer.apple.com/documentation/healthkit/hkquery).
- Keep SQL continuation redaction active across timestamp-like payload lines;
  reset at verified log record boundaries while preserving real error context.
  Structured string values have no independent log record framing.
- Diagnostic filesystem failures retain a safe bounded error code and tell the
  operator which operation failed; do not expose paths, URLs or raw exceptions,
  or claim missing artifacts exist. Capture failures remain nonzero.
- XML imports do not retain running samples in unused daily aggregation buffers.
  Reject nonfinite parsed values before destructive replacement/writes, preserving
  the parser's existing invalid-record behavior.
- Strengthen populated strain-row forwarding, full-sync range arguments, and
  genuinely absent `CLICKHOUSE_URL` tests.

## Constraints and acceptance

No new dependencies, environment variables, stored metric aggregates, branch
switch, history rewrite, production operation, retries, timeout increases,
disabled checks, or compatibility aliases. Existing native release/history-sync
boundaries remain. Keep all new route tests under `app-tests`.

Use real database engines for SQL/grouping behavior and unit tests for transport,
validation and redaction. Exercise 101+ canonical repair keys including alias
expansion, old/new groups and rollback; assert downstream cadence values, not
only successful dbt exit. Test reversed arrival and stable device-rule ties.
Run all required CI on the final pushed head, address review threads with concrete
evidence, and merge only after protections are satisfied.

## Implementation calls and trade-offs

The controller selects the best configured device priority across retained names
and a lexical tie-break, preserving the original bundle grain. A mixed bundle's
best configured member therefore determines bundle priority. Finite canonical
scope is temporary operation state, never a new persisted source of truth.
Interval-union discovery removes historical gaps while preserving complete
association checks; it is not a promise of a fixed number of overlapping
workouts. These choices avoid data truncation and keep the accepted raw-interval
strategy intact.
