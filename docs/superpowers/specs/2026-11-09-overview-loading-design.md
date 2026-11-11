# Overview sensor loading

The overview must load health metrics and insights without scanning the raw sensor
event log. Production evidence on November 9 shows `dailyMetrics.trends` taking
116,327 ms and `insights.compute` failing after 120,094 ms. ClickHouse query
`cbef7b6d-87c9-48bb-afd6-1531e03a5ce2` read 200,531,166 rows before ending with
`NETWORK_ERROR` after 195,521 ms; query `84dea529-efae-475d-a742-b4ee61dfed16`
read 139,391,002 rows in 115,838 ms. Both include raw oxygen/temperature reads.

The user approved incremental daily models in the existing dbt pipeline.
A query-only optimization would retain repeated decoding and raw-log scans;
a new service or cache would duplicate existing infrastructure. Use one dbt
model, `daily_health_sensor`, with compact decoded samples grouped by source
receipt day. Reuse the existing source-day change markers and bounded dirty-day
pattern. This follows the [loading runbook](../../performance/loading-performance-runbook.md)
and [dbt incremental models](https://docs.getdbt.com/docs/build/incremental-models).

Daily scalar averages alone cannot preserve arbitrary caller timezones or delayed
WHOOP measurement dates. Retain typed measurement timestamps and values in the
daily rows, normalize oxygen units and decode WHOOP frames in dbt, and retain
the existing small daily grouping and source-priority selection in the shared API.
No client contract changes, additional dependency, service, cache, timeout,
retry, or fallback is needed. Both clients use the shared API.

Validation must execute the model and serving queries against ClickHouse,
covering corrections, deletions, replay duplicates, malformed frames, foreign
users, local-day boundaries, source priority and delayed offloads. Initialize
existing history with bounded dbt runs before considering production recovered;
schema migrations must not perform that historical backfill.
