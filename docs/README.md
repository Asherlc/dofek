# Documentation

<!-- cspell:ignore dbml rollups -->

Human-facing architecture notes, provider research, operational runbooks, and
historical records for Dofek.

Current reference docs describe the code and production system as they exist
now. Dated plans, specifications, handoffs, migrations, and incident evidence
are historical records: preserve them for context, but do not execute their
commands or infer current behavior from them unless a current runbook links to
the exact section.

## Start Here

- [../README.md](../README.md): repository overview, local development, and the high-level architecture.
- [development-environment.md](development-environment.md): reproducible local
  and cloud tools, Dev Containers, CodeGraph, RTK, and initialization commands.
- [../deploy/README.md](../deploy/README.md): production architecture, deploy flow, secrets, and debugging access.
- [clickhouse-metric-stream.md](clickhouse-metric-stream.md): Redpanda-fed
  ClickHouse sensor storage and deduped analytics models.
- [schema.md](schema.md): canonical database model and storage philosophy.
- [altitude-provenance.md](altitude-provenance.md): what current providers reveal about altitude source, correction, and confidence.
- [adding-a-provider.md](adding-a-provider.md): how to build or extend a provider.
- [exercise-metadata.md](exercise-metadata.md): Free Exercise DB source file, Dofek exercise metadata overrides, and update workflow.
- [testing.md](testing.md): testing patterns that come up repeatedly in this codebase.
- [processing-status-runbook.md](processing-status-runbook.md): durable processing evidence, deployment order, and stage diagnosis.
- [account-erasure-runbook.md](account-erasure-runbook.md): durable account deletion, retention proof, restore reconciliation, and incident response.
- [roadmap.md](roadmap.md): product strategy, release gates, Daily Brief,
  experiments, goals, and trust roadmap.
- [personal-experiments.md](personal-experiments.md): N-of-1 experiment setup and schedule slice.
- [review-fixture-scenarios.md](review-fixture-scenarios.md): paired web/mobile
  Storybook fixtures for empty, partial, conflicting-source, stale-provider,
  processing, and error review states.

## Architecture And Product Flows

| Doc | What it is for |
|-----|----------------|
| [schema.md](schema.md) | Database layout, raw-data-only rules, and view/dedup behavior. |
| [altitude-provenance.md](altitude-provenance.md) | Provider-by-provider altitude source confidence and modeling implications. |
| [record-local-time.md](record-local-time.md) | Trusted per-record local clock context, provenance, and bounded historical activity backfill. |
| [body-metrics-decision-context.md](body-metrics-decision-context.md) | Server-authored Trend Weight methodology, measurement provenance, and personalized variation context. |
| [schema.dbml](schema.dbml) / [schema.puml](schema.puml) | Generated schema diagrams for quick visual orientation. |
| [adding-a-provider.md](adding-a-provider.md) | Step-by-step provider implementation guide. |
| [exercise-metadata.md](exercise-metadata.md) | Strength exercise metadata source, override format, and upstream refresh workflow. |
| [chart-range-framework.md](chart-range-framework.md) | Backend framework for selected chart ranges, endpoint defaults, and All-history semantics. |
| [daily-heart-rate.md](daily-heart-rate.md) | Daily Heart Rate navigation and local calendar-day semantics across web and mobile. |
| [mcp.md](mcp.md) | Remote MCP endpoint setup, scopes, and tools. |
| [nutrition-ai-input.md](nutrition-ai-input.md) | Web + iOS meal logging flow for natural-language AI input. |
| [file-upload-architecture.md](file-upload-architecture.md) | Durable browser import uploads, R2 object verification, transactional outbox delivery, and recovery. |
| [app-password-auth.md](app-password-auth.md) | Email/password login, password reset, and Settings password management. |
| [credential-encryption.md](credential-encryption.md) | Stored credential encryption, required key material, context binding, and rotation boundary. |
| [posthog-support.md](posthog-support.md) | In-app support ticket flow, PostHog Conversations integration, and failure handling. |
| [roadmap.md](roadmap.md) | Product strategy and release gates across the Daily Brief, experiments, goals, trust, and onboarding. |
| [apple-health.md](apple-health.md) | Apple Health import model and type mapping. |
| [apple-watch-accelerometer.md](apple-watch-accelerometer.md) | Notes on Apple Watch accelerometer capture and interpretation. |

## Provider Research

| Provider | Doc | Focus |
|----------|-----|-------|
| Amazfit/Zepp | [src/providers/README.md](../src/providers/README.md#amazfitzepp) | Current US2 credential flow, API hosts, and account limitations. |
| WHOOP | [whoop.md](whoop.md) | Internal auth, strength data, and raw IMU capture. |
| WHOOP BLE | [whoop-ble-protocol.md](whoop-ble-protocol.md) | BLE protocol, frames, CRCs, and packet formats. |
| Apple Health | [apple-health.md](apple-health.md) | Quantity/category/workout mappings. |
| AllTrails | [alltrails.md](alltrails.md) | Export formats, private endpoint findings, and import-only recommendation. |
| BodySpec | [bodyspec.md](bodyspec.md) | OAuth setup and DEXA/body-composition sync. |
| FatSecret | [fatsecret.md](fatsecret.md) | OAuth 1.0 flow and nutrition import details. |
| Oura | [oura.md](oura.md) | Sleep, readiness, and recovery metrics. |
| Peloton | [peloton.md](peloton.md) | Auth and workout sync notes. |
| Ride with GPS | [ride-with-gps.md](ride-with-gps.md) | OAuth flow and activity import notes. |
| Polar | [polar.md](polar.md) | OAuth, exercise, sleep, and Nightly Recharge mappings. |
| TrainerRoad | [trainerroad.md](trainerroad.md) | Cookie auth, workouts, and parsing details. |
| Wahoo | [wahoo.md](wahoo.md) | OAuth and workout ingestion notes. |
| Withings | [withings.md](withings.md) | Sleep/body sync and webhook details. |
| Zwift | [zwift.md](zwift.md) | Keycloak auth and activity details. |

Cross-provider reverse-engineering references:

- [reverse-engineering-apis.md](reverse-engineering-apis.md): repeatable research techniques for closed or unofficial APIs.
- [reverse-engineering-walkthrough.md](reverse-engineering-walkthrough.md): one end-to-end example, from traffic capture to implementation.
- [provider-api-audit.md](provider-api-audit.md): current provider feasibility and coverage audit.
- [ble-heart-rate.md](ble-heart-rate.md): Bluetooth heart-rate device behavior
  and native capture notes.

## Operations And Runbooks

| Doc | What it is for |
|-----|----------------|
| [ci-debugging.md](ci-debugging.md) | Debugging GitHub Actions failures with `gh` CLI. |
| [package-publishing.md](package-publishing.md) | npm trusted publishing, independent Lerna releases, and configuration-driven SwiftPM mirrors. |
| [performance/loading-performance-runbook.md](performance/loading-performance-runbook.md) | Evidence-first workflow for diagnosing slow web and mobile loading before optimizing clients, tRPC, or ClickHouse. |
| [performance/loading-baseline-2026-07-18.md](performance/loading-baseline-2026-07-18.md) | Current Axiom-backed loading taxonomy and backend evidence gate. |
| [performance/loading-monitors.md](performance/loading-monitors.md) | Loading-performance monitor definitions and investigation links. |
| [clickhouse-read-model-deploy-runbook.md](clickhouse-read-model-deploy-runbook.md) | Deploy failures around ClickHouse CDC, analytics read models, and hot fitness views. |
| [clickhouse-cdc-health-runbook.md](clickhouse-cdc-health-runbook.md) | Preventing, diagnosing, and recovering lost PeerDB CDC slots. |
| [clickhouse-body-measurement-staleness-runbook.md](clickhouse-body-measurement-staleness-runbook.md) | Diagnosing body measurements across the Redpanda sink and ClickHouse analytics layers. |
| [sleep-quality-backfill-runbook.md](sleep-quality-backfill-runbook.md) | Conservatively repairing historical sleep stage availability and sentinel-zero fields in bounded windows. |
| [processing-status-runbook.md](processing-status-runbook.md) | Deploying and diagnosing provider/import processing across Postgres, Redpanda, PeerDB, ClickHouse, dbt, and cache refresh. |
| [account-erasure-runbook.md](account-erasure-runbook.md) | Operating durable account deletion across write fences, remote processors, Postgres, ClickHouse, R2, backups, clients, and restore reconciliation. |
| [metric-stream-redpanda-r2-runbook.md](metric-stream-redpanda-r2-runbook.md) | Current Redpanda ingest and R2 archive health, plus the unimplemented bounded-replay gap. |
| [metric-stream-postgres-retirement.md](metric-stream-postgres-retirement.md) | Completed Postgres metric-stream retirement and current ownership boundaries. |
| [provider-data-deletion-runbook.md](provider-data-deletion-runbook.md) | Generation-fenced provider deletion, transactional outbox delivery, BullMQ checkpoints, and ClickHouse tombstone verification. |
| [clickhouse-activity-dedup-runbook.md](clickhouse-activity-dedup-runbook.md) | Keeping ClickHouse activity read models on canonical deduped activity IDs. |
| [production-incident-baseline.md](production-incident-baseline.md) | Baseline knowledge from production incidents and recurring failure patterns. |
| [provider-sync-degradation-runbook.md](provider-sync-degradation-runbook.md) | Querying degraded provider sync rows and correlating pagination fingerprints with metrics and structured logs. |
| [staging.md](staging.md) | Disabled staging environment notes and re-enable requirements. |
| [xcode-cloud.md](xcode-cloud.md) | Xcode Cloud setup and troubleshooting. |
| [ios-physical-device-release-audit.md](ios-physical-device-release-audit.md) | TestFlight release gate for HealthKit, BLE, motion, Watch, camera, and background behavior on synthetic-only physical hardware. |
| [storage-alerting-and-volume-upgrade.md](storage-alerting-and-volume-upgrade.md) | Storage danger-zone alerts and volume expansion notes for OCI production. |
| [database-backup-recovery-runbook.md](database-backup-recovery-runbook.md) | Databasus service health, R2 freshness monitoring, and isolated restore verification. |
| [record-local-time.md](record-local-time.md) | Dry-run and execute the bounded historical activity local-time context backfill. |
| [oracle-cutover.md](oracle-cutover.md) | Current Oracle production cutover status and deploy targeting notes. |
| [sync-checkpoint-retries.md](sync-checkpoint-retries.md) | Durable provider sync retry checkpoints and retryable infrastructure failure scope. |
| [sentry.md](sentry.md) | Investigating Sentry issues and stack traces from terminal. |
| [traefik-subdomain-404-runbook.md](traefik-subdomain-404-runbook.md) | Diagnosing active Traefik routes, including the Databasus backup service. |

## Historical Records

These files explain why the current system exists but are not current
instructions:

- `superpowers/plans/` and `superpowers/specs/`: dated implementation plans and
  design snapshots. Checklist state records work at the time; verify the code
  before relying on it.
- `incidents/` and dated performance baselines: evidence captured during
  specific investigations.
- [oracle-migration.md](oracle-migration.md),
  [handoff-clickhouse-view-migration-2026-05-06.md](handoff-clickhouse-view-migration-2026-05-06.md),
  and other dated migration/handoff files: completed transition records.
- [metric-stream-timescaledb-runbook.md](metric-stream-timescaledb-runbook.md):
  retired Postgres metric-stream procedure retained only for incident history.

When a historical record conflicts with the root README, a package README, or
an active runbook listed above, the current reference document wins.
