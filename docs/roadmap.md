# Roadmap

Roadmap notes for planned Dofek improvements. Product-level outcomes live under "Near-Term Product Opportunities"; implementation-level backlog items live under "Technical Backlog".

## Near-Term Product Opportunities

### Getting Started Flow

Create a polished first-run flow that helps a new user reach a useful dashboard quickly.

- Explain what Dofek can help them see: correlations, trends, and comparisons across their health data.
- Guide them through connecting supported sources without exposing implementation mechanics.
- Include iOS app setup as a first-class path for Apple Health and mobile tracking.
- Call out Slack food logging as an easy way to start capturing nutrition context.
- Show a short progress path from "connect sources" to "first useful insight" so the app feels directed before enough data exists for deeper analysis.

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
- [ ] Revisit IMU/vector storage if motion analysis becomes product-critical; `metric_stream.vector` currently relies on channel-level conventions for axis order, coordinate frame, units, and calibration semantics.
- [ ] Normalize hydration storage so water is represented through one canonical path instead of both `nutrition_daily.water_ml` and nutrient-style water rows.

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
- [x] Health and readiness checks should prove services can do real work, not just that a process is alive. `web` now exposes `/readyz` for Postgres, ClickHouse, and BullMQ queue readiness, and the production `worker` healthcheck now verifies BullMQ queue access instead of only checking for a process name.
- [x] Auth bootstrap should distinguish `unauthenticated` from `bootstrap failed` on both web and mobile, and surface the real bootstrap error instead of silently treating failures as logout.
- [x] ~~Convert `fitness.v_sleep` from a materialized view to a plain view once we can prove the recursive-CTE dedup query is fast enough on production-scale data.~~ Resolved differently (and more thoroughly) by `drizzle/0025_drop_v_sleep.sql`: both `fitness.v_sleep` and `clickhouse.v_sleep` materialized views were dropped. Sleep reads now come from the `analytics.v_sleep` dbt read model, eliminating refresh maintenance entirely. `fitness.v_activity` remains a plain view, so activity reads are fresh without refresh maintenance.

### Authentication Follow-ups
- [x] When a user signs up with any provider that does not give us an email, require them to enter their email manually before completing signup/account linking — implemented via `POST /auth/complete-signup`.
- [x] Email + password authentication: `fitness.user_password_credential` table (email + password hash), registration and login routes (`POST /auth/register`, `POST /auth/login/password`), login forms on web and mobile, account linking with existing OAuth users by email. Needed for ephemeral preview environments where OAuth callbacks don't work on preview subdomains. Password reset flow (the separately-tracked follow-up) is also done — Brevo SMTP, `POST /auth/password-reset/{request,confirm}`, `docs/app-password-auth.md`.
