# Scripts

Utility and maintenance scripts for development, infrastructure, and reverse engineering.

## Database & Seeding

- `seed-dev-db.ts`: Seeds a local development or review-app database with deterministic reviewer data.
  - Creates the `Review User`, `dev-session`, connected providers, sync logs, 180 days of recovery metrics, 120 days of activities, nutrition, body composition, labs, DEXA scans, cycle data, journal entries, life events, and breathwork sessions.
  - Populates the main web and mobile review surfaces while keeping generated data deterministic across runs.
  - Automatically applies migrations when needed, recreates materialized views, refreshes core views, and verifies representative row counts before reporting success.
  - Usage: `DATABASE_URL=... pnpm seed`
- `migrate-raw.mjs`: Utility for running raw SQL migrations or manual data fixes.

## Environment & Secrets

- `with-env.sh`: Wrapper script that loads environment variables from `.env`, `.env.local`, and **Infisical**.
  - Automatically constructs OpenTelemetry auth headers from `AXIOM_API_TOKEN`.
  - Usage: `./scripts/with-env.sh <command>`
- `make-admin.sh`: Promotes a user to admin in the production database via SSH.
  - Resolves server IP via Infisical, finds the `dofek-db` container, and executes `UPDATE fitness.user_profile SET is_admin = true ...`.
  - Usage: `./scripts/make-admin.sh user@example.com`

## Verification & Tooling

- `check-dns-records.sh`: Validates that every domain in `deploy/stack.yml` has a matching record in `deploy/dns.tf`. Prevents 521 errors due to missing DNS records.
- `generate-schema-diagram.ts`: Generates DBML and PlantUML diagrams from the Drizzle schema (`src/db/schema.ts`).
  - Uses `drizzle-dbml-generator` and custom parsing logic to build a high-quality ERD.
  - Outputs: `docs/schema.dbml`, `docs/schema.puml`.
- `fix-ts-expect-errors.ts`: Automated removal of `@ts-expect-error` comments across the codebase.
  - Handles standalone lines, inline comments, and specific test patterns like `MockFetchFn`.
- `no-suppressions.sh`: Checks for lint or type suppressions (e.g., `eslint-disable`, `biome-ignore`).
- `exact-versions.sh`: Ensures all dependencies in `package.json` use exact versions (no `^` or `~`).
- `generate-icons.mjs`: Script to generate app icons for web and mobile.

## Reverse Engineering (WHOOP)

These scripts are used to probe and reverse-engineer the WHOOP API and BLE protocol.

- `explore-whoop-raw-sensor.ts`: Probes WHOOP's internal API for raw sensor/accelerometer GET endpoints. Discovered many `weightlifting-service` and `metrics-service` paths.
- `explore-whoop-strength.ts`: Specifically targets the `weightlifting-service` to extract exercise, set, and rep data.
- `parse-whoop-ble-capture.ts`: Full parser for iOS PacketLogger (`.pklg`) or Android BTSnoop captures. Decodes the Maverick 8-byte frame format and extracts 6-axis IMU samples (accel + gyro) to CSV.
- `whoop-capture.py`: Python script for capturing WHOOP BLE traffic on Linux (using `hcidump`).
- `get-whoop-token.ts`: Simple utility to fetch a WHOOP access token from a refresh token via Cognito.
- `parse-whoop-pklg.ts`: Lightweight inspector for `.pklg` packet structure.
