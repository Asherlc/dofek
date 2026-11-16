# WHOOP Skin Temperature — Operator Evidence

Captured 2026-11-15. Sanitized operator observations; not a new production audit.

## Scope

This note covers only the five temperature layers and the bounded local cost probe. It contains no account, device, batch, or health-value identifiers.

## Observations

### Publication

At `2026-11-15T15:45:03.487Z` the Redpanda upload boundary event `upload_published` on stream `sensorRecords` recorded accepted 16 / published 16 / filtered 0. This establishes publication only, not decoding or chart display. Source: [`packages/server/src/routers/whoop-ble-sync.ts`](../packages/server/src/routers/whoop-ble-sync.ts).

### Decoded

Provider `whoop_ble`, sample_count 311290, earliest `2026-11-01 01:40:54.470000`, latest `2026-11-15 15:30:35.460000`. Aggregate only; no individual values or identifiers.

### Cloud

Nonnull daily temperatures were observed through Nov 15. No individual values, device/batch IDs, or invented exact original SQL.

### API

30 returned days, 29 with temperature, latest date 2026-11-15. The served/cached response is identified separately from storage. Source: [`packages/server/src/routers/daily-metrics.ts`](../packages/server/src/routers/daily-metrics.ts).

### UI

Existing signed-in Firefox Body chart rendered after query completion. Recovery originally omitted skin temperature; the mobile card exists but its physical runtime was not inspected.

None of these alone proves end-to-end delivery of a particular device batch.

## Reproduction query

The original exact operator command was not preserved. The parameterized aggregate recipe below reproduces the decoded row. Bind `userId` in the operator's normal ClickHouse client; the result remains aggregate-only.

```sql
SELECT h.provider_id, count() AS sample_count,
       min(sample.measured_at) AS earliest,
       max(sample.measured_at) AS latest
FROM analytics.daily_health_sensor AS h FINAL
ARRAY JOIN h.samples AS sample
WHERE h.user_id = {userId:UUID}
  AND h.provider_id = 'whoop_ble'
  AND sample.channel = 'skin_temperature'
GROUP BY h.provider_id;
```

It returns one row: provider, sample count, and the earliest/latest measurement times.

## Bounded local cost result

Actual ClickHouse 26.6.1.1193 production query functions, three sequential trials per path at 0 / 1000 / 10000 off-window synthetic samples, with eligible March measurements received in October unchanged.

- Discovery bytes 385 → 79484 → 860573; selected stream 361 → 79460 → 860549.
- No-source 183 and HR-only 399 stayed fixed.
- Complete QueryFinish medians at 10000: 35 ms discovery / 53 ms selected; peak memory about 148 / 149 MB.
- History-dependent I/O confirmed; no material latency/memory bottleneck shown at this scale. Not production p95/concurrency/full-history qualification, and no production selected-path trace is asserted because the feature was not deployed.
- No optimization, model, schema, or cutoff follows.

## Historical absence and implemented behavior

- Historical absence: the pre-change Recovery route at revision `d049f86a` ([source](https://github.com/Asherlc/dofek/blob/d049f86a57461e6e15e72b9f0707e26b4a085a82/packages/web/src/routes/training/recovery.tsx)) contains no skin temperature request or render.
- Implemented behavior: the current route [`packages/web/src/routes/training/recovery.tsx`](../packages/web/src/routes/training/recovery.tsx) queries and charts daily values.

## Supporting repository links

- Decoded model and sample reader: [`analytics/models/read_models/daily_health_sensor.sql`](../analytics/models/read_models/daily_health_sensor.sql)
- Typed sample reads: [`packages/server/src/repositories/health-sensor-query.ts`](../packages/server/src/repositories/health-sensor-query.ts)
- Raw daily schema/API: [`src/db/schema/activity.ts`](../src/db/schema/activity.ts) (`fitness.daily_metrics.skin_temp_c`)
- Runbooks: [`docs/performance/loading-performance-runbook.md`](performance/loading-performance-runbook.md), [`docs/axiom-observability-runbook.md`](axiom-observability-runbook.md)

Narrow evidenced cause: the web Recovery route never requested or rendered skin temperature; the activity source/stream contract omitted it. Missing ingestion was not established.
