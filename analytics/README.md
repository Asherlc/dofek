# ClickHouse Analytics Models

This directory is a dbt project. Files under `analytics/models/` are not imported by
TypeScript directly; dbt discovers them by path and runs them as models.

The call sites are:

- `pnpm analytics:build` for local/manual runs.
- `entrypoint.sh` `migrate`, `sync`, and `worker` modes, which run `dbt build --project-dir analytics --profiles-dir analytics`.
- `entrypoint.sh` `analytics-worker` mode, which runs `dbt build --select sensor_scalar_sample deduped_sensor resting_heart_rate_sleep_window` on an interval in production. Production sets the interval to 15 minutes and uses a bounded retry delay after failures so a transient ClickHouse outage does not turn into an immediate dbt restart loop.

Model dependencies are declared with dbt `ref()` calls. `sensor_scalar_sample` stages scalar
metric samples, `deduped_sensor` reads `sensor_scalar_sample`, and
`resting_heart_rate_sleep_window` reads `deduped_sensor`.
