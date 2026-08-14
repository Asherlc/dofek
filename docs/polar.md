# Polar AccessLink

Polar's current AccessLink reference uses a mix of direct and user-scoped endpoints.

| Data | Endpoint | Response shape |
| --- | --- | --- |
| Exercises | `GET /v3/exercises` | `PolarExercise[]` |
| Sleep list | `GET /v3/users/sleep` | `{ nights: PolarSleep[] }` |
| Nightly Recharge list | `GET /v3/users/nightly-recharge` | `{ recharges: PolarNightlyRecharge[] }` |
| Daily activity list | `GET /v3/users/activities` | `PolarDailyActivity[]` |

Daily activity rows use `start_time` as the activity date source and `steps` for step count.
Do not use the non-user-scoped `/v3/sleep`, `/v3/nightly-recharge`, or `/v3/activity` paths.
