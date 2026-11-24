# Roadmap

Roadmap notes for planned Dofek improvements. Product-level outcomes live under "Product Strategy"; implementation-level backlog items live under "Technical Backlog".

## Product Strategy

Dofek brings together training, health, sleep, recovery, nutrition, and body
data from connected sources. The current product priority is to put users’
existing training plans and completed workouts together on web and iOS.

### Now: Trust and Measurement Release Gate

Resolve public-facing trust problems and add product measurement before launching the next flagship feature.

- [x] Remove provider-estimated workout calories and active-energy values from marketing, Storybook fixtures, review data, screenshots, and other user-visible examples. Nutrition intake and expenditure inferred from observed body-weight change remain valid product concepts. See [`2026-07-26-remove-expenditure-examples.md`](superpowers/plans/2026-07-26-remove-expenditure-examples.md).
- [ ] Regenerate the iOS App Store screenshots with internally consistent seeded data, correct layout coverage, and no blank or mostly-black assets; see [`app-store/screenshots`](../packages/mobile/app-store/screenshots).
- [ ] Audit statistical fixtures so sample size, coefficients, significance, confidence language, and charts agree. Insufficient datasets must not imply that a relationship was measured; see [`2026-07-20-correlation-insufficient-statistics.md`](superpowers/plans/2026-07-20-correlation-insufficient-statistics.md).
- [ ] Show the actual subscription price, billing period, trial or limited-access behavior, and cancellation terms on the landing page before signup; see [`LandingPage.tsx`](../packages/web/src/pages/LandingPage.tsx).
- [ ] Update product documentation when implemented capabilities make known-gap statements stale, including medication-dose tracking.
- [ ] Make the reproducible iOS runtime-audit prerequisite explicit: either generate the ignored Xcode workspace before an audit or document the canonical command that creates it.
- [ ] Add equivalent web and mobile product events for onboarding completion, source connection, first useful insight, experiment engagement, subscription conversion, and relevant failure states. Web page views alone are not sufficient product measurement; see [`posthog.ts`](../packages/web/src/lib/posthog.ts).
- [ ] Establish an automated web/mobile product-surface parity review for every user-facing feature. Platform-specific hardware and administrative features may differ intentionally, but user outcomes should remain equivalent.
- [ ] Publish and maintain a product-surface matrix covering route discoverability, web/mobile parity, fixture coverage, and release evidence.
- [x] Retire weekly/monthly reports and report sharing across web, mobile, and server, including stored snapshots; see [migration 0143](../drizzle/0143_remove_shared_reports.sql).
- [ ] Resolve or intentionally retire low-discoverability product surfaces, including predictions and insights that exist but are absent from primary navigation.
- [ ] Prioritize mobile parity for body and goal-weight context and user-facing prediction or sport-detail outcomes. Hardware capture may remain mobile-only; administrative MCP may remain web-only.

This gate is complete when the acquisition surfaces make no contradictory or prohibited claims, a seeded review account can be audited on both platforms, and the team can measure activation and retention without relying only on page views.

### Next: Calendar and Plan Compliance

- [ ] Show planned and completed workouts together in Activities on web and iOS
  using the existing date range control. Keep imported plans read-only and show
  their source.
- [ ] Verify the Intervals.icu workout rollout with an approved OAuth app and
  populated calendar reads authorized with `CALENDAR:READ`. Confirm fields,
  units, local dates, and when an event can be treated as removed.
  [Rollout checklist](intervals-icu.md#calendar-dates-and-rollout).
- [ ] Add Intervals.icu A/B/C races after verifying priority, dates, and any
  race goal fields in an authorized response.
- [ ] Show weekly time, distance, and training-load targets once an authorized
  response establishes the period and units for each target.
  [Shared provider goals design](superpowers/specs/2026-11-21-provider-goals-and-calendar-design.md).
- [ ] Explain plan deviations using recovery, availability, and completed-work evidence without moral judgment.
- [ ] Adjust future recommendations when the user accepts a change or repeatedly dismisses a type of action.
- [ ] Import existing structured plans and device calendars before building a broad plan authoring system.

### Product Success Measures

Instrument and review these measures before expanding the roadmap:

- **Activation** tracks whether users connect a source and reach a useful view with their own data.
- **Time to value** measures elapsed time from account creation to the first useful view with the user’s own data.
- **Retention:** day 7, day 30, and rolling four-week retention segmented by activation and use of Activities.
- **Conversion:** subscription conversion segmented by source count, goal, first insight, and use of Activities.
- **Trust:** source-remediation success, report corrections, and support contacts about incorrect metrics.

### Explicitly Not Now

- More provider integrations without user-demand, retention, or revenue evidence.
- A generic AI health-chat surface without a deterministic evidence and recommendation contract.
- Additional composite scores or standalone dashboards that do not change a user decision.
- A Strava-style social feed, segment network, or broad challenge platform. Strava already provides routes, goals, segments, challenges, and community features; see [Strava Features](https://www.strava.com/features).
- A broad clinical-record or diagnosis platform.
- Heavy gamification tied to training load, exercise volume, weight, nutrition restriction, calorie expenditure, or recovery scores.
- Duplicate implementations of analytics or health-data calculations in clients.

## Completed Product Foundations

### Getting Started Flow

Implemented first-run flow that helps a new user reach a useful dashboard quickly.

- Landing page Get started CTAs send users to login with `returnTo=/onboarding`; see [`LandingPage.tsx`](../packages/web/src/pages/LandingPage.tsx) and [`index.tsx`](../packages/web/src/routes/index.tsx).
- Web and mobile render shared setup steps from `@dofek/onboarding`; see [`get-started-flow.ts`](../packages/onboarding/src/get-started-flow.ts), [`OnboardingPage.tsx`](../packages/web/src/pages/OnboardingPage.tsx), and [`onboarding.tsx`](../packages/mobile/app/onboarding.tsx).
- Web onboarding includes the public iOS TestFlight invite so Apple Health and mobile setup are first-class; see [`OnboardingPage.tsx`](../packages/web/src/pages/OnboardingPage.tsx).
- Landing page copy frames correlations, trends, comparisons, and cross-device source setup before signup; see [`LandingPage.tsx`](../packages/web/src/pages/LandingPage.tsx).

## Technical Backlog

Implementation-level backlog. Checked items are complete; unchecked are open.

### Data Ingestion
- [x] Ingest raw Apple Health menstrual-flow records, including the upstream cycle-start marker,
  source attribution, background HealthKit delivery, and XML import
  ([HealthKit menstrual flow](https://developer.apple.com/documentation/healthkit/hkcategorytypeidentifier/menstrualflow)).
- [ ] Add Garmin Women's Health only after confirming the application's Women's Health
  authorization and official payload contract. The approved Health/Activity integration does
  not establish that scope; see the [Garmin guide](garmin.md). Use verified official endpoints
  ([Garmin Women's Health API](https://developer.garmin.com/gc-developer-program/womens-health-api/),
  [program FAQ](https://developer.garmin.com/gc-developer-program/program-faq/)).
- [ ] Add Android Health Connect menstrual records if an Android client is introduced
  ([MenstruationPeriodRecord](https://developer.android.com/reference/androidx/health/connect/client/records/MenstruationPeriodRecord)).
- [x] Record WHOOP, Oura, Fitbit, Polar, Withings, and Google Health as unsupported explicit
  menstrual-record sources under their current public APIs; see
  [`provider-api-audit.md`](provider-api-audit.md#unsupported-public-menstrual-record-sources).
- [x] Apple Health XML parser (HR streams, HRV, sleep stages, workouts, body measurements, blood glucose, nutrition, walking stats, mindful sessions)
- [x] Apple Health HTTP upload with chunked transfer and progress indicator
- [x] Apple Health workout routes (GPS data from WorkoutRoute elements → metric_stream)
- [x] Clinical/lab data ingestion (Apple Health FHIR clinical records — 1,173 lab results)
- [x] Nutrition data ingestion (FatSecret provider — per-food-item granularity with full micro/macronutrients)
- [x] Removed supplement tracking, including schedules and dose history
  ([migration 0141](../drizzle/0141_remove_supplements.sql)).
- [x] Peloton direct provider (automated Auth0 login, workouts + performance metrics)
- [x] Wahoo provider (OAuth + FIT file parsing → GPS/power/HR/cadence/running dynamics)
- [x] WHOOP provider (sleep, recovery, workouts, 6s HR streams via internal API)
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
- [ ] Future: evaluate/complete a full Cloudflare R2 → Backblaze B2 migration for cost savings (goal only — no guaranteed cost outcome; see [Backblaze B2 Cloud Storage pricing](https://www.backblaze.com/cloud-storage/pricing)). **Deferred**; the Pulsar/B2 offload proposal in [#3231](https://github.com/Asherlc/dofek/pull/3231) is superseded. The current [Kafka architecture](../README.md#architecture) retains R2 storage. Before moving R2 data: resolve conditional archive writes, immutable erasure-ledger semantics, and all-version deletion/retention, then verified copy/cutover. Evidence: [`r2-to-b2-b2-erasure-probe.md`](r2-to-b2-b2-erasure-probe.md), [`r2-to-b2-erasure-design.md`](r2-to-b2-erasure-design.md).

### Resilience
- [x] Explain source conflicts and the priority or deduplication decision that resolved them. ([#2058](https://github.com/Asherlc/dofek/issues/2058))
- [ ] Notify users when a required source becomes stale or disconnected and provide direct remediation.
- [x] Health and readiness checks should prove services can do real work, not just that a process is alive. `web` exposes `/readyz` for Postgres, ClickHouse, and BullMQ queue readiness. The production worker serves its own loopback `/readyz` endpoint and verifies every existing BullMQ Worker's running state plus blocking/command Redis clients, avoiding a second Node runtime in the worker cgroup; see [`readiness.ts`](../packages/server/src/lib/readiness.ts), [`worker-readiness.ts`](../src/jobs/worker-readiness.ts), [`docker-compose.yml`](../deploy/docker-compose.yml), and the [BullMQ Worker API](https://api.docs.bullmq.io/classes/v5.Worker.html).
- [x] Auth bootstrap should distinguish `unauthenticated` from `bootstrap failed` on both web and mobile, and surface the real bootstrap error instead of silently treating failures as logout; see [`auth-context.tsx`](../packages/web/src/lib/auth-context.tsx), [`__root.tsx`](../packages/web/src/routes/__root.tsx), [`auth-context.tsx`](../packages/mobile/lib/auth-context.tsx), and [`_layout.tsx`](../packages/mobile/app/_layout.tsx).
- [x] Provider Sync All resilience is implemented and verification coverage is tracked: `sync.triggerSync` returns per-provider outcomes for started, cooldown-skipped, already-queued, and failed providers; web and mobile tests prove non-pollable outcomes do not poll fake jobs and pollable outcomes use provider-scoped job IDs. Queue visibility is provided by the admin `sync.queueBackpressure` route rather than `queueDepth` on `activeSyncs`; see [`sync.test.ts`](../packages/server/src/routers/sync.test.ts), [`DataSourcesPanel.test.tsx`](../packages/web/src/components/DataSourcesPanel.test.tsx), [`index.test.tsx`](../packages/mobile/app/providers/index.test.tsx), and [`2026-07-02-provider-sync-all-resilience-verification.md`](superpowers/plans/2026-07-02-provider-sync-all-resilience-verification.md).
- [x] ~~Convert `fitness.v_sleep` from a materialized view to a plain view once we can prove the recursive-CTE dedup query is fast enough on production-scale data.~~ Resolved differently (and more thoroughly) by `drizzle/0025_drop_v_sleep.sql`: both `fitness.v_sleep` and `clickhouse.v_sleep` materialized views were dropped. Sleep reads now come from the `analytics.v_sleep` dbt read model, eliminating refresh maintenance entirely. `fitness.v_activity` remains a plain view, so activity reads are fresh without refresh maintenance.

### Authentication Follow-ups
- [x] When a user signs up with any provider that does not give us an email, require them to enter their email manually before completing signup/account linking — implemented via `POST /auth/complete-signup`.
- [x] Email + password authentication: `fitness.user_password_credential` table (email + password hash), registration and login routes (`POST /auth/register`, `POST /auth/login/password`), login forms on web and mobile, account linking with existing OAuth users by email. Needed for ephemeral preview environments where OAuth callbacks don't work on preview subdomains. Password reset flow (the separately-tracked follow-up) is also done — Brevo SMTP, `POST /auth/password-reset/{request,confirm}`, `docs/app-password-auth.md`.
