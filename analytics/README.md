# ClickHouse Analytics Models

This directory is a dbt project. Files under `analytics/models/` are not imported by
TypeScript directly; dbt discovers them by path and runs them as models.

The call sites are:

- `pnpm analytics:build` for local/manual runs.
- `entrypoint.sh` `migrate`, `sync`, `worker`, and `analytics` modes, which run `dbt build --project-dir analytics --profiles-dir analytics --threads 1 --select $DBT_SAFE_MODELS`.
- `entrypoint.sh` `analytics-worker` mode, which runs `dbt build --threads 1 --select $DBT_SAFE_MODELS` on an interval in production. Production sets the interval to 15 minutes and uses a bounded retry delay after failures so a transient ClickHouse outage does not turn into an immediate dbt restart loop.

Model dependencies are declared with dbt `ref()` calls. `sensor_scalar_sample`
stages scalar metric samples, `deduped_sensor` reads `sensor_scalar_sample`, and
`activity_vo2max_estimate` reads `deduped_sensor` to keep the expensive VO2 max
activity/sample joins out of web/API requests. `deduped_activities` materializes
the activity overlap graph once, and `deduped_activity_members` exposes canonical
activity/member aliases for downstream models. `sleep_heart_rate_sample`,
`activity_sensor_sample`, and `activity_location_sample` are bounded microbatch
intermediates over sample time. `resting_heart_rate_sleep_window` aggregates the
sleep sample intermediary, while `activity_sensor_summary_rows` and
`activity_location_summary_rows` aggregate the activity sample intermediaries
before `activity_summary_rows` joins those compact per-activity summaries.
The serving-facing `analytics.activity_summary` object is a thin ClickHouse view
over `analytics.activity_summary_rows FINAL`; the expensive activity/sample
joins belong in incremental dbt models, not in web/API requests. Complex
offline ClickHouse models can set dbt `query_settings` locally and use
`max_threads=1` so offline builds do not compete with request traffic.

Production `DBT_SAFE_MODELS` currently selects `sensor_scalar_sample`,
`deduped_sensor`, `deduped_activities`, `deduped_activity_members`,
`sleep_heart_rate_sample`, `resting_heart_rate_sleep_window`,
`activity_sensor_sample`, `activity_location_sample`,
`activity_sensor_summary_rows`, `activity_location_summary_rows`,
`activity_summary_rows`, and `activity_vo2max_estimate`. The sample-stage and
sample-intermediate models use dbt's `microbatch` incremental strategy with
`recorded_at` as the event time, daily batches, and short lookbacks so
ClickHouse processes bounded sample-time windows instead of one large
activity/window query. `deduped_activities` and `deduped_activity_members`
materialize canonical activity identity once, but incremental runs only rebuild
activity windows affected by new raw activity changes; provider/device priority
changes intentionally rebuild the full activity dedupe graph because they can
change canonical selection globally. The final resting heart rate, activity
aggregate, and activity summary models use dirty keys from those intermediates
and `max_threads=1` to keep the offline aggregate work out of web/API requests.
`activity_vo2max_estimate` also uses dirty activity/user keys and
`max_threads=1`; it materializes reusable per-activity VO2 max estimates, not
final API responses.
