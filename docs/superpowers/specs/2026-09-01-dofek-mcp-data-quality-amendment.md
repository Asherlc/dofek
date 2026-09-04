# MCP Data Quality Amendment: Read-Path Ownership

This amendment supersedes the overlapping portions of
`2026-09-01-dofek-mcp-data-quality-design.md` and its implementation plan.

## Assigned here

- Per-metric coverage and nullable response serialization for `get_health_trends`
  and `render_health_explorer` after the upstream sentinel repair lands.
- `get_activity_summary` response aggregation: `unclassified_pct`, `raw_type`
  passthrough, modality grouping, power coverage, and elevation aggregates.
- `get_body_metrics` daily-serving dedup/reconciliation migration and response.
- Explicit no-data health metric series, the trends diagnostics envelope, and
  `get_data_coverage()`.
- ACWR and body-composition source reconciliation.

## Explicitly not assigned here

Provider adapters, ingest jobs, raw payload extraction, timezone normalization,
WHOOP sport ID handling, multi-provider activity merge, power extraction,
`search_activities`, ingest validation, climbing/hangboard instrumentation, and
cycling stream-derived metrics remain with session 2. Do not final-validate
local-date aggregation until session 2 announces the timezone backfill complete.

## Sentinel handoff evidence

Production inspection on 2026-09-01 established that the named zeroes are
persisted in the ClickHouse recovery serving model, not represented as zero in
the sampled Postgres source rows:

| Local date | `analytics.daily_recovery` | Source row evidence |
| --- | --- | --- |
| 2026-08-21 | `hrv = 0` | Apple Health daily metric HRV = 63.167114 |
| 2026-08-23 | `hrv = 0` | Apple Health daily metric HRV = 53.07898 |
| 2026-08-30 | `hrv = 0` | no sampled source HRV value |
| 2026-08-13 | `efficiency_pct = 0` | WHOOP sleep efficiency = 96.9 |
| 2026-08-20 | `efficiency_pct = 0` | WHOOP sleep efficiency = 91.5 |
| 2026-08-28 | `efficiency_pct = 0` | WHOOP sleep efficiency = 94.3 |

Session 2 owns repair of `analytics.daily_recovery` construction or its upstream
write path. This session must retain null-only response serialization and add
coverage tests only after that repair is available.

## Updated activity-summary requirements

Do not build a mapping table against the current WHOOP-null `other` population.
Keep only a raw-string fallback after the session-2 WHOOP sport extraction and
multi-provider merge fixes land. Every aggregate that reports power must include
`power_coverage: { activities_with_power, activities_total, pct }`. Add
`modality` as an indoor/outdoor grouping dimension plus
`total_elevation_gain_m` and `avg_elevation_gain_m`.
