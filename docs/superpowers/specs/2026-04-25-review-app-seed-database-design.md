# Review App Seed Database Design

## Goal

Create a comprehensive deterministic seed database for review apps and local
development. The seed should optimize for reviewer UX coverage across web and
mobile surfaces, so `/auth/dev-login` opens an account with realistic data on
the screens reviewers are likely to inspect.

The seed is not intended to exercise every table in the schema. It should cover
the major product routes and include only the edge cases that make those routes
representative.

## Decisions

- Keep `pnpm seed` and `scripts/seed-dev-db.ts` as the single entry point.
- Use the same comprehensive seed for local development and review apps.
- Make generated data deterministic from a fixed pseudo-random seed.
- Anchor dates relative to the current local day so the dataset always looks
  recent while preserving repeatable patterns.
- Target a balanced runtime: under roughly 30 seconds on a normal development
  machine or review app host.
- Organize seed code by app surface rather than by table.

## Architecture

`scripts/seed-dev-db.ts` remains the orchestrator:

1. Validate `DATABASE_URL`.
2. Apply migrations only when the target schema is absent, preserving current
   seed behavior.
3. Clear seed-owned rows using fixed provider IDs, external IDs, and user IDs.
4. Create the baseline user and `dev-session`.
5. Run surface-oriented seed modules.
6. Refresh relevant materialized views.
7. Verify representative row counts and view outputs before reporting success.

Proposed module layout:

- `scripts/seed/helpers.ts`: deterministic pseudo-random generator, date and
  timestamp helpers, seed constants, and small shared insert helpers.
- `scripts/seed/core.ts`: baseline user, session, providers, provider
  priorities, user settings, and sync logs.
- `scripts/seed/recovery.ts`: sleep sessions, sleep stages, resting heart rate,
  heart rate variability, SpO2, skin temperature, and readiness inputs.
- `scripts/seed/training.ts`: activities, metric streams, intervals, endurance
  activity variety, and strength workout/set data.
- `scripts/seed/nutrition.ts`: daily nutrition, recent meal-level food entries,
  nutrients, and supplements.
- `scripts/seed/body-health.ts`: weight, body composition, goal weight, DEXA,
  labs, medications, conditions, allergies, and menstrual cycle data.
- `scripts/seed/review-surfaces.ts`: journal entries, life events, breathwork,
  report-friendly data, correlation-friendly behavior markers, and provider
  detail data not owned by `core.ts`.

The modules should share helpers but keep their own data generation close to
the surface they support. This makes it clear which reviewer experience each
seeded dataset exists to populate.

## Data Coverage

The first version should create one primary reviewer account with enough
connected-source history to make both web and mobile screens useful.

Dashboard and recovery:

- 180 days of daily metrics.
- 90 nights of sleep.
- Recent sleep stages.
- Heart rate variability, resting heart rate, SpO2, skin temperature, steps,
  active energy, and basal energy.

Training, strain, and activities:

- 120 days of activities across cycling, running, hiking or walking, strength,
  and rest days.
- Heart-rate streams for workouts.
- Power, cadence, speed, and altitude streams for activities where those charts
  need them.
- Intervals for a few hard workouts.
- Strength exercises and sets for strength pages.

Nutrition and food:

- 90 days of daily nutrition.
- Recent meal-level food entries.
- Macro and micronutrient rows for nutrition analytics.
- Supplements for supplement screens.

Body and health:

- 180 days of weight and body-composition measurements.
- Goal weight setting.
- DEXA scan data.
- Lab panels and results.
- Medication, condition, and allergy or intolerance rows.
- Menstrual cycle periods for cycle screens.

Providers and settings:

- Multiple connected providers with realistic provider priorities.
- Provider sync logs with successful and failed historical runs.
- Provider-detail records where current UI routes expect them.
- User settings required to make review screens render meaningful defaults.

Context and report surfaces:

- Journal entries.
- Life events.
- Breathwork sessions.
- Correlation-friendly behavior markers.
- Report-friendly data for health, weekly, and monthly views.

## Intentional Edge Cases

Include edge cases only when they make the app easier to review:

- Multi-provider sleep overlap that exercises sleep deduplication.
- Occasional missing days in body measurements and daily metrics.
- Rest days mixed into training history.
- A hard training block followed by a deload.
- One bad sleep week.
- One unusually high-stress day.
- Provider sync failures mixed with successful sync history.
- Incomplete provider streams for selected activities.

Do not seed every possible provider quirk or every table solely because it
exists.

## Data Guardrails

- Store raw rows with source attribution. Do not seed computed aggregates that
  should be derived by routers or materialized views.
- Use fixed IDs and external IDs for seed-owned data so reruns are idempotent.
- Use `null` for absent values, never empty strings.
- Avoid `Math.random()`; use a deterministic pseudo-random generator.
- Keep generated values plausible and layman-readable in downstream UI text.
- Keep providers isolated in the data model; do not introduce provider-specific
  fields into provider-agnostic tables.
- Refresh all relevant materialized views after inserts.
- Fail loudly if a core view cannot refresh or representative verification
  queries return no data.

## Testing

Update `src/db/seed-dev-db.integration.test.ts` to run the seed against a fresh
TimescaleDB container and assert the contract reviewers depend on:

- The baseline user and `dev-session` exist.
- Expected providers, priorities, settings, and sync logs exist.
- Major domains have enough rows: daily metrics, sleep sessions and stages,
  activities, metric streams, nutrition, food entries, body measurements, labs,
  journal entries, life events, breathwork, and cycle data.
- Key materialized views return data, including sleep, daily metrics, activity
  summary, and body measurement views.
- Rerunning the seed is idempotent for seed-owned records.
- Representative server-facing queries for web and mobile surfaces are
  non-empty.

The test should avoid exact row-by-row snapshots. Count ranges, required
examples, and representative query checks are the right level of specificity.

## Documentation

Update these docs when implementing the seed:

- `docs/review-apps.md`: note that review apps run the comprehensive
  deterministic seed and that `/auth/dev-login` opens the seeded reviewer
  account.
- `deploy/review-apps/README.md`: summarize the review-app seed behavior in the
  deployment lifecycle.
- `scripts/README.md`: document `pnpm seed`, its deterministic nature, expected
  runtime, and the surfaces it is intended to populate.

Human docs should describe the intent and review workflow, not enumerate every
synthetic row.

## Implementation Notes

- Representative API checks should be chosen from the routes used by the main
  web and mobile review surfaces: dashboard, recovery, strain or training,
  activities, sleep, nutrition, body, providers, settings, daily heart rate,
  correlation, supplements, cycle, breathwork, and reports.
- Seed-owned provider IDs should use a clear prefix or fixed allowlist so reruns
  delete only synthetic review data. Existing `whoop` and `apple_health` seed
  IDs may be kept if the implementation preserves current behavior.
- Core materialized views should fail the seed if they cannot refresh:
  `fitness.v_sleep`, `fitness.v_daily_metrics`, `fitness.v_body_measurement`,
  `fitness.v_activity`, `fitness.deduped_sensor`, and
  `fitness.activity_summary`.
