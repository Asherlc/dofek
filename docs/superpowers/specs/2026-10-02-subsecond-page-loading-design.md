# Production data loading under one second

Date: 2026-10-02 (Pacific time)

Status: written design approved; implementation plan awaiting review. This document defines
the intended behavior and validation gates. It does not claim that implementation
or production acceptance has occurred.

## Goal and scope

Display the relevant data for each audited page in **less than 1,000 ms**, measured
from navigation or a date/range interaction to the completed data presentation.
The user approved this target for both the desktop and throttled mobile-web
profiles used in the [production audit](../../performance/production-load-audit-2026-10-02.md).

The scope includes the desktop inventory in that audit, its activity-detail
examples, public landing/login, and date/range changes. The same web views must
be checked in both profiles. Native screens affected by shared APIs or loading
behavior receive matching correctness and refresh-preservation changes; a mobile
web measurement is not evidence of native runtime performance.

The project remains incomplete while any required measured scenario exceeds the
budget. An intermediate improvement, an empty fixture replacing a populated
view, or a cached result that does not match the selected range is not acceptance.

## Acceptance contract

### What completes a page load

A page is complete when every default data section has resolved to correct
content or a legitimate no-data state for the active request, and the visible
content has been painted. Include the default charts, tables, insights, provider cards,
and processing information where the page presents them. Sections below the
fold still belong to the default page; hiding or deferring an existing section
does not remove it from the budget. User-opened dialogs and additional paginated
results are separate interactions. Below-fold data must be ready within the same
deadline; revealing it must not trigger another required data fetch. Its paint
is checked when brought into view, since off-screen pixels are not visible.

For a full page load, timing begins at the browser navigation time origin,
including bootstrap and authentication checks. For client-side navigation it
begins at the user input event, before route code or queries are fetched.

For charts, completion requires the current series to render, not merely a canvas
element to exist. Use the chart renderer's completion signal and frame evidence;
disable or shorten data-reveal animation where it delays the final result.
For text/tables, record the committed current result and verify it in the next
paint opportunity. Cross-check instrumented milestones against a performance
trace and screenshots. The original audit's DOM estimates are the historical
baseline, not the final paint-level acceptance mechanism.
[ECharts event API](https://echarts.apache.org/en/api.html#events.finished);
[Chrome Performance tooling](https://developer.chrome.com/docs/devtools/performance).

Errors, unavailable infrastructure, and interrupted navigation have distinct
outcomes and do not count as successful loads within the budget. A legitimate empty
result is measured separately from populated data. Ordinary background polling
after the initial settled result does not restart the navigation timer.

A date/range change starts a new measurement at the actual input event. Retained
previous results improve continuity, but only the replacement matching the
selected inputs can complete that measurement.

### Reference profiles and cache states

| Dimension | Required condition |
|---|---|
| Desktop | Chrome, 1440 × 1000, no CPU/network throttling, same audit workstation/location |
| Mobile web | Chrome, 390 × 844, scale factor 3, Fast 4G, 4× CPU slowdown |
| Cold browser | Empty HTTP/asset/service-worker caches; preserve a valid session for authenticated tests |
| First data request | No previous in-memory result; include confirmed server-cache misses on populated inputs |
| Warm revisit | Existing browser assets and eligible server results |
| In-app navigation | Both first visits in the query client and cached returns |
| Filter changes | Heart-rate adjacent days; Training 90→30 days; Activities 4→8 weeks; other exposed ranges |
| Dataset | Production account used by the audit plus deterministic populated/empty regression fixtures |

Record Chrome/tool versions, actual network-emulation parameters, workstation,
release, viewport, filters, response/cache evidence, and dataset scale with every
benchmark. Do not mix profiles into a single aggregate. Do not flush production
caches to manufacture misses; use legitimate unvisited keys, or the matching
production-scale controlled benchmark for uncached execution. An unconfirmed
cache state must be labeled unknown and cannot serve as the miss sample.

Run at least five observations of each required scenario and retain every result,
including failures. Every successful required observation must be below 1,000 ms;
report median, maximum, and sample count without presenting five samples as a
reliable field p95. Field readiness telemetry supplies a separate longer-term
distribution. Performance runs are sequential observation, not a production
concurrency/load test.

For engineering allocation, aim for no more than 300 ms of resolver work along
the serial API critical path, leaving time for session/bootstrap, transfer, scheduling, and
rendering. This allocation guides diagnosis; only the end-to-end result passes.

## Architecture

Keep the existing Postgres, ClickHouse/dbt, Redis, tRPC, React/TanStack Router,
ECharts, and Expo stack. Introduce no replacement cache, chart library, analytics
platform, or orchestration service. Maintain the current public response shapes
unless additive readiness/freshness metadata is necessary for truthful display.

The serving path becomes:

```text
canonical raw data
  → current-state access / bounded incremental analytics
  → compact, indexed user-and-range reads
  → existing tRPC transport
  → current result rendered by the page
  → section/page readiness event in existing telemetry
```

Move only the expensive transformations named by evidence. Other queries receive
their own child-query diagnosis before behavior changes. The governing boundaries
are the [loading runbook](../../performance/loading-performance-runbook.md),
[analytics architecture](../../../analytics/README.md), and
[server architecture](../../../packages/server/README.md).

### Daily Heart Rate: efficient current-state reads, separate sources

The measured query reads 57.85 million rows for one day.
[HeartRateRepository](../../../packages/server/src/repositories/heart-rate-repository.ts)
must retain all providers, local-day boundaries, per-minute averaging, current
version resolution, deletion handling, ordering, and per-source summary values.

Use a covering access path on the canonical raw table that supports the
user/channel/time predicate, with explicit latest-state reduction where needed
to permit projection use. The current FINAL query cannot simply gain a projection
and be assumed faster: ClickHouse documents that SELECT FINAL does not use
projections. Confirm the deployed version's actual plan before changing the
query. [MergeTree projection restrictions](https://clickhouse.com/docs/engines/table-engines/mergetree-family/mergetree#projections).

The identity and latest-version precedence must match the raw table's replacement
contract. Resolve all fields from the same winning row. Apply deletion and
positive-value filters after version selection so an old live/positive value
cannot reappear when the new version is deleted or invalid. Only identity-stable
user/channel/time predicates may move before that reduction. Test tied versions
against the actual writer/engine contract rather than inventing a new ordering.

Inspect existing projections before adding one; reuse or replace an inadequate
access path instead of retaining redundant structures. A required covering
projection is an engine-maintained index over the canonical data, not a second
application write path. No provider-priority collapse or background-only daily
copy is introduced for this source-comparison endpoint, preserving its current
freshness behavior.
[ClickHouse projection behavior](https://clickhouse.com/docs/data-modeling/projections).

### Running pace curve: per-activity duration results

Create an incremental activity-duration serving model for the current fixed
durations: 5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 5400, and 7200 seconds.
Its logical grain is user, canonical activity, and duration. Retain best speed
before final pace rounding; apply selected activity dates/types and choose the
range best in the server's compact query.

The compatibility reference is
[getPaceCurveRows](../../../packages/server/src/repositories/clickhouse-activity-sensor-store.ts).
Preserve deduped sensor eligibility, activity windows, positive-speed filtering,
sample-interval inference, window rounding, insufficient-sample behavior,
local activity dates, and displayed pace precision. Do not silently introduce a
different gap-handling or time-weighting formula as a performance change.
Resolve tied winning dates deterministically within the existing result contract.

Use bounded dirty activity keys and complete recomputation of those selected
activities. Changed samples, deletion, membership/window changes, and type
changes invalidate the relevant results. Persist versions/tombstones so a removed
best effort cannot remain the winner. Historical input is built explicitly in
bounded operator steps before the new reader is released.

### Training HR zones: compact exact inputs, unchanged baseline

Training currently joins millions of sensor rows at request time. Its daily
resting-heart-rate baseline differs from the activity-detail model's median of
recent sleep windows. Reusing the latter's zone totals would change results.
References:
[TrainingRepository](../../../packages/server/src/repositories/training-repository.ts),
[activity zone model](../../../analytics/models/read_models/activity_heart_rate_zones.sql).

Introduce a compact per-activity heart-rate distribution with exact observed
values and their sample counts, derived from canonical deduped sensor data using
Training's existing activity-window eligibility. Preserve fractional observed
values; do not approximate them with rounded histogram bins. The server applies
the existing maximum/resting-heart-rate rules to those counts and aggregates the
selected activities into local weeks. This removes sample-level request joins
while allowing profile and resting-heart-rate changes to affect the calculation
without persisting a conflicting second set of training-zone totals.

Activity IDs, windows, timestamps, deletion/version state, and source watermarks
belong with the distribution. User and range restrictions apply before expanding
its counts. Existing activity-detail zone semantics remain intact. Reuse shared
sample inputs only after executable parity tests establish identical eligibility;
provider membership restrictions must not change silently.

### Incremental lifecycle and freshness

Both new derived paths stay in ClickHouse and the existing dbt build graph.
Use per-key source versions and bounded dirty work; a completed newer key must
not hide an older unfinished key. Include late arrivals, corrections, source
priority changes, activity merges/splits, changed time windows, deletions, and
processed-empty keys in lifecycle tests.
[dbt incremental models](https://docs.getdbt.com/docs/build/incremental-models).

Build dependencies in the same analytics cycle as their upstream inputs and
include them in the existing readiness and cache-refresh contracts. A page must
not declare the latest generation ready before its required derived data exists.
Keep last successful data with honest processing/freshness state during a build,
using the existing product contract. Do not lengthen cache TTLs or hide a model
backlog to meet the time budget.

Acceptance compares source-to-visible freshness before and after the change,
including a newly arrived observation and a deletion. If added processing cannot
meet the current freshness contract, stop for a design correction rather than
declaring an older result current. Missing infrastructure/model prerequisites
must produce an actionable error, never a successful empty response.
See the [processing-status contract](../../processing-status-runbook.md).

### Remaining multi-second requests

These requests remain part of the one-second goal; fixing the three longest
queries is not completion.

| Family | Required investigation and intended bounded work |
|---|---|
| sync.providers | Current PostgreSQL plan for per-provider history; restrict history reads to the requested latest rows and preserve timestamp/ID ordering |
| activity.list | Separate metadata, visibility/access checks, counts, and sensor reads; page/restrict canonical activity IDs before expensive detail work where semantics allow |
| correlation / insights | Measure data extraction versus statistics; share duplicated input reads within a request and optimize the confirmed expensive stage without changing statistical output |
| nutrition analytics / food log | Measure canonical nutrition-view work and repeated scans; preserve source resolution and ambiguity behavior |
| processing.status / dataQuality | Inspect the individual readiness checks; keep status correctness while eliminating repeated broad work |
| activity detail | Identify unnecessary sequential requests, including climbing detail; schedule independent work together without removing required dependencies |

Each implementation needs a current slow span/query plan, a parity fixture, and
an uncached benchmark. Indexes or additional derived models require evidence
specific to that family. Preserve access windows, user isolation, and pagination.
Do not turn historical traces from an older release into proof of a current
child-query cause.

## Client behavior and startup

### Query-specific loading and refresh preservation

Give charts explicit initial-loading and refreshing state from the queries that
supply their own data. Remove global fetching-count dependence from chart
readiness, including empty-chart handling, and migrate all affected consumers.
An unrelated processing poll must not make another chart appear pending.

Use previous query data during meaningful date/range changes on web and native.
Keep its original date/range/freshness label with a refreshing indication until
replacement arrives; do not redraw the old data against a new range and call it
current. On refresh failure retain useful previous content with the actual error
and stale state. Initial failure, empty result, and unavailable data remain
distinct.
[TanStack Query placeholder data](https://tanstack.com/query/latest/docs/framework/react/guides/paginated-queries).

### Critical JavaScript and rendering

Enable the existing router's route splitting consistently with explicit lazy
routes. Keep ECharts and route-only feature code out of public/auth startup.
Fetch the selected authenticated route's code alongside session bootstrap where
safe, avoiding a new serial chart-import delay on chart pages. Preserve
authentication and account-erasure gates.
[TanStack Router code splitting](https://tanstack.com/router/latest/docs/guide/automatic-code-splitting).

Public content should render without waiting for unrelated session data when it
can do so safely. Authenticated data remains gated by verified identity; cached
data must never cross users. Preserve login redirects, bootstrap errors, logout,
and account-erasure cleanup behavior.

Profile chart option updates, forced layout, page transitions, and third-party
startup under mobile throttling. Keep only measured changes. Avoid unnecessary
full chart recreation; finish data-reveal animation within the readiness budget.
Review PostHog feature startup using the existing configuration and consent rules;
do not disable required error reporting or delete product capabilities merely to
improve a benchmark. Preserve the current asset size limits.

## Readiness measurement

Add a small route/section readiness contract to existing telemetry and browser
regression scenarios. The page declares its required sections explicitly, including
conditionally present sections whose absence depends on a completed query.

Each navigation/filter operation gets a local generation. Sections report pending,
current data, genuine empty, or error for that generation, plus renderer completion.
Late results from a previous generation cannot complete the new one. The page
completes once all required sections are current and rendered. A chart-completion
event must be attached to the corresponding option/result generation.

Record route template, section, interaction kind, elapsed duration, outcome, and
release. Include cache status only when observable. Do not send health values,
record identifiers, raw URL query strings, or date filters. Reuse existing
PostHog/OTel/Sentry paths and account-erasure/consent controls. No new telemetry
service or environment variable is required.

Measurements remain lightweight. Validate with instrumented runs and a separate
Chrome trace; telemetry must not materially create the latency it reports.
Use existing Cypress for browser behavior regression checks, Vitest for state
contracts, and Chrome DevTools for production timings. Do not add a second
browser automation dependency or a generic benchmark framework.

## Validation and release

Write failing behavior tests before implementation. Real ClickHouse/Postgres
tests prove query/model behavior; string assertions are not database proof.

Required cases include source overlap; two users; timezone and DST boundaries;
late/duplicate/versioned records; deletion and resurrection; profile changes;
activity membership/window/type changes; finite and All-history ranges; sparse
samples; ties; empty inputs; refresh errors; user changes; and out-of-order
responses. Derive expected results independently and compare old/new readers on
the same fixture or source watermark.

Browser checks must verify that unrelated requests do not affect chart state,
filter changes preserve correctly labeled old content, errors stay visible,
current charts actually render, and public pages omit the chart runtime.
Run matching native tests for affected screens. Use a Release native runtime
check for changed refresh behavior; keep native timing results separate from the
mobile-web target.

Release through the canonical [deployment procedure](../../../deploy/README.md).
Schema migrations remain lightweight; required historical materialization/builds
are explicit bounded operations with progress and capacity checks. Prepare the
model data and verify correctness/readiness before releasing its reader. Do not
deploy a request-time fallback that silently repeats the original heavy query.

Keep queue concurrency, retries, and timeouts unchanged unless later evidence
proves a separate cause requiring an approved change. Monitor query latency,
read rows/bytes, queue wait, source-to-visible lag, build progress, and engine
resource usage together. Faster pages must not produce a growing processing
backlog.

Completion requires all normal validation gates, a production repeat of the
acceptance matrix with below-one-second results, unchanged data semantics and
freshness, and a before/after report. Deployment or measurement blockers leave
the production target explicitly unverified. Update the incident baseline when
the measured problems are resolved, not when code alone is committed.

## Review checkpoints and risks

Implementation planning follows written-design approval. The plan must sequence
measurement, each isolated query/model change, client work, integration checks,
and production acceptance, with explicit review checkpoints.

The main risks are model lifecycle correctness, changing HR baseline semantics,
projection/version handling, additional freshness lag, cold-mobile startup cost,
and declaring a canvas mounted before its data is painted. The preceding
contracts and tests address those risks; the one-second result itself remains
an empirical acceptance requirement, not a prediction guaranteed by this design.

The approved combined approach was chosen because cache-only work leaves fresh
keys slow, while server-only work leaves mobile bootstrap and rendering costs.
Existing platform capabilities cover the needed mechanisms without new services.

Design preparation confirmed the value of the browser-to-query audit and exposed
the HR-baseline and FINAL/projection constraints. Add the explicit readiness and
cache-state acceptance contract to the shared loading runbook during
implementation so future audits use the same definition.
