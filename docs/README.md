# Documentation

<!-- cspell:ignore dbml rollups -->

Human-facing architecture notes, provider research, and operational runbooks for Dofek.

## Start Here

- [../README.md](../README.md): repository overview, local development, and the high-level architecture.
- [../deploy/README.md](../deploy/README.md): production architecture, deploy flow, secrets, and debugging access.
- [clickhouse-metric-stream.md](clickhouse-metric-stream.md): ClickHouse deduped sensor read model, native backfill, and PeerDB CDC target.
- [schema.md](schema.md): canonical database model and storage philosophy.
- [altitude-provenance.md](altitude-provenance.md): what current providers reveal about altitude source, correction, and confidence.
- [adding-a-provider.md](adding-a-provider.md): how to build or extend a provider.
- [exercise-metadata.md](exercise-metadata.md): Free Exercise DB source file, Dofek exercise metadata overrides, and update workflow.
- [testing.md](testing.md): testing patterns that come up repeatedly in this codebase.
- [roadmap.md](roadmap.md): product-level roadmap notes and planned user-facing improvements.

## Architecture And Product Flows

| Doc | What it is for |
|-----|----------------|
| [schema.md](schema.md) | Database layout, raw-data-only rules, and view/dedup behavior. |
| [altitude-provenance.md](altitude-provenance.md) | Provider-by-provider altitude source confidence and modeling implications. |
| [schema.dbml](schema.dbml) / [schema.puml](schema.puml) | Generated schema diagrams for quick visual orientation. |
| [adding-a-provider.md](adding-a-provider.md) | Step-by-step provider implementation guide. |
| [exercise-metadata.md](exercise-metadata.md) | Strength exercise metadata source, override format, and upstream refresh workflow. |
| [mcp.md](mcp.md) | Remote MCP endpoint setup, scopes, and tools. |
| [nutrition-ai-input.md](nutrition-ai-input.md) | Web + iOS meal logging flow for natural-language AI input. |
| [roadmap.md](roadmap.md) | Product-level roadmap notes, including first-run and onboarding opportunities. |
| [apple-health.md](apple-health.md) | Apple Health import model and type mapping. |
| [apple-watch-accelerometer.md](apple-watch-accelerometer.md) | Notes on Apple Watch accelerometer capture and interpretation. |

## Provider Research

| Provider | Doc | Focus |
|----------|-----|-------|
| WHOOP | [whoop.md](whoop.md) | Internal auth, strength data, and raw IMU capture. |
| WHOOP BLE | [whoop-ble-protocol.md](whoop-ble-protocol.md) | BLE protocol, frames, CRCs, and packet formats. |
| Apple Health | [apple-health.md](apple-health.md) | Quantity/category/workout mappings. |
| AllTrails | [alltrails.md](alltrails.md) | Export formats, private endpoint findings, and import-only recommendation. |
| BodySpec | [bodyspec.md](bodyspec.md) | OAuth setup and DEXA/body-composition sync. |
| FatSecret | [fatsecret.md](fatsecret.md) | OAuth 1.0 flow and nutrition import details. |
| Oura | [oura.md](oura.md) | Sleep, readiness, and recovery metrics. |
| Peloton | [peloton.md](peloton.md) | Auth and workout sync notes. |
| Ride with GPS | [ride-with-gps.md](ride-with-gps.md) | OAuth flow and activity import notes. |
| TrainerRoad | [trainerroad.md](trainerroad.md) | Cookie auth, workouts, and parsing details. |
| Wahoo | [wahoo.md](wahoo.md) | OAuth and workout ingestion notes. |
| Withings | [withings.md](withings.md) | Sleep/body sync and webhook details. |
| Zwift | [zwift.md](zwift.md) | Keycloak auth and activity details. |

Cross-provider reverse-engineering references:

- [reverse-engineering-apis.md](reverse-engineering-apis.md): repeatable research techniques for closed or unofficial APIs.
- [reverse-engineering-walkthrough.md](reverse-engineering-walkthrough.md): one end-to-end example, from traffic capture to implementation.
- [provider-api-audit.md](provider-api-audit.md): current provider feasibility and coverage audit.

## Operations And Runbooks

| Doc | What it is for |
|-----|----------------|
| [ci-debugging.md](ci-debugging.md) | Debugging GitHub Actions failures with `gh` CLI. |
| [clickhouse-read-model-deploy-runbook.md](clickhouse-read-model-deploy-runbook.md) | Deploy failures around ClickHouse CDC, analytics read models, and hot fitness views. |
| [clickhouse-cdc-health-runbook.md](clickhouse-cdc-health-runbook.md) | Preventing, diagnosing, and recovering lost PeerDB CDC slots. |
| [metric-stream-redpanda-r2-runbook.md](metric-stream-redpanda-r2-runbook.md) | Target Redpanda and R2 replay path for durable `metric_stream` rebuilds. |
| [clickhouse-activity-dedup-runbook.md](clickhouse-activity-dedup-runbook.md) | Keeping ClickHouse activity read models on canonical deduped activity IDs. |
| [production-incident-baseline.md](production-incident-baseline.md) | Baseline knowledge from production incidents and recurring failure patterns. |
| [staging.md](staging.md) | Disabled staging environment notes and re-enable requirements. |
| [xcode-cloud.md](xcode-cloud.md) | Xcode Cloud setup and troubleshooting. |
| [storage-alerting-and-volume-upgrade.md](storage-alerting-and-volume-upgrade.md) | Storage danger-zone alerts and volume expansion notes for OCI production. |
| [oracle-migration.md](oracle-migration.md) | Historical production migration notes for the Hetzner-to-Oracle move. |
| [oracle-cutover.md](oracle-cutover.md) | Current Oracle production cutover status and deploy targeting notes. |
| [sync-checkpoint-retries.md](sync-checkpoint-retries.md) | Durable provider sync retry checkpoints and retryable infrastructure failure scope. |
| [metric-stream-timescaledb-runbook.md](metric-stream-timescaledb-runbook.md) | Historical runbook for the retired Postgres metric stream hypertable. |
| [management-ui-auth.md](management-ui-auth.md) | Authentik outpost routing for Portainer, Databasus, CloudBeaver, pgAdmin, and Netdata. |
| [sentry.md](sentry.md) | Investigating Sentry issues and stack traces from terminal. |
| [traefik-subdomain-404-runbook.md](traefik-subdomain-404-runbook.md) | Fixing management subdomains that return Traefik 404s. |

## Notes

- Storybook previews are active via `storybook-preview.yml` and published to R2.
- PR preview artifacts are deleted on close via `cleanup-pr-r2.yml`, with R2 lifecycle rules as a fallback safety net.
- Dedicated PR review apps and the old web preview workflow have been removed and should stay removed.
