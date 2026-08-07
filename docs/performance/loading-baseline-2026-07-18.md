# Loading Performance Baseline: 2026-07-18

This report records the production loading baseline required by
[issue #1432](https://github.com/Asherlc/dofek/issues/1432). It is an evidence
artifact, not a backend optimization. The underlying Axiom query results and
intermediate findings are also recorded in the
[issue checkpoint](https://github.com/Asherlc/dofek/issues/1432#issuecomment-5014489586).

## Evidence window and method

- Dataset: `dofek-logs`, discovered from the configured `prod` deployment.
- Schema window: the 15 minutes before `2026-07-19T04:50:59Z`.
- Measurement window: the 24 hours ending approximately
  `2026-07-19T05:07:30Z` (`2026-07-18T05:07:30Z` through
  `2026-07-19T05:07:30Z`).
- Query method: APL through the repository's Axiom SRE query wrapper. Axiom
  documents APL syntax and query operators in its
  [APL introduction](https://axiom.co/docs/apl/introduction).
- Privacy: the report excludes user identifiers, query-cache keys, raw health
  data, and full ClickHouse URLs.

The previous baseline attempt on 2026-07-02 was blocked by the Axiom limiter.
This run succeeded: `getschema` returned 78 columns, including `name`,
`duration`, `trace_id`, `attributes.rpc.method`, and the
`attributes.custom` map. The successful schema-query trace was
`6a7fc3038f99385fe29d363a75c34226`.

## Reproducible queries

The tRPC aggregate used actual span fields discovered by `getschema`:

```apl
['dofek-logs']
| where _time > ago(24h)
| where name == "trpc.procedure"
| extend duration_ms = duration / 1ms
| summarize
    count = count(),
    min_ms = min(duration_ms),
    max_ms = max(duration_ms),
    avg_ms = avg(duration_ms),
    p50_ms = percentile(duration_ms, 50),
    p95_ms = percentile(duration_ms, 95)
  by procedure = ['attributes.rpc.method']
| sort by max_ms desc
```

The queue aggregate read the queue fields from the discovered custom map:

```apl
['dofek-logs']
| where _time > ago(24h)
| where name == "clickhouse.queue_wait"
| extend
    wait_ms = todouble(['attributes.custom']['clickhouse.queue.wait_ms']),
    queue = tostring(['attributes.custom']['clickhouse.queue.name'])
| summarize
    count = count(),
    min_ms = min(wait_ms),
    max_ms = max(wait_ms),
    avg_ms = avg(wait_ms),
    p50_ms = percentile(wait_ms, 50),
    p95_ms = percentile(wait_ms, 95),
    p99_ms = percentile(wait_ms, 99)
  by queue
| sort by max_ms desc
```

Trace-level queries then selected the exact `trace_id` values returned by the
aggregates and compared tRPC, ClickHouse HTTP, queue-wait, and Postgres spans.

## Current tRPC baseline

| Procedure | Samples | Minimum | Average | p50 | p95 / maximum | Classification |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `providerDetail.records` | 5 | 5.76 ms | 24.04 s | 31.20 ms | 120.01 s | Request-time ClickHouse query failure |
| `anomalyDetection.check` | 3 | 4.41 s | 17.56 s | 17.07 s | 31.21 s | Request-time ClickHouse query shape |
| `mobileDashboard.dashboard` | 5 | 19.09 ms | 110.49 ms | 74.79 ms | 284.16 ms | Fast in this window |
| `sync.dataHealth` | 11 | 1.60 ms | 79.82 ms | 32.27 ms | 248.01 ms | Fast in this window |

The named suspects `activity.stream`, `recovery.readinessScore`,
`recovery.workloadRatio`, `sleep.latestStages`, and `healthspan.score` had no
tRPC samples in the 24-hour window. No current claim about their latency is
possible from this run.

## Finding 1: anomaly detection blocks a mobile tRPC batch

Three mobile traces batched `anomalyDetection.check` with `sync.providers`,
`providerGuide.status`, `sync.dataHealth`, and `sync.activeSyncs`. The anomaly
procedure dominated each batch:

| Trace | Anomaly tRPC | Direct ClickHouse POST | Largest Postgres query |
| --- | ---: | ---: | ---: |
| `8e2634e7ebd538c90d83fc607abb44b7` | 4.41 s | 4.32 s | 95.69 ms |
| `b3b93206c1b6b898cd3c6f7ab9368be5` | 31.21 s | 30.98 s | 83.34 ms |
| `d6a52211e18f82fa7a45c1594772309a` | 17.07 s | 16.97 s | 101.83 ms |

In every trace, the long ClickHouse POST's parent span was the anomaly tRPC
span. Code context identifies this request as the 35-day resting-heart-rate
fetch in `AnomalyDetectionRepository.check()`, before the smaller Postgres
anomaly calculations. The first slow span in the largest trace began at
`2026-07-18T20:08:18.234Z` and ran for 30.98 seconds.

Classification:

- Primary: **request-time query shape** in the anomaly resting-heart-rate path.
- Amplifier: **tRPC batching interference**, because four fast sibling
  procedures cannot return until the anomaly procedure completes.
- Disproved for these samples: queue wait and Postgres execution.

This evidence is sufficient to scope a follow-up around the named anomaly
query family. It does not justify a general dashboard, readiness, or ClickHouse
queue change.

## Finding 2: provider metric-stream detail can time out or exhaust ClickHouse memory

`providerDetail.records` produced three errors in the same window:

- At `2026-07-18T18:14:47.131Z`, a Garmin-dump metric-stream request timed out
  after 120.01 seconds. Its direct ClickHouse POST ended with `socket hang up`.
- At `2026-07-19T00:09:23.001Z` and `2026-07-19T00:09:25.116Z`, Garmin
  metric-stream requests failed in 84.56 ms and 68.12 ms because ClickHouse's
  total memory limit was already exceeded. The reported maximum was 11.70 GiB.
- All three requested the first 25 metric-stream rows, and their regular-queue
  waits were only 0.05 ms, 0.28 ms, and 0.04 ms.

Classification:

- Primary: **request-time query shape / ClickHouse resource failure** in the
  provider metric-stream record query.
- Disproved for these samples: ClickHouse queue wait, Redis cache lookup, and
  Postgres execution.

This is a separate user-visible path from mobile loading. It warrants a
narrowly scoped follow-up, with ClickHouse query-log and row-scan evidence,
before changing the query or analytics model.

## Queue and infrastructure evidence

Across all 55 `clickhouse.queue_wait` spans:

| Queue | Samples | Average | p50 | p95 | Maximum |
| --- | ---: | ---: | ---: | ---: | ---: |
| `dashboard` | 36 | 9.78 ms | 0.49 ms | 78.41 ms | 95.66 ms |
| `regular` | 19 | 0.80 ms | 0.15 ms | 7.70 ms | 7.70 ms |

The current data disproves ClickHouse queue saturation as the cause of the
observed loading delays. It does not disprove ClickHouse execution or resource
pressure: direct query spans account for the anomaly latency, and provider
detail returned explicit total-memory-limit failures.

The window also contained worker errors while waiting for ClickHouse to
acknowledge metric-stream deletion events. Those background job failures were
not parents or siblings of the loading traces above, so they are recorded as
concurrent infrastructure evidence rather than attributed as the loading root
cause.

## Taxonomy and gates

| Slowdown class | Current status | Backend gate |
| --- | --- | --- |
| Client blanking existing data | Not observable from server telemetry in this run | Keep client behavior in its dedicated tested issues |
| Missing cache persistence | Not observable from server telemetry in this run | Keep client behavior in its dedicated tested issues |
| Broad invalidation | Not observable from server telemetry in this run | Keep client behavior in its dedicated tested issues |
| tRPC batching interference | Proven for the mobile anomaly batch | A follow-up may isolate the anomaly call after preserving error behavior |
| ClickHouse queue wait | Disproved for the observed slow traces | Do not tune queue limits from this evidence |
| Request-time query shape | Proven for anomaly detection; strongly implicated in provider metric-stream detail | Require named-query tests and ClickHouse query-log evidence before implementation |
| Readiness fan-out | `sync.dataHealth` was fast in this window | Do not optimize from this evidence |
| Freshness trust gap | Not measured | Keep in its dedicated client/server freshness issue |

## Before and after this evidence task

Before this run, backend performance work was blocked because even a minimal
Axiom query hit the limiter. After this run, Axiom access is working and the
evidence gate names two concrete query families while disproving general queue,
dashboard, and readiness optimization for the observed window. No production
behavior changed as part of this baseline.

