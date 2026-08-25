# Roadmap

Roadmap notes for planned Dofek improvements. Product-level outcomes live under "Product Strategy"; implementation-level backlog items live under "Technical Backlog".

## Product Strategy

Dofek already has broad provider coverage and deep health, recovery, training, nutrition, body, and behavior analytics. The next product phase should turn that data into a trustworthy daily decision and a measurable feedback loop.

The primary product loop should be:

1. Connect enough data to establish a trustworthy personal baseline.
2. Receive one evidence-backed action for today.
3. Accept, modify, or dismiss the action.
4. Record the outcome with minimal effort.
5. Learn which actions help over time.

New work should strengthen this loop. More providers, scores, charts, and standalone dashboards are not priorities unless user evidence shows that they are required to complete it.

### Now: Trust and Measurement Release Gate

Resolve public-facing trust problems and add product measurement before launching the next flagship feature.

- [x] Remove provider-estimated workout calories and active-energy values from marketing, Storybook fixtures, review data, screenshots, and other user-visible examples. Nutrition intake and expenditure inferred from observed body-weight change remain valid product concepts. See [`2026-07-26-remove-expenditure-examples.md`](superpowers/plans/2026-07-26-remove-expenditure-examples.md).
- [ ] Regenerate the iOS App Store screenshots with internally consistent seeded data, correct layout coverage, and no blank or mostly-black assets; see [`app-store/screenshots`](../packages/mobile/app-store/screenshots).
- [ ] Audit statistical fixtures so sample size, coefficients, significance, confidence language, and charts agree. Insufficient datasets must not imply that a relationship was measured; see [`2026-07-20-correlation-insufficient-statistics.md`](superpowers/plans/2026-07-20-correlation-insufficient-statistics.md).
- [ ] Show the actual subscription price, billing period, trial or limited-access behavior, and cancellation terms on the landing page before signup; see [`LandingPage.tsx`](../packages/web/src/pages/LandingPage.tsx).
- [ ] Update product documentation when implemented capabilities make known-gap statements stale, including medication-dose tracking.
- [ ] Make the reproducible iOS runtime-audit prerequisite explicit: either generate the ignored Xcode workspace before an audit or document the canonical command that creates it.
- [ ] Add equivalent web and mobile product events for onboarding completion, source connection, first useful insight, Daily Brief engagement, journal or experiment engagement, subscription conversion, and relevant failure states. Web page views alone are not sufficient product measurement; see [`posthog.ts`](../packages/web/src/lib/posthog.ts).
- [ ] Establish an automated web/mobile product-surface parity review for every user-facing feature. Platform-specific hardware and administrative features may differ intentionally, but user outcomes should remain equivalent.
- [ ] Publish and maintain a product-surface matrix covering route discoverability, web/mobile parity, fixture coverage, and release evidence.
- [ ] Resolve or intentionally retire low-discoverability product surfaces, including behavior impact, reports, predictions, and insights that exist but are absent from primary navigation.
- [ ] Prioritize mobile parity for journal and life events, body and goal-weight context, behavior impact, and user-facing prediction or sport-detail outcomes. Hardware capture may remain mobile-only; administrative MCP may remain web-only.

This gate is complete when the acquisition surfaces make no contradictory or prohibited claims, a seeded review account can be audited on both platforms, and the team can measure activation and retention without relying only on page views.

### Next: Daily Brief and Today Plan

Make one personalized, trustworthy action the center of the web and mobile home experiences.

- [ ] Generate one primary action from server-owned metric and recommendation logic. The client renders the decision and must not independently calculate its health meaning.
- [ ] Tie the action to the goal selected during onboarding and the user's current recovery, sleep, training, nutrition, health, schedule, and data-availability context.
- [ ] Explain the recommendation with two or three concise supporting facts.
- [ ] Show the contributing sources, freshness, missing-data caveats, and confidence.
- [ ] Let the user accept, modify, or dismiss the action and optionally state why.
- [ ] Add a lightweight end-of-day outcome check-in.
- [ ] Include equivalent web and mobile behavior from the first release.
- [ ] Start with deterministic, testable recommendation rules. Conversational AI may explain established recommendations later but must not be the unverified source of health decisions.
- [ ] Avoid medical diagnosis and prescriptive treatment. Surface specific, actionable errors when required data is unavailable.

The category increasingly centers the home experience on timely guidance rather than passive dashboards: [Oura Today](https://support.ouraring.com/hc/en-us/articles/360058599753-How-to-Use-the-Oura-App), [Garmin Training Readiness](https://www.garmin.com/en-US/garmin-technology/running-science/physiological-measurements/training-readiness/), [WHOOP Coach](https://www.whoop.com/us/en/thelocker/whoop-unveils-the-new-whoop-coach-powered-by-openai/), [Athlytic](https://athlyticapp.com/), and [Bevel](https://help.bevel.health/en/articles/11194113). Dofek should differentiate through provider-agnostic inputs, transparent evidence, and user control rather than a generic chat interface.

This outcome is successful when a newly activated user can receive a credible action within 24 hours of connecting sufficient data, and returning users regularly engage with or intentionally dismiss the Brief.

### Next: Personal Experiments

Turn correlations, journal entries, life events, medication-dose events, and behavior impact into guided N-of-1 experiments.

- [x] Let a user choose a question or hypothesis, outcome, intervention, and practical experiment duration. *(setup & schedule slice; see [`personal-experiments.md`](./personal-experiments.md))*
- [x] Record raw adherence and obvious confounders once per experiment day; outcome observations remain canonical server-derived data. *(learning-loop slice; see [`personal-experiments.md`](./personal-experiments.md))*
- [x] Support relevant time lags instead of assuming only same-day effects. *(setup stores lag; analysis deferred)*
- [x] Report descriptive effect direction and magnitude, sample size, uncertainty, missing data, and limitations without claiming causality. *(learning-loop slice; see [`personal-experiments.md`](./personal-experiments.md))*
- [ ] Recommend extending or stopping an experiment when evidence is insufficient rather than manufacturing a conclusion. *(manual stop shipped; evidence-based recommend deferred)*
- [ ] Make general journal and life-event capture available on mobile so context can be recorded when it happens. Experiment-linked life-event annotations are available from the mobile experiment screen.
- [ ] Feed completed experiments into future Daily Brief recommendations only when the evidence contract permits it.

[Exist](https://exist.io/) combines automatic data, manual tracking, goals, experiments, correlations, and weekly summaries, and documents that it requires several weeks of data before producing correlations in its [correlation FAQ](https://exist.io/page/faqs/). [Bearable's Factor Effect Report](https://bearable.app/support/howto/the-factor-effect-report/) connects behaviors and interventions to symptoms, mood, and sleep. Dofek can build a stronger version by using its broader provider data and explicit provenance.

### Next: Goals, Calendar, and Plan Compliance

Connect each daily decision to a longer-term outcome.

- [ ] Persist the goal selected during onboarding and allow it to be changed.
- [ ] Support an event date or ongoing outcome target such as race preparation, sleep consistency, strength progression, or weight trend.
- [ ] Present planned and completed work in a shared web/mobile calendar.
- [ ] Explain plan deviations using recovery, availability, and completed-work evidence without moral judgment.
- [ ] Adjust future recommendations when the user accepts a change or repeatedly dismisses a type of action.
- [ ] Prefer importing existing structured plans and device calendars before building a broad custom plan-authoring system.

[TrainingPeaks](https://www.trainingpeaks.com/) demonstrates the complete plan-calendar-device-compliance loop, including structured plans and workouts that sync to compatible devices in its [training-plan catalog](https://www.trainingpeaks.com/training-plans/). Dofek's opportunity is to combine that planning loop with cross-provider recovery, nutrition, and behavior evidence.

### Later: Native Retention Surfaces

Distribute the Daily Brief after the core recommendation loop proves useful.

- [ ] Add an optional morning Daily Brief notification.
- [ ] Add iOS home-screen and lock-screen widgets for the day's action, its status, and critical data freshness.
- [ ] Add a Watch glance for the accepted action and relevant target.
- [ ] Notify users when a required source becomes stale or disconnected and provide direct remediation.
- [x] Support optional medication reminders with clear logging state.
- [ ] If a streak is tested, tie it to a low-pressure action such as reviewing the Brief or recording a check-in. Never reward exercise volume, weight change, calorie restriction, or a “perfect” recovery score.

Duolingo's product research found that reducing the minimum daily commitment improved retention in its [streak experiments](https://blog.duolingo.com/improving-the-streak/). Its [widget design](https://blog.duolingo.com/widget-feature/) focuses on reminding the user of one meaningful action. Dofek should apply the habit principle without importing unsafe health gamification.

### Later: Health Story, Reports, and Controlled Sharing

Make long-term progress understandable and selectively shareable.

- [ ] Create weekly, monthly, and annual narratives covering meaningful improvements, milestones, behaviors associated with better outcomes, source changes, and data completeness.
- [ ] End each recap with one lesson or action for the next period.
- [ ] Generate privacy-safe share cards that exclude health-sensitive fields by default.
- [ ] Allow a user to create a time-limited report for a coach, clinician, family member, or other trusted recipient.
- [ ] Let the user select domains and date ranges instead of sharing the full account.
- [ ] Include sources, coverage, uncertainty, and raw-data appendices when appropriate.

Personalized stories can create both reflection and organic distribution; Spotify's 2025 Wrapped added personalized data stories and share cards, and Spotify reported more than 620 million Wrapped shares during 2025 in its [2026 Investor Day recap](https://newsroom.spotify.com/2026-05-21/investor-day-recap/). For health-specific sharing, Apple documents granular [Health sharing](https://www.apple.com/newsroom/2021/06/apple-advances-personal-health-by-introducing-secure-sharing-and-new-insights/), and Exist added configurable [PDF health exports](https://exist.io/blog/pdf-export/) in response to user requests for clinician and family sharing.

### Later: Data Trust Center

Turn the existing source-attribution, processing-status, freshness, and deduplication infrastructure into an explicit user-facing capability.

- [ ] Explain which sources contributed to a displayed number.
- [ ] Show last successful sync, expected freshness, and coverage gaps.
- [x] Explain source conflicts and the priority or deduplication decision that resolved them. ([#2058](https://github.com/Asherlc/dofek/issues/2058))
- [ ] Answer “Why did this number change?” using versioned source and calculation evidence.
- [ ] Provide direct remediation for stale, disconnected, or incomplete sources.
- [ ] Let users inspect processing history without exposing infrastructure jargon by default.

The trust center should extend the existing processing-status and source-attribution work rather than create another data-health implementation. An adjacent model is [Monarch Money](https://www.monarchmoney.com/BEGINNERS), which combines broad connectivity with disconnection notifications, goals, customization, and controlled collaboration.

### Product Success Measures

Instrument and review these measures before expanding the roadmap:

- **Activation:** the user connects sufficient data and receives the first credible Daily Brief within 24 hours.
- **Time to value:** elapsed time between account creation and the first explanation or recommendation based on real user data.
- **Data readiness:** percentage of active users with enough fresh data to generate a Brief, plus the leading causes of insufficient data.
- **Brief usefulness:** accept, modify, intentional-dismiss, and outcome-check-in rates.
- **Experiment completion:** percentage of started experiments that collect enough adherent observations to report a result or a justified insufficient-data outcome.
- **Retention:** day 7, day 30, and rolling four-week retention segmented by activation and Brief engagement.
- **Conversion:** subscription conversion segmented by source count, goal, first insight, and Brief engagement.
- **Trust:** source-remediation success, report corrections, support contacts about incorrect metrics, and user-reported recommendation confidence.

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
- Onboarding and settings persist a primary goal from shared options in `@dofek/onboarding/primary-goal`; see [`primary-goal.ts`](../packages/onboarding/src/primary-goal.ts), [`PrimaryGoalSelector.tsx`](../packages/web/src/components/PrimaryGoalSelector.tsx), and [`PrimaryGoalSelector.tsx`](../packages/mobile/components/PrimaryGoalSelector.tsx).
- Web onboarding includes the public iOS TestFlight invite so Apple Health and mobile setup are first-class; see [`OnboardingPage.tsx`](../packages/web/src/pages/OnboardingPage.tsx).
- Landing page copy frames correlations, trends, comparisons, and cross-device source setup before signup; see [`LandingPage.tsx`](../packages/web/src/pages/LandingPage.tsx).

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
- [x] Read-only menstrual-cycle tracking from explicit Apple Health menstrual-flow records,
  including the upstream cycle-start marker, source attribution, background HealthKit delivery,
  XML import, and provider-only correction workflow
  ([HealthKit menstrual flow](https://developer.apple.com/documentation/healthkit/hkcategorytypeidentifier/menstrualflow)).
- [ ] Add Garmin Women's Health only after Connect Developer Program approval and access to the
  official payload contract; do not extend the private Garmin provider with guessed endpoints
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
- [x] Supplement tracking (immutable schedules materialize bounded per-user
  planned/unknown occurrences; append-only taken/skipped corrections preserve
  provenance, and only current taken leaves contribute canonical nutrients)
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
