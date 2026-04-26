# Documentation

Human-facing architecture notes, provider research, and operational runbooks for Dofek.

## Start Here

- [../README.md](../README.md): repository overview, local development, and the high-level architecture.
- [../deploy/README.md](../deploy/README.md): production architecture, deploy flow, secrets, and debugging access.
- [schema.md](schema.md): canonical database model and storage philosophy.
- [adding-a-provider.md](adding-a-provider.md): how to build or extend a provider.
- [testing.md](testing.md): testing patterns that come up repeatedly in this codebase.

## Architecture And Product Flows

| Doc | What it is for |
|-----|----------------|
| [schema.md](schema.md) | Database layout, raw-data-only rules, and view/dedup behavior. |
| [schema.dbml](schema.dbml) / [schema.puml](schema.puml) | Generated schema diagrams for quick visual orientation. |
| [adding-a-provider.md](adding-a-provider.md) | Step-by-step provider implementation guide. |
| [nutrition-ai-input.md](nutrition-ai-input.md) | Web + iOS meal logging flow for natural-language AI input. |
| [apple-health.md](apple-health.md) | Apple Health import model and type mapping. |
| [apple-watch-accelerometer.md](apple-watch-accelerometer.md) | Notes on Apple Watch accelerometer capture and interpretation. |

## Provider Research

| Provider | Doc | Focus |
|----------|-----|-------|
| WHOOP | [whoop.md](whoop.md) | Internal auth, strength data, and raw IMU capture. |
| WHOOP BLE | [whoop-ble-protocol.md](whoop-ble-protocol.md) | BLE protocol, frames, CRCs, and packet formats. |
| Apple Health | [apple-health.md](apple-health.md) | Quantity/category/workout mappings. |
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
| [production-incident-baseline.md](production-incident-baseline.md) | Baseline knowledge from production incidents and recurring failure patterns. |
| [review-apps.md](review-apps.md) | Review app lifecycle, routing, and quota troubleshooting. |
| [xcode-cloud.md](xcode-cloud.md) | Xcode Cloud setup and troubleshooting. |
| [storage-alerting-and-volume-upgrade.md](storage-alerting-and-volume-upgrade.md) | Storage danger-zone alerts and zero-downtime Hetzner volume expansion plan. |
| [metric-stream-timescaledb-runbook.md](metric-stream-timescaledb-runbook.md) | Converting `fitness.metric_stream` to a hypertable safely. |
| [bugsink.md](bugsink.md) | Investigating Bugsink issues and stack traces from terminal. |
| [traefik-subdomain-404-runbook.md](traefik-subdomain-404-runbook.md) | Fixing management subdomains that return Traefik 404s. |

## Notes

- Storybook previews are active via `review-app-storybook.yml` and published to R2.
- PR preview artifacts are deleted on close via `cleanup-pr-r2.yml`, with R2 lifecycle rules as a fallback safety net.
- The old web preview workflow (`review-app-web.yml`) has been removed and should stay removed.
