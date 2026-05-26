# ClickHouse Analytics Models

This directory is a dbt project. Files under `analytics/models/` are not imported by
TypeScript directly; dbt discovers them by path and runs them as models.

The call sites are:

- `pnpm analytics:build` for local/manual runs.
- `entrypoint.sh` `migrate`, `sync`, `worker`, and `analytics` modes, which run `dbt build --project-dir analytics --profiles-dir analytics --threads 1`.
- `entrypoint.sh` `analytics-worker` mode, which runs `dbt build --threads 1 --select sensor_scalar_sample deduped_sensor activity_summary_rows resting_heart_rate_sleep_window` on an interval in production. Production sets the interval to 15 minutes and uses a bounded retry delay after failures so a transient ClickHouse outage does not turn into an immediate dbt restart loop.

Model dependencies are declared with dbt `ref()` calls. `sensor_scalar_sample` stages scalar
metric samples, `deduped_sensor` reads `sensor_scalar_sample`, and
`activity_summary_rows` and `resting_heart_rate_sleep_window` read `deduped_sensor`.
The serving-facing `analytics.activity_summary` object is a thin ClickHouse view
over `analytics.activity_summary_rows FINAL`; the expensive activity/sample
joins belong in the incremental dbt model, not in web/API requests. Complex
offline ClickHouse models can set dbt `query_settings` locally;
`activity_summary_rows` raises `query_plan_max_optimizations_to_apply` for its
large insert plan and uses `max_threads=1` so the offline build does not compete
with request traffic.
