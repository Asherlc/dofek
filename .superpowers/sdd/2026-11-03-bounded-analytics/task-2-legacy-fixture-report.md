# Legacy sink private-fixture checkpoint

**DONE_WITH_CONCERNS:** fixture isolation fixed; the full suite is not GREEN.
BASE `87f837b30`. Source `89eb029a57780751c8d29540f3235b6e9dd3f1af`
is committed and pushed. No production source, root human docs or shared
canonical history were changed. The source scope is one integration test file.

## Verified cause and direct fix

Root's `legacy-sink-full-postfix.log` failed after3 passing cases at
06:07:27 UTC: `Source 5e6f7a8b-0c1d-4e2f-8a3b-4c5d6e7f8a90 has conflicting account owners`.
The old suite selected a new random account per invocation while reusing fixed
source UUIDs in retained canonical ClickHouse tables. Its cleanup deleted raw
rows/scopes but correctly retained structural placement history. Root verified
two account owners and five retained placements for that exact source. The
production collision check was correct; the test isolation was wrong.

The suite now obtains the existing `createMetricStreamAnalyticsTestContext()`:
one fresh private ClickHouse namespace plus its private PostgreSQL database,
current raw/control/work tables and actual source-placement materialized view.
Its client rewrites `ingest` and `analytics` references into that namespace.
The old global bootstrap and global raw/scope cleanup are removed; actual
context cleanup drops the private fixture, including structural history.

All15 test bodies/assertions, fixed source UUIDs, exact query-profile identity
checks and raw-row expectations are preserved. Existing case-specific setup,
cleanup and merge restoration now operate only inside the private namespace.
There is no canonical-history deletion, ID randomization, weakened ownership
rule, router/schema adapter or production behavior change.

The existing sink test wrapper now uses a fixture-owned AbortController through
`context.assertActive` and tracks actual sink promises. Final cleanup aborts new
admission, awaits those promises, then drops the private databases. Unexpected
settlement errors fail cleanup. Root explicitly approved this cooperative
cleanup to prevent another timeout followed by a query against a dropped DB.
It does not establish uncertain-executor crash recovery.

## Exact verification

The existing failing full suite is the RED evidence; no second reproduction on
shared canonical tables was performed. One full15 run followed the fixture fix:

```sh
rtk proxy pnpm tsx .superpowers/sdd/2026-11-03-bounded-analytics/run-database-tests.ts src/metric-stream/clickhouse-sink.integration.test.ts --retry 0 --bail 1
```

`legacy-sink-private-fixture.log`: **12 PASS,1 TIMEOUT,2 UNRUN**,71.90s,
4831 observed HTTP requests, no resource fatal. The first12 include the former
conflicting-owner case and the exact non-amplification/profile test. Also passed:
Zepp vectors/retries, UTC timestamp parsing, device timestamp identity,
globally latest provider ownership, nullable external-ID deletion, ordered
multi-scope deletion, row reactivation, live/history replacement precedence,
omitted old-history guards and exact mixed-version behavior.

First failure at06:13:37.249 UTC:
`applies a long delete run within HTTP limits before its replacement rows`
hit the unchanged **30000ms** test deadline. Its350 deletions, replacement row
and assertions are unchanged. This is an OPEN performance/qualification gate;
no retry, smaller workload, timeout increase or optimization was applied.
The final nullable/bounded-scope and deletion-ACK cases were unrun due bail.
This result does not claim full15-case functional completion.

Cleanup started06:13:37.249 and completed06:13:37.855 UTC (606ms): cooperative
sink settlement preceded private context deletion. There was no post-DROP
UNKNOWN_DATABASE error or cleanup failure. Runner88803 exited1, and a subsequent
process check found no test worker. This is local cooperative scheduling
evidence, not a process-absence proof of general production recovery.

- `rtk proxy pnpm typecheck`: passed, `legacy-fixture-typecheck.log`.
- `rtk proxy pnpm exec biome check src/metric-stream/clickhouse-sink.integration.test.ts`:
  passed with no fixes, `legacy-fixture-biome.log`.
- `rtk proxy git diff --check`: passed before commit.

No Docker lifecycle, image, cap, global setting or deadline changed. The
existing120s setup-hook allowance is unchanged. Root's matched local query-log
candidate remained active; no production/resource pass is claimed. DB slot was
returned to root after the stopped run; no further DB commands were started.

## Self-review and follow-up

The change fixes the causal state-sharing problem instead of erasing evidence
that the production resolver must retain. Fixed source IDs still exercise the
same identity rules. Private merge controls and the existing profile decorator
preserve actual query IDs, preventing instrumentation from changing ownership.
No schema/diagram or dependency/environment changes were needed.

The original provider1001-effect gate remains OPEN and was not rerun. The350
legacy gate and two unrun cases remain explicit follow-up work after separately
reviewed performance changes. Full Task2/native ACK/bootstrap/erasure/resource
qualification remains incomplete.

Retrospective: retained structural history exposed an old raw-only fixture
cleanup assumption. Reusing the current-schema private helper resolved the
ownership failure without changing real semantics. Future database-test guidance
should require raw and structural metadata to share one private fixture lifetime;
reuse integration-tests-ready and systematic-debugging for similar failures.
