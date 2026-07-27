# Roadmap

Roadmap notes for planned Dofek improvements. Product-level outcomes live under "Near-Term Product Opportunities"; implementation-level backlog items live under "Technical Backlog".

## Near-Term Product Opportunities

### Getting Started Flow

Implemented first-run flow that helps a new user reach a useful dashboard quickly.

- Landing page Get started CTAs send users to login with `returnTo=/onboarding`; see [`LandingPage.tsx`](../packages/web/src/pages/LandingPage.tsx) and [`index.tsx`](../packages/web/src/routes/index.tsx).
- Web and mobile render shared setup steps from `@dofek/onboarding`; see [`get-started-flow.ts`](../packages/onboarding/src/get-started-flow.ts), [`OnboardingPage.tsx`](../packages/web/src/pages/OnboardingPage.tsx), and [`onboarding.tsx`](../packages/mobile/app/onboarding.tsx).
- Onboarding and settings persist a primary goal from shared options in `@dofek/onboarding/primary-goal`; see [`primary-goal.ts`](../packages/onboarding/src/primary-goal.ts), [`PrimaryGoalSelector.tsx`](../packages/web/src/components/PrimaryGoalSelector.tsx), and [`PrimaryGoalSelector.tsx`](../packages/mobile/components/PrimaryGoalSelector.tsx).
- Web onboarding includes the public iOS TestFlight invite so Apple Health and mobile setup are first-class; see [`OnboardingPage.tsx`](../packages/web/src/pages/OnboardingPage.tsx).
- Landing page copy frames correlations, trends, comparisons, Slack food logging, and cross-device source setup before signup; see [`LandingPage.tsx`](../packages/web/src/pages/LandingPage.tsx).

### Goals, Calendar, and Plan Compliance

Connect each daily decision to a longer-term outcome. First slice shipped: persist and edit primary goal. Deferred: event dates, planned/completed calendar merge, compliance explanations, recommendation adjustments, and plan import.

- [x] Persist the goal selected during onboarding and allow it to be changed; see [`2026-07-26-primary-goal-selection.md`](superpowers/plans/2026-07-26-primary-goal-selection.md).
- [ ] Support an event date or ongoing outcome target beyond the primary-goal taxonomy.
- [ ] Present planned and completed work in a shared web/mobile calendar.
- [ ] Explain plan deviations using recovery, availability, and completed-work evidence without moral judgment.
- [ ] Adjust future recommendations when the user accepts a change or repeatedly dismisses a type of action.
- [ ] Prefer importing existing structured plans and device calendars before building a broad custom plan-authoring system.

## Technical Backlog

Implementation-level backlog. Checked items are complete; unchecked are open.

### Data Ingestion
- [x] Apple Health XML parser (HR streams, HRV, sleep stages, workouts, body measurements, blood glucose, nutrition, walking stats, mindful sessions)
- [x] Apple Health HTTP upload with chunked transfer and progress indicator
- [x] Apple Health workout routes (GPS data from WorkoutRoute elements → metric_stream)
- [x] Clinical/lab data ingestion (Apple Health FHIR clinical records — 1,173 lab results)
- [x] Nutrition data ingestion (FatSecret provider — per-food-item granularity with full micro/macronutrients)
- [x] Supplement tracking (auto-supplements provider reads config, inserts daily; `category` enum distinguishes supplements from food)
- [x] Peloton direct provider (automated Auth0 login, workouts + performance metrics)
- [x] Wahoo provider (OAuth + FIT file parsing → GPS/power/HR/cadence/running dynamics)
- [x] WHOOP provider (sleep, recovery, workouts, 6s HR streams, journal entries via internal API)
- [x] WHOOP strength trainer sync (exercise-level sets/reps/weight from `weightlifting-service` internal API)
- [x] Withings provider (OAuth + sync for scale, BP, thermometer — awaiting credentials)
- [x] Cross-provider deduplication via read-time views and analytics read models (recursive CTE overlap clustering, per-field merge by provider priority)
- [x] Strong CSV import (strength training history — CSV upload with unit conversion)
- [x] RideWithGPS provider (trip sync with GPS track points, activity type mapping)
- [x] WHOOP raw IMU/accelerometer data investigation — **not feasible**: data is in a private S3 bucket with no download API; app only uploads, never reads back. Load-velocity profiles (derived from accelerometer) may be accessible once enough training data is collected. See `docs/whoop.md`.
- [x] Revisit IMU/vector storage if motion analysis becomes product-critical; raw IMU remains an ingest/archive path and the old Postgres `metric_stream` training export is retired. If motion analysis becomes a product surface, design a dedicated serving model with explicit axis order, coordinate frame, units, and calibration metadata rather than reviving ad-hoc vector reads. See [`inertial-measurement-unit-sync-repository.ts`](../packages/server/src/repositories/inertial-measurement-unit-sync-repository.ts) and [`packages/ml/README.md`](../packages/ml/README.md).
- [x] Normalize hydration storage so water is represented through one canonical path instead of both `nutrition_daily.water_ml` and nutrient-style water rows; water now lives in `food_entry_nutrient` as nutrient `water`, `v_nutrition_daily.water_ml` is a derived projection, and migration `0022_drop_dead_tables.sql` removes the old `nutrition_daily` storage table. See [`schema.dbml`](schema.dbml) and [`0022_drop_dead_tables.sql`](../drizzle/0022_drop_dead_tables.sql).

### Dashboard & Insights
- [x] Web dashboard (Vite + React + tRPC + ECharts + shadcn/ui)
- [x] Providers page with sync controls, health status, record counts, and log history
- [x] Life events timeline (annotate health data with arbitrary date markers, before/after analysis)
- [x] Insights engine (training volume, HR zone distribution, 80/20 polarization analysis)
- [x] Additional insight categories (ACWR, TRIMP, critical power curves, training monotony/strain, ramp rate, readiness score)
- [x] Continuous aggregates for long-range trends (daily + weekly caggs on metric_stream with auto-refresh policies)

### Infrastructure
- [x] Winston structured logging with ring buffer transport for UI system logs
- [x] OTel Collector sidecar shipping app logs + Docker container logs to Axiom
- [x] Infisical secrets management (migrated from SOPS + Age)
- [x] GHA CI with Docker build + push to GHCR
- [x] GitHub Actions deploys the Docker Swarm stack with shared app/ML image tags
- [x] CLI for authenticating, pulling, and managing providers (`sync`, `auth`, `import` commands)
- [x] Storybook previews per PR (R2-hosted web and mobile builds)

### Resilience
- [x] Health and readiness checks should prove services can do real work, not just that a process is alive. `web` exposes `/readyz` for Postgres, ClickHouse, and BullMQ queue readiness. The production worker serves its own loopback `/readyz` endpoint and verifies every existing BullMQ Worker's running state plus blocking/command Redis clients, avoiding a second Node runtime in the worker cgroup; see [`readiness.ts`](../packages/server/src/lib/readiness.ts), [`worker-readiness.ts`](../src/jobs/worker-readiness.ts), [`stack.yml`](../deploy/stack.yml), and the [BullMQ Worker API](https://api.docs.bullmq.io/classes/v5.Worker.html).
- [x] Auth bootstrap should distinguish `unauthenticated` from `bootstrap failed` on both web and mobile, and surface the real bootstrap error instead of silently treating failures as logout; see [`auth-context.tsx`](../packages/web/src/lib/auth-context.tsx), [`__root.tsx`](../packages/web/src/routes/__root.tsx), [`auth-context.tsx`](../packages/mobile/lib/auth-context.tsx), and [`_layout.tsx`](../packages/mobile/app/_layout.tsx).
- [x] Provider Sync All resilience is implemented and verification coverage is tracked: `sync.triggerSync` returns per-provider outcomes for started, cooldown-skipped, already-queued, and failed providers; web and mobile tests prove non-pollable outcomes do not poll fake jobs and pollable outcomes use provider-scoped job IDs. Queue visibility is provided by the admin `sync.queueBackpressure` route rather than `queueDepth` on `activeSyncs`; see [`sync.test.ts`](../packages/server/src/routers/sync.test.ts), [`DataSourcesPanel.test.tsx`](../packages/web/src/components/DataSourcesPanel.test.tsx), [`index.test.tsx`](../packages/mobile/app/providers/index.test.tsx), and [`2026-07-02-provider-sync-all-resilience-verification.md`](superpowers/plans/2026-07-02-provider-sync-all-resilience-verification.md).
- [x] ~~Convert `fitness.v_sleep` from a materialized view to a plain view once we can prove the recursive-CTE dedup query is fast enough on production-scale data.~~ Resolved differently (and more thoroughly) by `drizzle/0025_drop_v_sleep.sql`: both `fitness.v_sleep` and `clickhouse.v_sleep` materialized views were dropped. Sleep reads now come from the `analytics.v_sleep` dbt read model, eliminating refresh maintenance entirely. `fitness.v_activity` remains a plain view, so activity reads are fresh without refresh maintenance.

### Authentication Follow-ups
- [x] When a user signs up with any provider that does not give us an email, require them to enter their email manually before completing signup/account linking — implemented via `POST /auth/complete-signup`.
- [x] Email + password authentication: `fitness.user_password_credential` table (email + password hash), registration and login routes (`POST /auth/register`, `POST /auth/login/password`), login forms on web and mobile, account linking with existing OAuth users by email. Needed for ephemeral preview environments where OAuth callbacks don't work on preview subdomains. Password reset flow (the separately-tracked follow-up) is also done — Brevo SMTP, `POST /auth/password-reset/{request,confirm}`, `docs/app-password-auth.md`.
