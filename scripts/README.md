# Scripts

Utility and maintenance scripts for development, infrastructure, and reverse engineering.

## Database & Seeding

- `seed-dev-db.ts`: Seeds a local development or review-app database with deterministic reviewer data.
  - Creates the `Review User`, `dev-session`, connected providers, sync logs, 180 days of recovery metrics, 120 days of activities, nutrition, body composition, labs, DEXA scans, journal entries, and life events.
  - Populates the main web and mobile review surfaces while keeping generated data deterministic across runs.
  - Automatically applies migrations when needed and verifies representative row counts before reporting success.
  - Usage: `DATABASE_URL=... pnpm seed`
- `seed-openai-reviewer-demo.ts`: Seeds only the existing
  `asherlc+openai-review@asherlc.com` account with deterministic synthetic
  daily HRV/steps (August 18–31, 2026), seven sleep records, four activities,
  and three provider last-sync records. It fails when that exact account is
  absent, removes only its own source-tagged rows, and never reads or copies
  another account's health data.
  - Usage: `pnpm seed:openai-reviewer-demo`
  - Target database: the command uses `.env.local`'s `DATABASE_URL` when that
    file is present; otherwise it uses the production database URL exported by
    Infisical. Do not prefix this command with `DATABASE_URL=...`, because the
    environment wrapper intentionally applies `.env.local` after shell
    variables.
- `seed-review-clickhouse.ts`: Refreshes review-user relational tables in
  ClickHouse and inserts 90 deterministic review body-weight samples directly
  into canonical `ingest.metric_stream`. It tombstones only its own prior
  `review-seed-body-weight-*` rows and never truncates or replaces unrelated
  sensor rows; see the [seed implementation](./seed-review-clickhouse.ts).
  Postgres is no longer a metric-stream source; see the
  [metric-stream retirement record](../docs/metric-stream-postgres-retirement.md).
  - Usage: `pnpm review:seed-clickhouse`
- `migrate-raw.mjs`: Utility for running raw SQL migrations or manual data fixes.
- `backfill-exercise-provenance.ts`: Idempotently reconstructs user/provider
  ownership for exercises and provider aliases from historical strength sets,
  in bounded batches, then verifies that no attributable rows were missed.
  - Usage: `DATABASE_URL=... pnpm backfill:exercise-provenance`
- `repair-activity-data-integrity.ts`: Dry-run-first, user/window-bounded repair
  for activity local-time context and its dbt-owned ClickHouse grouping and
  summary read models. A global PostgreSQL advisory lease serializes runs, a
  bounded CDC barrier precedes the affected-key dbt refresh, and the private
  audit artifact supports compare-and-swap rollback of the complete seven-model
  chain with a monotonic `UInt64` version. PostgreSQL documents advisory locks
  in its [explicit locking reference](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS).
  - Usage: `pnpm tsx scripts/with-env.ts -- pnpm tsx scripts/repair-activity-data-integrity.ts --user-id=<uuid> --start-at=<utc> --end-at=<utc>`
  - Procedure: [activity data integrity repair runbook](../docs/activity-data-integrity-repair-runbook.md)
## Environment & Secrets

- `dev-environment.ts`: Idempotent bootstrap and verification for the
  mise-managed local/cloud development environment.
  - `cloud:prebuild` installs frozen pnpm dependencies before the script
    initializes CodeGraph when needed and verifies RTK.
  - `start` fails fast without Docker, starts the workspace Compose stack,
    applies database migrations, and runs the doctor.
  - `doctor` verifies every required CLI, the CodeGraph index, Docker Compose,
    and vcpkg. The `cloud:init` mise task sequences the prebuild and start
    phases.
  - Usage: `mise run cloud:prebuild`, `mise run cloud:start`,
    `mise run cloud:init`, or `mise run doctor`.
  - mise documents that tasks receive the tools and environment declared in
    [`mise.toml`](https://mise.jdx.dev/tasks/).
- `with-env.ts`: Wrapper script that loads `.env` defaults, fetches **Infisical**
  secrets as JSON, and then applies `.env.local` as the highest-precedence local
  override. Infisical documents JSON as a supported export format in the
  [CLI export command](https://github.com/Infisical/cli/blob/main/packages/cmd/export.go).
  - Automatically constructs OpenTelemetry auth headers from `AXIOM_API_TOKEN`.
  - Tags locally wrapped Sentry events with the `development` environment unless
    `.env.local` explicitly selects another environment.
  - Exits before running the command when Infisical export fails or no command is provided.
  - Usage: `pnpm tsx scripts/with-env.ts -- <command>`
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
- `check-dns-records.sh`: Validates that every domain in `deploy/stack.yml` has a matching record in `deploy/dns.tf`. Prevents 521 errors due to missing DNS records.
- `generate-schema-diagram.ts`: Generates DBML and PlantUML diagrams from the Drizzle schema modules (`src/db/schema/`).
  - Uses `drizzle-dbml-generator` and custom parsing logic to build a high-quality ERD.
  - Outputs: `docs/schema.dbml`, `docs/schema.puml`.
- `no-suppressions.ts`: Scans every tracked TypeScript file and rejects lint,
  type-check, coverage, or mutation-test suppression comments. Generated TanStack
  route trees are the only exclusion.
  File discovery uses Git's tracked-file index via
  [`git ls-files`](https://git-scm.com/docs/git-ls-files).
  - Usage: `pnpm lint:suppressions`
- `exact-versions.ts`: Reads every workspace manifest declared by
  [`pnpm-workspace.yaml`](../pnpm-workspace.yaml), rejects `^` and `~` declarations
  in all dependency sections, and accepts pnpm's documented
  [`workspace:` protocol](https://pnpm.io/workspaces#workspace-protocol-workspace).
  The root `pnpm lint` command and required CI lint job run this check.
- `workflow-download-policy.ts`: Rejects GitHub workflow and action source downloads unless they use a full commit SHA; versioned release artifacts must instead be protected by a reviewed checksum. This follows GitHub's guidance that only full commit SHAs are immutable unless immutable releases are enabled: https://docs.github.com/en/actions/how-tos/create-and-publish-actions/using-immutable-releases-and-tags-to-manage-your-actions-releases
- `review-scenario-coverage-policy.ts`: Verifies that web and mobile Storybook
  each export tagged fixtures for the six required review scenarios. Run it
  with `pnpm lint:review-scenarios`; see the
  [review fixture matrix](../docs/review-fixture-scenarios.md).
- `migration-policy.ts`: Checks changed deploy migration SQL for inline backfills, refreshes, and other long-running data work that must live in resumable jobs instead.
- `generate-icons.mjs`: Script to generate app icons for web and mobile.
- `check-clickhouse-cdc.ts`: Fails loudly when required PeerDB replication slots
  are lost, inactive, or retaining dangerous WAL, and when active ClickHouse
  mirrors have stale `_peerdb_synced_at` values.
  - Usage: `pnpm check:clickhouse-cdc`
- `reconcile-pending-processing.ts`: Reconciles pending processing operations
  after the CDC health monitor records a successful bounded CDC result. It
  reports its own failures without changing the recorded CDC health state.
- `check-database-backup-freshness.ts`: Lists every page of the private
  `dofek-db-backups` R2 bucket and fails when no backup exists, object metadata
  is incomplete, or the newest recovery point is at least 24 hours old.
  Cloudflare R2 supports the S3 `ListObjectsV2` operation and its continuation
  token:
  https://developers.cloudflare.com/r2/api/s3/api/#implemented-object-level-operations.
  - Usage: `pnpm tsx scripts/with-env.ts -- pnpm check:database-backup-freshness`
- `cdc-health-state.ts`: Atomically records CDC monitor outcomes and implements
  the bounded-age/failure probe used by the production `cdc-health` service.
- `check-ota-manifest.ts`: Sends the production iOS [Expo Updates protocol
  request](https://docs.expo.dev/technical-specs/expo-updates-1/) and prints
  the deployed update metadata, or reports that no update is available.
  URL, channel, runtime version, and platform have explicit command-line
  overrides for local and preview checks.
  - Usage: `pnpm check:mobile-update`
  - Overrides: `--url <url> --channel <channel> --runtime-version <version> --platform <ios|android>`
- `validate-deploy-env.ts`: Validates the rendered production dotenv and calls
  the same account-erasure keyring parser used by web and worker startup.
  - Usage: `pnpm tsx scripts/validate-deploy-env.ts <rendered-dotenv-path>`
- `render-deploy-service-env.ts`: Converts the validated Infisical export into
  mode-`0600`, allowlisted environment files for each production service and
  one-shot database, CDC, and R2 operation. Docker applies `env_file` per service:
  <https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/>.
  - Usage: `pnpm tsx scripts/render-deploy-service-env.ts <rendered-dotenv-path> <output-directory>`
- `sweep-expired-r2-backups.ts`: Deletes database-backup objects beyond the
  configured age, checks every per-object delete result, and performs a bounded
  paginated verification sweep. This directly enforces retention because R2
  lifecycle expiration can take additional time after an object becomes
  eligible, as documented in [Cloudflare R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).
  - Usage: `pnpm tsx scripts/sweep-expired-r2-backups.ts --env-file <path> --bucket <name> --retention-days <days>`
- `e2e-web.ts`: Starts the isolated web E2E stack, runs Cypress, and always
  tears the stack down. Setup or Cypress failures remain the command's exit
  status after cleanup.
  - Usage: `pnpm e2e:web`

## Reverse Engineering (WHOOP)

These scripts are used to probe and reverse-engineer the WHOOP API and BLE protocol.

- `explore-whoop-raw-sensor.ts`: Probes WHOOP's internal API for raw sensor/accelerometer GET endpoints. Discovered many `weightlifting-service` and `metrics-service` paths.
- `explore-whoop-strength.ts`: Specifically targets the `weightlifting-service` to extract exercise, set, and rep data.
- `parse-whoop-ble-capture.ts`: Full parser for iOS PacketLogger (`.pklg`) or Android BTSnoop captures. Decodes the Maverick 8-byte frame format and extracts 6-axis IMU samples (accel + gyro) to CSV.
- `whoop-capture.py`: Python script for capturing WHOOP BLE traffic on Linux (using `hcidump`).
- `get-whoop-token.ts`: Simple utility to fetch a WHOOP access token from a refresh token via Cognito.
- `parse-whoop-pklg.ts`: Lightweight inspector for `.pklg` packet structure.
