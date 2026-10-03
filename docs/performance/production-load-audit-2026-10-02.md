# Production page-loading audit — 2026-10-02

## Outcome

Production can render navigation quickly while withholding essential data for
tens of seconds. The clearest cases are Daily Heart Rate, Running's pace curve,
and Training's heart-rate zones: each remained incomplete after 20 seconds of
browser observation. Matching backend work took 30.54, 26.16, and 22.76 seconds,
respectively. Repeat visits were much faster because those results were cached.

This is an audit of the live application at [dofek.fit](https://dofek.fit/),
not a before/after optimization report. No application behavior, database schema,
production cache contents, or deployment configuration was intentionally changed.
Ordinary page reads naturally populated caches. Findings remain unresolved.

## Scope and measurement

- **Release:** both production web replicas ran `3b517084d`; image digest
  `sha256:5d71c9fb51188c5cb7ecc380628a966aa35b7521c5fc6de296e845fb3b959b7f`.
  Source inspection used that release and the audit checkout; newer nutrition
  repository changes in the checkout were not treated as deployed.
- **Window:** evening of October 2, Pacific time; October 3 UTC. The main
  instrumented page sweep ran approximately 03:39–03:52 UTC; public-page
  measurements, production diagnostics, and separate traces surrounded it.
- **Coverage:** 58 recorded authenticated page/navigation observations, including
  the desktop inventory below, eight desktop repeats, eight mobile emulations,
  three activity details, and five client-side navigation events. Additional isolated
  public-page loads, filter interactions, and DevTools traces were recorded.
- **Desktop:** Chrome, 1440 × 1000, no CPU/network throttling for the main sweep.
  Static assets and the service worker were already cached after sign-in.
  Full page loads recreated the in-memory query client; server cache state was
  mixed and was not reset. “First sweep” does **not** mean every cache was cold.
- **Mobile web:** 390 × 844, device scale factor 3, DevTools Fast 4G and 4× CPU
  slowdown. Authenticated runs retained browser asset caches. These are simulated
  mobile web results, not measurements of a physical phone or the native app.
- **Cold public load:** isolated browser contexts with no existing service worker
  or browser asset cache. No signed-in cold-browser run was performed.
- **Instrumentation:** navigation/resource timing, paint and long-task observers,
  DOM mutations sampled on animation frames, screenshots/snapshots, and separate
  Chrome performance traces. Network timings were correlated with Axiom slow
  logs, sampled spans, and ClickHouse query logs. Chrome explains the trace
  model in its [Performance documentation](https://developer.chrome.com/docs/devtools/performance).

**Two different milestones are retained.** FCP measures the first paint of
content, which can be a shell or loading state. “Data present” below means the
relevant text, rows, or chart canvas had entered the rendered DOM; “settled”
means the observed loading indicators had also cleared. This avoids calling a
page fast merely because its heading appeared.

DOM timestamps are useful-content estimates, not frame-exact proof that every
chart pixel has painted. The application has a 350 ms page-entry transition,
and charts can animate after mounting. A DOM timestamp may precede FCP; use the
later milestone as the earliest possible visible result. LCP and screenshots
provide complementary paint evidence, but LCP does not certify that every
secondary chart has loaded. See the
[page transition](../../packages/web/src/routes/__root.tsx) and
[web styles](../../packages/web/src/index.css).

Results are individual lab observations from one signed-in account and one
network location, not population medians or p95s. Fast empty states do not prove
fast populated states. The three initial >20-second observations were stopped
before completion; later server completion times are explicitly separate and
must not be presented as exact browser completion times.

## Desktop inventory

Times are seconds from navigation, rounded to two decimals. “Repeat” is a
subsequent full navigation with warm backend/browser caches, not a fix.
A dash means not measured or unavailable.

| Page / view | FCP | Relevant data present, first sweep | Repeat data present | What the user waits for |
|---|---:|---:|---:|---|
| Dashboard | 0.52 | 0.49 | 0.33 | Primary cards and insights; repeat processing indicator settled at 0.51 |
| Activities | 0.43 | 2.25 | 0.29 | Summary at 0.55, activity cards at 2.25 |
| Sleep | 0.26 | 0.39 | 0.39 | Rows at 0.34, charts at 0.37, sleep need at 0.39; indicators persisted to 3.62 |
| Body | 0.76 | 0.88 | — | Metrics at 0.81, six charts at 0.88 |
| Nutrition / food log | 1.14 | 1.12 | — | Food entries; DOM populated shortly before first paint |
| Training | 0.34 | **>20.00** | 0.42 | First chart 2.47, calendar/volume 2.78, activities 6.08; HR zones still pending |
| Settings → Data Sources (via /providers) | 0.92 | **5.21** | 0.86 | Provider cards and sync information |
| Data Quality | 3.69 | **3.65** | — | Data-quality results; late first paint too |
| Correlation | 0.33 | **4.46** | 0.29 | Controls appeared at 0.31; computed results much later |
| Health Report list | 0.30 | 0.28 | — | Empty list; no shared report detail available |
| Running | 0.38 | **>20.00** | 0.30 | Early trend/dynamics; activities at 3.67; pace curve still pending |
| Cycling | 0.42 | 0.51 | — | Table at 0.40, charts at 0.51 |
| Strength | 0.46 | **3.85** | — | Strength metrics at 0.65; activity list last |
| Recovery | 0.31 | 0.42 | — | Metrics at 0.41, charts at 0.42 |
| Climbing training | 0.47 | **3.35** | — | Analytics at 0.52; activity list last |
| Hiking | 0.62 | **2.75** | — | Analytics/available empty states at 0.59; activity list last |
| Endurance | 0.38 | **3.32** | — | Analytics at 0.46; activity list last |
| Daily Heart Rate | — | **>20.00** | 0.28 | Heading at 0.23; source chart still pending |
| Nutrition Analytics | 2.01 | **3.72** | — | TDEE/micronutrients at 1.99–2.08; macro ratios last |
| Supplements | 0.30 | 0.95 | — | Empty stack at 0.28; safety information last |
| Experiments | 0.28 | 0.27 | — | Empty/list state; not a populated experiment detail |
| Tracking | 0.32 | 0.30 | — | Current data/empty state |
| Weekly Report | 0.56 | 0.53 | — | Report content |
| Monthly Report | 0.40 | 0.37 | — | Report content |
| Behavior Impact | 0.32 | 0.30 | — | Insufficient-data state |
| Cycle | 0.29 | 0.27 | — | Empty state |
| Settings default category | 0.30 | 0.28 | — | Default settings content; distinct from Data Sources |
| Alerts | 0.26 | 0.24 | — | Empty state |
| Clinical Records | 0.25 | 0.23 | — | Empty list; no detail record available |
| More | — | 0.21 | — | Static navigation; no primary data query |
| Developer Integrations | 0.33 | 0.31 | — | Integration list |
| Admin overview | 0.30 | 0.28 | — | Overview only; not every admin tab |
| Walking activity detail | 2.02 | 1.99 | — | Summary and two charts |
| Running activity detail | 1.95 | 1.95 | — | Summary/charts; route-map LCP at 2.40 |
| Climbing activity detail | 2.34 | **3.93** | — | Primary detail at 2.30; dependent climbs request finishes later |

Legacy /insights and /predictions redirected to Body; they are not additional
independent data views. Public legal/support/reset flows, every provider detail,
all admin categories, populated clinical/experiment details, shared health-report
tokens, and all possible date ranges were not exhaustively measured. No writes,
sync triggers, report generation, account-setting changes, or load test were
needed for this audit.

## Mobile web and paint checks

| Page | FCP | Relevant data present | Observed LCP | Notes |
|---|---:|---:|---:|---|
| Public landing, cold browser | 2.18 | 2.08; provider labels 2.57 | 2.48 | No existing service worker or browser cache |
| Dashboard | 1.19 | **4.32** | 1.24 | Main cards by 1.43, health section 2.21, insights 4.32 |
| Activities | 1.59 | 1.54 | — | Processing settled at 1.68 |
| Training | 2.00 | 2.28 | 2.33 | Warm query batch ended at 1.27; chart/DOM work continued |
| Sleep | 1.41 | 1.88 | 1.92 | Processing/global chart indicators persisted to **4.86** |
| Nutrition | 2.19 | 2.15 | — | Data and initial paint both delayed |
| Data Sources | 1.47 | **5.69** | **5.73** | Fresh provider-query work dominates |
| Correlation | 1.54 | 1.51 | — | Warm server result |
| Running | 1.40 | 1.61 | 1.64 | Warm server result |

Separate DevTools traces, without the DOM audit observer, measured:

- Desktop warm Dashboard: **LCP 0.415 s, CLS 0.05**.
- Mobile warm Training: **LCP 2.917 s, CLS 0.00** under the same 4×/Fast 4G
  emulation; this is a different run from the 2.33-second table entry.
- Desktop warm public landing: LCP 0.455 s, CLS 0.00; warm login: 0.310 s,
  CLS 0.00. An isolated cold desktop landing measured FCP 0.752 s and
  LCP 0.900 s, before the main viewport was standardized.

The mobile Training trace attributed approximately 339 ms of main-thread work
to PostHog and reported 105 ms of forced reflow, with chart-rendering call sites.
Those are optimization leads, not additive components of total load time.
A 732-element DOM alone does not justify a DOM rewrite.

The standard good thresholds are LCP ≤2.5 s, INP ≤200 ms, and CLS ≤0.1, evaluated
at the 75th percentile of field visits. These individual lab samples cannot
establish a field pass. INP, field percentiles, Speed Index, and a formal TBT
score were not established in this audit.
[Source: Web Vitals](https://web.dev/articles/vitals).

## Filter changes and client navigation

| Interaction | Existing content | Time to replacement data |
|---|---|---:|
| Daily Heart Rate → previous day | Chart removed 0.16 s after interaction marker; absent for **16.73 s** | 16.89 s from marker; request 16.72 s |
| Training → 90-day to 30-day range | All seven chart canvases removed within 0.03 s; charts return progressively | **7.31 s** until all seven return and indicators clear |
| Activities → 4 to 8 weeks | Existing cards preserved; no blocking loading state | 1.85 s; request 1.83 s |
| In-app return to Training | Cached content appears promptly | 0.05–0.07 s text; 0.10 s charts |
| In-app return to Activities | Cached cards appear promptly | 0.06 s |
| First in-app visit to Sleep in that query client | Progressive content | 0.19 s data; 0.29 s settled |

Interaction markers were placed immediately before automation clicked, so they
include a small automation dispatch delay. The chart-absence interval is measured
between actual DOM changes and does not depend on that delay.

The Daily Heart Rate and Training range behavior violates the existing
[loading runbook's stale-data policy](loading-performance-runbook.md#client-loading-policy).
The query hooks in [DailyHeartRatePage](../../packages/web/src/pages/DailyHeartRatePage.tsx)
and [Training](../../packages/web/src/routes/training/index.tsx) need review.
Use the existing TanStack Query
[placeholder-data mechanism](https://tanstack.com/query/latest/docs/framework/react/guides/paginated-queries)
where the previous result remains meaningful, with an explicit refreshing state
so old data is not mislabeled as belonging to the newly selected date/range.
Apply equivalent behavior to the corresponding native screens when fixing it.

## Confirmed backend bottlenecks

### 1. Three sensor queries dominate the worst waits

The following fresh Axiom slow logs identify cache misses on the measured release.
Times are UTC on October 3. ClickHouse entries are successful query completions,
not timeout/error durations.

| Procedure | Slow-log time | Resolver time | ClickHouse execution | Read rows / bytes | Evidence IDs |
|---|---|---:|---:|---|---|
| heartRate.dailyBySource | 03:44:41.229 | **30.536 s** | **30.507 s** | 57,852,063 / 4.99 GiB | Trace `f05f449c8f9bec1db34f5e28fec36a55`; query `7d5979b6-763a-4c0a-ba2e-e45a4428dbda` |
| durationCurves.paceCurve | 03:42:32.125 | **26.164 s** | **26.153 s** | 20,693,944 / 457.93 MiB | Trace `e3c79016e62b019e88c8550851c5409c`; query `393a9e91-312c-4504-905c-bffb0a67ce94` |
| training.hrZones | 03:41:31.793 | **22.756 s** | **20.878 s** | 10,580,664 / 250.71 MiB | Trace `57e1bd979641bd544762cc55b00cc406`; query `e32f1194-868d-4867-a2f4-2c1ed1118451` |

**Daily Heart Rate:** the
[repository's dailyBySource query](../../packages/server/src/repositories/heart-rate-repository.ts)
reads raw per-source samples with FINAL, minute aggregation, and window statistics.
The live raw table sorts by
`(user_id, activity_id, channel, recorded_at, id)`, with no partition expression;
the daily source query has no activity-ID restriction. The measured 57.9 million
rows establish a broad read for this daily view. Investigate pruning with
EXPLAIN and a source-preserving daily/minute access path. Do not replace this
query with provider-deduped results: comparing separate sources is the purpose
of the page.

**Running pace curve:** the
[getPaceCurveRows implementation](../../packages/server/src/repositories/clickhouse-activity-sensor-store.ts)
performs cumulative/window calculations across 12 durations and joins derived
sensor results during the request. The query log proves 26.15 seconds of
ClickHouse execution. The inspected analytics catalog has no corresponding pace
curve read model. Evaluate an incremental result at a domain-appropriate grain
while preserving deduplication, ranges, and duration semantics; confirm parity
against real ClickHouse fixtures before replacing the calculation.

**Training HR zones:** the
[getHrZones implementation](../../packages/server/src/repositories/training-repository.ts)
classifies sensor samples with temporal/resting-heart-rate joins at request time.
An [activity HR-zone model](../../analytics/models/read_models/activity_heart_rate_zones.sql)
already exists, but its resting-heart-rate baseline differs from the request
query. Reconcile those semantics before attempting reuse. Adding a second
competing model or blindly substituting the existing table would be unsound.

These findings satisfy the runbook's evidence gate for targeted query/read-model
work. Begin with EXPLAIN and query-log comparisons, following
[ClickHouse's query optimization guidance](https://clickhouse.com/docs/guides/clickhouse/performance-and-monitoring/query-optimization).
Do not infer that increasing timeouts, disabling deduplication, or raising queue
concurrency would fix this work. The unexplained difference between HR-zone
resolver and execution time is not assigned wholly to queueing without a trace.

### 2. Other data requests routinely cost seconds

Fresh slow logs in the same sweep recorded:

| Procedure / family | Resolver time | User impact |
|---|---:|---|
| sync.providers | 4.923 s | Data Sources cards arrive after 5.21 s |
| correlation.computeV2 / observations | 4.155 / 4.176 s | Correlation data arrives after 4.46 s |
| processing.dataQuality | 3.416 s | Data Quality arrives after 3.65 s |
| processing.status | 3.362 s | Sleep's processing widget and global spinners linger |
| activity.list | 2.475–5.779 s across measured sport pages | Recent activities are much later than the analytics |
| nutritionAnalytics.macroRatios | 3.466 s | Nutrition Analytics' last result arrives after 3.72 s |
| nutritionAnalytics.adaptiveTdee / micronutrients | 1.810 / 1.707 s | First nutrition analytics panels arrive around 2 s |
| food.byDateV2 | 0.875 s | Food log contributes roughly a second of server wait |

Representative trace IDs: providers
`63ec0e9e3fc39c61df3995f848ccb532`; correlation
`053ecfa6728ea42b37fe782498ebfd39`; data quality
`98469500fd526c41e4bf510149ff5bc4`; processing status
`afcd218122f5f1196a00ea268e673891`.

Older sampled traces help identify where to investigate, but are **not** direct
proof of the child timings on the current release:

- September 30, `a9eb732e955ae27476a0f905591a40ef`: sync.providers 4.579 s;
  PostgreSQL ranked sync-log query 4.463 s. The current
  [sync repository](../../packages/server/src/repositories/sync-repository.ts)
  still ranks per-provider history before limiting rows. Live indexes include
  `(user_id, provider_id, synced_at DESC)` but omit the query's ID tie-breaker.
  Inspect a current query plan and bounded per-provider reads before prescribing
  another index.
- September 28, `342c2aeee702d173871f9c6b40cf40c2`: insights 2.586 s;
  PostgreSQL nutrition-daily work 2.424 s; ClickHouse children only 14–80 ms.
  This is evidence against assuming all slow health queries are ClickHouse.
- September 27, `e1c283d083e4b28cb05fe5d2d88aefa8`: activity.stream 4.013 s,
  including 3.439 s queue wait and 0.460 s ClickHouse execution; HR zones
  4.033 s, including 3.899 s queue wait and 0.021 s execution.
  The [sensor-store limiter](../../packages/server/src/repositories/limited-activity-sensor-store.ts)
  has separate bounded queues. Queueing is a real historical slowdown class;
  it is not proven to explain every current activity-detail delay.

Both web replicas and the inspected database services were healthy. A point-in-time
ClickHouse CPU reading was approximately 120.6% against a 150% container CPU cap,
with 3.65 GiB memory against 13 GiB. This shows competing resource usage, not proof
that a larger machine is the correct fix or that CPU saturation caused every wait.

## Client-side causes and misleading loading states

### Global fetching state makes unrelated charts look busy

[FetchingContext](../../packages/web/src/lib/FetchingContext.tsx) uses global
`useIsFetching`; [DofekChart](../../packages/web/src/components/DofekChart.tsx)
and [ChartContainer](../../packages/web/src/components/ChartContainer.tsx) consume
that state. Thus a processing-status request can animate a chart spinner despite
the chart already containing data, and an empty chart can look pending because
another query is fetching.

Sleep demonstrates the distinction: its substantive data arrived around
0.39 seconds, but processing.status took 3.36 seconds and loading indicators
cleared at 3.62 seconds. On mobile, substantive data arrived at 1.88 seconds
while indicators remained until 4.86 seconds. Count query-specific initial loading,
background refreshing, empty, and error states separately.

### Cold public pages eagerly load the chart runtime

An isolated public landing load requested `echarts.lazy-DJ2fbB8j.js` at about
162 ms, alongside the entry bundle, although the landing page has no chart.
A separate compressed HTTP download measured:

| Asset | Compressed response body |
|---|---:|
| Entry JavaScript | 201,866 bytes |
| ECharts chunk | **375,580 bytes** |
| React chunk | 56,797 bytes |
| tRPC chunk | 23,036 bytes |
| These four assets combined | **657,279 bytes (about 642 KiB)** |

The chart chunk expands to approximately 1.14 MB. Other chunks/images are
additional; this is not a complete page-transfer total. Cross-origin Resource
Timing reported zero byte counts for some assets, so HTTP response measurements
were used instead of interpreting zero as no transfer.

The [Vite configuration](../../packages/web/vite.config.ts) assigns the name
`echarts.lazy`, but naming a chunk does not make it lazy; DofekChart imports
echarts-for-react statically. Automatic route splitting is not enabled in that
configuration, although some explicit lazy routes already exist. Evaluate the
existing router's
[automatic code splitting](https://tanstack.com/router/latest/docs/guide/automatic-code-splitting)
and a true chart import boundary. No additional library is required. Preserve
chart availability and test cold public and authenticated journeys.

Immutable asset cache headers are already present. A generic cache-header change
is not supported by this evidence.

### Bootstrap and dependent queries add serial waits

The [root AuthGate](../../packages/web/src/routes/__root.tsx) waits for session
bootstrap even for public routes. In the isolated mobile landing load, the auth
request started around 1.73 seconds and completed around 1.91 seconds, after
initial JavaScript work. Public content appeared around 2.08 seconds. Review
whether public content can render without waiting while maintaining correct
session and account-erasure behavior.

The [Dashboard](../../packages/web/src/pages/Dashboard.tsx) enables insights
after four primary query families resolve. Mobile LCP was 1.24 seconds, but
insights arrived at 4.32 seconds. This prioritization may be intentional; report
the secondary milestone rather than counting early LCP as complete data.

Climbing activity detail has a dependent request: primary data appeared at
2.30 seconds, then approximately 1.62 seconds of climbing work brought final
content to 3.93 seconds. Assess whether the dependency is necessary before
changing request scheduling. The existing
[tRPC client](../../packages/web/src/lib/trpc.ts) already uses streaming batches
and separate transport for selected dashboard-critical queries; this audit does
not establish a blanket need to remove batching.

## Observability and repeatability

Instrumentation was working: fresh structured slow logs and ClickHouse query
logs confirmed the largest bottlenecks. Axiom stored the inspected spans and logs
together in `dofek-logs`; a separate `dofek-traces` dataset was not accessible.
The configured trace sampler was parent-based with a 0.1 ratio. Several relevant
historical query groups had only two or three spans, which is insufficient for
a meaningful population p95.

The slow-query field named `db_duration_ms` encloses resolver execution; it is
not a sum of database-only child spans. Use the
[server middleware](../../packages/server/src/trpc.ts), child spans, and engine
query logs to distinguish those measurements.

A repeatable, read-only query for the captured window is:

```bash
rtk proxy axiom query "['dofek-logs'] | where ['service.name'] == 'dofek-web' and body contains 'Slow query' | project _time, body, trace_id | sort by _time asc" --start-time=2026-10-03T03:39:00Z --end-time=2026-10-03T03:53:00Z --format=json
```

For the three engine queries, read `system.query_log` by the query IDs above
and project `query_duration_ms`, `read_rows`, `read_bytes`, `memory_usage`,
and `tables`. Discover the current Swarm container before using the canonical
[deployment access procedure](../../deploy/README.md). Do not print credentials
or full SQL with user identifiers. Query-log and telemetry retention may expire;
the identifying timings and counts are preserved in this report.
[Axiom CLI reference](https://axiom.co/docs/reference/cli);
[ClickHouse query log reference](https://clickhouse.com/docs/operations/system-tables/query_log).

The inspected client sends a route-resolved
[pageview](../../packages/web/src/App.tsx), but no dedicated relevant-data-ready
event was found. Existing pageviews and automatic web vitals therefore do not
supply a trustworthy page/section completion percentile. Add that milestone to
the existing telemetry path before defining a population loading SLO. Record
route template, section, navigation/filter type, release, elapsed time, and
ready/empty/error outcome; do not include health values, record IDs, or raw URLs
containing identifying query parameters.

Raw browser observations, which can contain account data, remain in ignored
workspace `.context/load-audit/` files rather than committed documentation.
The report preserves anonymized timings and diagnostic IDs. No production
credentials or health measurements are included.

## Recommended order and acceptance criteria

These are proposed follow-ups, not an approved implementation plan.

1. **Fix the three measured sensor-query paths.** Start with Daily Heart Rate's
   broad read, pace-curve computation, and HR zones. Compare results against
   executable database fixtures and production read-only samples; retain source
   and deduplication semantics. Measure fresh range/date keys as well as cache
   hits. Existing read-model semantics must be reconciled before reuse.
2. **Preserve useful content and scope loading indicators.** Fix Daily Heart Rate
   and Training filter blanking and remove unrelated global fetching from chart
   readiness. Verify both web and corresponding native screens. Previous data
   should remain visibly marked as refreshing until replacement succeeds; empty
   and error states must still be explicit.
3. **Reduce remaining multi-second database work.** Obtain current child plans
   for sync.providers, activity.list, correlation, nutrition, and processing
   status, in that order of observed impact and frequency. Do not infer the
   underlying engine or query from parent duration alone.
4. **Reduce cold-load JavaScript and mobile rendering work.** Isolate charts from
   public routes, review the public session gate, and profile chart updates and
   PostHog work on the same throttled scenario. Keep only changes with measured
   improvements and no route/auth regressions.
5. **Measure useful-data completion continuously.** Use existing telemetry for
   field percentiles and distinguish initial load, cached return, filter change,
   and background refresh. Preserve the separate first-paint and useful-data
   milestones in dashboards.

Suggested targets for agreement: primary data by 2 seconds and all requested
visible sections by 3 seconds in a specified reference profile, no blanking when
usable previous data exists, and standard good Core Web Vitals at field p75.
These are proposed product budgets, not claims that the current system meets
them. Validate any fix with repeated warm and fresh-key runs; report sample
counts and medians/ranges, not a p95 from a handful of observations.

## Retrospective

Combining browser observations with current engine query logs distinguished real
data waits from misleading spinners and avoided blaming all slow pages on one
database. Cache state, empty views, sampled historical traces, and DOM-versus-paint
timing required careful interpretation. The next audit needs an explicit
section-readiness contract and a repeatable account/filter coverage matrix.

Proposed runbook additions: a working direct-Axiom-CLI example when helper scripts
are unavailable; discovery of the actual trace dataset before assuming its name;
and a definition of first paint, primary-data readiness, complete-data readiness,
and refresh preservation. Use the web-performance and production-log inspection
workflows again; keep detailed browser readiness and cache-state guidance in the
shared loading runbook. No retries, timeouts, queue limits, or other resilience
settings were changed.

## Implementation follow-up evidence

The user subsequently approved the
[under-one-second implementation plan](../superpowers/plans/2026-10-02-subsecond-page-loading.md).
The earlier proposed budgets above are historical; acceptance now requires every
successful required observation below 1,000 ms under the approved profiles.
These additional read-only observations identify query work; they do not claim
that any production page meets the target.

Fresh sampled requests on October 2 (October 3 UTC) used the existing browser
session and a sampled trace header for each request. No global tracing settings,
cache lifetimes, or production application behavior changed.

| Procedure / trace ID | Procedure time | Confirmed child work |
| --- | ---: | --- |
| `sync.providers` / `384ba3dc3722484998c096e570c633b1` | 524 ms | Ranked sync history: 488 ms. Separate bounded read-only EXPLAIN read 596,427 history rows to return 53; execution 542 ms. |
| `correlation.computeV2` / `a39230ec8103456a8cdd1443e0f0dfc9` | 3,479 ms | PostgreSQL daily nutrition: 2,701 ms. |
| Nutrition macro ratios / `2670a8c4a6bc4c61b869ecf0972e1b8b` | 2,637 ms | PostgreSQL daily nutrition: 2,629 ms. |
| `processing.dataQuality` / `6bc55c4aae334f769caa0ea8dbff2bd1` | 6,999 ms | Two sequential route-preview reads: 3,294 and 3,270 ms; each read 19,982,527 location rows. |
| `processing.status` / `5498c1d23cd54f8db1ddac18cf3fead8` | 105 ms | One fast observation; the original slow-path baseline remains unresolved. |

The Data Quality children match ClickHouse query IDs
`c9df0bb2-0cd8-4975-a236-b770e9dd913c` and
`f75f7c8c-29c0-4e7e-89ce-5ef09ef6d4f1` by timestamp and duration.
The [route-preview query](../../packages/server/src/repositories/activity-route-preview.ts)
selects `toString(activity_id) AS activity_id` and also uses unqualified
`activity_id` in its predicate. The deployed engine's EXPLAIN resolves that
predicate through the alias and selects all 2,450 granules, even for five
requested activities. This matches ClickHouse's documented
[expression alias substitution](https://clickhouse.com/docs/reference/syntax#notes-on-usage).

A controlled read-only comparison qualified the predicate's source column.
EXPLAIN selected 32 of 2,450 granules. Both executions returned the same 485 rows
with identical output hashes. Query-log results were:

| Query | Execution | Rows read | Bytes read |
| --- | ---: | ---: | ---: |
| Original `11ca370d-b3a3-41d0-9858-ce293a009a4e` | 1,390 ms | 19,982,527 | 542,224,992 |
| Qualified `5874b9b1-4ae5-406b-8b2a-82ec7d88099c` | 42 ms | 256,208 | 11,613,287 |

This is one query comparison, not a repeated page acceptance run. No optimizer
setting or schema change was used. The production reader still needs its scoped
fix, executable regression test, and release validation.

A separate 10-second-bounded read-only EXPLAIN ANALYZE of the 90-day nutrition
macro query took 5,194 ms and returned 23 rows. Its daily-view join evaluated the
canonical nutrient branch 24 times. Inside that branch, a nested loop removed
about 1.26 million row pairs that did not match per iteration. This establishes a
concrete query-plan bottleneck; preserving canonical food-source resolution,
supplement inclusion, and ambiguous-day behavior remains mandatory. The
[canonical views](../../drizzle/0113_effective_food_records.sql) require a
separately reviewed query change and database parity tests.

Full plans and query parameters remain in ignored `.context/load-audit/` files.
Durations and row counts above come from the named traces, PostgreSQL plans, and
[ClickHouse query logs](https://clickhouse.com/docs/operations/system-tables/query_log).
