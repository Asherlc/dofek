# Scripts

Utility and maintenance scripts for development, infrastructure, and reverse engineering.

## Database & Seeding

- `seed-dev-db.ts`: Seeds a local development or review-app database with deterministic reviewer data.
  - Creates the `Review User`, `dev-session`, connected providers, sync logs, 180 days of recovery metrics, 120 days of activities, nutrition, body composition, labs, DEXA scans, cycle data, journal entries, life events, and breathwork sessions.
  - Populates the main web and mobile review surfaces while keeping generated data deterministic across runs.
  - Automatically applies migrations when needed and verifies representative row counts before reporting success.
  - Usage: `DATABASE_URL=... pnpm seed`
- `migrate-raw.mjs`: Utility for running raw SQL migrations or manual data fixes.

## Environment & Secrets

- `with-env.sh`: Wrapper script that loads environment variables from `.env`, `.env.local`, and **Infisical**.
  - Automatically constructs OpenTelemetry auth headers from `AXIOM_API_TOKEN`.
  - Exits before running the command when Infisical export fails or no command is provided.
  - Usage: `./scripts/with-env.sh <command>`
- `make-admin.sh`: Promotes a user to admin in the production database via SSH.
  - Resolves server IP via Infisical, finds the `dofek-db` container, and executes `UPDATE fitness.user_profile SET is_admin = true ...`.
  - Usage: `./scripts/make-admin.sh user@example.com`

## Verification & Tooling

- `compose-command.ts`: Canonical local Docker Compose wrapper.
  - Pins the project name, project directory, default compose file, and child `PWD` to the physical workspace before forwarding arguments to Docker Compose.
  - Usage: `pnpm compose -- ps` or `pnpm compose -- --profile metric-stream up -d`.
  - Docker documents [Compose project-name isolation](https://docs.docker.com/compose/how-tos/project-name/) and the [`--project-directory` option](https://docs.docker.com/reference/cli/docker/compose/).
- `compose-env.ts`: Generates workspace-specific ports and connection URLs in `.env.local`; `--up` also starts Postgres, ClickHouse, and Redis through the pinned Compose identity.
- `run-tests.ts`: Starts the workspace Compose dependencies, validates `.env.local`, and runs the requested integration-inclusive Vitest tier with `TEST_DATABASE_URL` set.
- `conductor-archive.ts`: Conductor archive hook that removes Docker Compose resources for the current workspace Compose project.
  - Runs `docker compose down --remove-orphans --volumes` for the default compose file and `docker-compose.e2e.yml` using the physical workspace identity.
  - Removes any remaining containers labeled with the current workspace's Compose project name.
  - Preserves shared images and build cache; Docker documents the exact [`down --volumes` scope](https://docs.docker.com/reference/cli/docker/compose/down/).
  - Usage: `pnpm tsx scripts/conductor-archive.ts`
- `check-dns-records.sh`: Validates that every domain in `deploy/stack.yml` has a matching record in `deploy/dns.tf`. Prevents 521 errors due to missing DNS records.
- `generate-schema-diagram.ts`: Generates DBML and PlantUML diagrams from the Drizzle schema modules (`src/db/schema/`).
  - Uses `drizzle-dbml-generator` and custom parsing logic to build a high-quality ERD.
  - Outputs: `docs/schema.dbml`, `docs/schema.puml`.
- `fix-ts-expect-errors.ts`: Automated removal of `@ts-expect-error` comments across the codebase.
  - Handles standalone lines, inline comments, and specific test patterns like `MockFetchFn`.
- `no-suppressions.sh`: Checks for lint or type suppressions (e.g., `eslint-disable`, `biome-ignore`).
- `exact-versions.sh`: Ensures all dependencies in `package.json` use exact versions (no `^` or `~`).
- `workflow-download-policy.ts`: Rejects GitHub workflow and action downloads from mutable or non-versioned Git refs; executable CI dependencies must use a full commit SHA or versioned release. This complements GitHub's guidance to pin third-party workflow code to immutable references: https://docs.github.com/en/actions/how-tos/security-for-github-actions/security-guides/security-hardening-for-github-actions#using-third-party-actions
- `migration-policy.ts`: Checks changed deploy migration SQL for inline backfills, refreshes, and other long-running data work that must live in resumable jobs instead.
- `generate-icons.mjs`: Script to generate app icons for web and mobile.
- `check-clickhouse-cdc.ts`: Fails loudly when required PeerDB replication slots
  are lost, inactive, or retaining dangerous WAL, and when active ClickHouse
  mirrors have stale `_peerdb_synced_at` values.
  - Usage: `pnpm check:clickhouse-cdc`
- `check-ota-manifest.ts`: Sends the production iOS Expo Updates request and
  fails unless the OTA origin returns a conformant manifest or no-update
  response within five seconds.
  - Usage: `pnpm tsx scripts/check-ota-manifest.ts`

## Reverse Engineering (WHOOP)

These scripts are used to probe and reverse-engineer the WHOOP API and BLE protocol.

- `explore-whoop-raw-sensor.ts`: Probes WHOOP's internal API for raw sensor/accelerometer GET endpoints. Discovered many `weightlifting-service` and `metrics-service` paths.
- `explore-whoop-strength.ts`: Specifically targets the `weightlifting-service` to extract exercise, set, and rep data.
- `parse-whoop-ble-capture.ts`: Full parser for iOS PacketLogger (`.pklg`) or Android BTSnoop captures. Decodes the Maverick 8-byte frame format and extracts 6-axis IMU samples (accel + gyro) to CSV.
- `whoop-capture.py`: Python script for capturing WHOOP BLE traffic on Linux (using `hcidump`).
- `get-whoop-token.ts`: Simple utility to fetch a WHOOP access token from a refresh token via Cognito.
- `parse-whoop-pklg.ts`: Lightweight inspector for `.pklg` packet structure.
