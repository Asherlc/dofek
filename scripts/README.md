# Scripts

Utility and maintenance scripts for development, infrastructure, and reverse engineering.

`pnpm check:dependency-security` runs `check-node-forge-security.ts` and
`check-braces-security.ts` against the installed Expo/Metro dependencies before
the CI audit. See [dependency security patches](../docs/dependency-security-patches.md)
for the upstream fixes, regression coverage, and scoped advisory exceptions.

## Database & Seeding

- `seed-dev-db.ts`: Seeds a local development or review-app database with deterministic reviewer data.
  - Creates the `Review User`, `dev-session`, connected providers, sync logs, 180 days of recovery metrics, 120 days of activities, nutrition, body composition, labs, DEXA scans.
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
- `backfill-activity-effort-identities.ts`: Read-only, user/window-bounded
  audit of retained `fitness.activity.raw` payloads for the exact v1 workout,
  route, segment, and standardized-test fields consumed by the dbt-owned
  activity-effort identity model. It never fetches a provider or writes an
  identity row; the separately scoped dbt build remains the sole materializer.
  - Usage: `pnpm backfill:activity-effort-identities -- --user-id=<uuid> --start=<utc> --end=<utc>`
  - Procedure: [activity effort identity runbook](../docs/activity-effort-identity-runbook.md)
- `repair-activity-data-integrity.ts`: Dry-run-first, user/window-bounded repair
  for activity local-time context, Strong naive wall-clock timestamps, and the
  dbt-owned ClickHouse grouping and summary read models. GPS evidence precedes
  the configured home timezone, and preflight fails when neither can establish
  a reference zone. A global PostgreSQL advisory lease serializes runs, a
  bounded CDC barrier precedes the affected-key dbt refresh, and the private
  audit artifact supports compare-and-swap rollback of the complete timestamp,
  rejected-provider audit, and eight-model derived-state change. PostgreSQL documents advisory locks
  in its [explicit locking reference](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS).
  - Usage: `pnpm tsx scripts/with-env.ts -- pnpm tsx scripts/repair-activity-data-integrity.ts --user-id=<uuid> --start-at=<utc> --end-at=<utc>`
  - Procedure: [activity data integrity repair runbook](../docs/activity-data-integrity-repair-runbook.md)
- `inspect-activity-data-integrity.ts`: Read-only diagnosis of selected activity
  groups, their chosen sensor-summary members, Strong set parentage, and peak
  heart-rate provenance. Requires one `--user-id=<uuid>` and one or more
  repeatable `--activity-id=<uuid-prefix>` options.
  - Usage: `pnpm tsx scripts/with-env.ts -- pnpm tsx scripts/inspect-activity-data-integrity.ts --user-id=<uuid> --activity-id=<uuid-prefix> --activity-id=<uuid-prefix>`
  - Procedure: [activity data integrity repair runbook](../docs/activity-data-integrity-repair-runbook.md)
- `retry-failed-file-upload.ts`: Dry-run-first retry for a failed durable file
  import whose source object is still retained. It verifies the retained object
  size before atomically persisting corrected import metadata and re-arming the
  existing outbox row with an operator-supplied stable job ID. Strong retries
  require an explicit weight unit and IANA timezone.
  - Usage: `pnpm tsx scripts/with-env.ts -- pnpm tsx scripts/retry-failed-file-upload.ts --upload-id=<uuid> --user-id=<uuid> --weight-unit=lbs --timezone=America/Los_Angeles`
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
  - Constructs OpenTelemetry auth headers from `AXIOM_API_TOKEN`, routing logs to
    `dofek-logs` and traces to `dofek-traces` through signal-specific headers.
    OpenTelemetry documents [signal-specific exporter configuration](https://opentelemetry.io/docs/languages/sdk-configuration/otlp-exporter/).
  - Tags locally wrapped Sentry events with the `development` environment unless
    `.env.local` explicitly selects another environment.
  - Exits before running the command when Infisical export fails or no command is provided.
  - Usage: `pnpm tsx scripts/with-env.ts -- <command>`
- `make-admin.sh`: Promotes a user to admin in the production database via SSH.
  - Resolves server IP via Infisical, finds the `dofek-db` container, and executes `UPDATE fitness.user_profile SET is_admin = true ...`.
  - Usage: `./scripts/make-admin.sh user@example.com`

## Verification & Tooling

- `run-swift-mutation.ts`: Runs the existing Muter tool for changed compiled
  Swift sources in their owning Swift packages. Git's merge-base comparison
  limits selection to the PR delta, and SwiftPM's source inventory respects
  each manifest's test and Expo bridge exclusions. Each selected package runs
  from its own directory with package-relative source paths and writes an
  absolute JSON report under `reports/swift-mutation/`.
  - Usage: `pnpm tsx scripts/run-swift-mutation.ts --base origin/main`
  - The shared [Muter configuration](../packages/mobile/muter.conf.yml) is
    linked into each package. The runner skips only an empty compiled-source
    intersection, propagates every nonzero tool exit, and requires a valid
    positive-work report after a selected run. Muter 16 uses its working
    directory's configuration and filenames:
    [configuration loading](https://github.com/muter-mutation-testing/muter/blob/16/Sources/muterCore/MuterRunSteps/LoadConfiguration.swift),
    [file selection](https://github.com/muter-mutation-testing/muter/blob/16/Sources/muterCore/MuterRunSteps/DiscoverSourceFiles.swift).
- Native mutation selection uses the [SwiftPM describe command](https://github.com/swiftlang/swift-package-manager/blob/main/Sources/Commands/PackageCommands/Describe.swift)
  and Git's [three-dot comparison](https://git-scm.com/docs/git-diff),
  rather than duplicating Swift manifest exclusions or comparing unrelated
  changes on the current base-branch tip.
- `detect-ci-changes.ts`: Classifies changed paths and affected workspace
  packages for the existing CI jobs. Native files under `packages/mobile/`
  enable mobile checks even when the longest matching workspace is a local
  module with no manifest dependency edge to the app. The new path check
  excludes Markdown; existing workspace impact rules remain in effect.
  Expo discovers [local native modules](https://docs.expo.dev/modules/autolinking/#nativemodulesdir)
  separately from dependency traversal. See the
  [detector implementation](./detect-ci-changes.ts) and
  [CI workflow](../.github/workflows/ci.yml).
  - Usage: `pnpm tsx scripts/detect-ci-changes.ts --changed-file packages/mobile/modules/whoop-ble/ios/WhoopBleConnectionManager.swift --json`
- `resolve-deploy-image.ts`: Resolves a requested registry image once, pulls the
  immutable manifest reference through the configured Docker daemon, verifies
  its full source release, and retains the existing web service's desired digest
  for pre-migration deployment. Emits `image_ref`, `pre_migration_image_ref`, and
  `sentry_release` through `GITHUB_OUTPUT`.
  - Usage: `pnpm tsx scripts/resolve-deploy-image.ts <image-reference> <full-source-sha> <web-service-name>`
  - Uses Docker's [manifest descriptor JSON](https://docs.docker.com/reference/cli/docker/buildx/imagetools/inspect/#json-output)
    and [immutable pulls](https://docs.docker.com/reference/cli/docker/image/pull/#pull-an-image-by-digest-immutable-identifier).
- `verify-deploy-image.ts`: Verifies a converged service's desired image and
  exact desired-running task count against the selected repository/manifest
  digest. Zero tasks are accepted only for a service with zero desired replicas.
  - Usage: `pnpm tsx scripts/verify-deploy-image.ts <immutable-image-reference> <service-name>`
  - Reads Docker's [service tasks](https://docs.docker.com/reference/cli/docker/service/ps/)
    and [inspection output](https://docs.docker.com/reference/cli/docker/inspect/).

- `prepare-migration-deployment.ts`: Reads migration histories from the selected
  immutable requested and previous images without starting either app. Requires
  the current desired image to match the resolver's selected previous image.
  Selects
  maintenance for a new `-- dofek: deployment-mode=maintenance` boundary and
  rejects divergent or older histories. The deployed image comparison preserves
  maintenance selection after a migration committed but rollout failed; see the
  [deployment flow](../deploy/README.md#flow-diagram) and Docker's
  [container file copy](https://docs.docker.com/reference/cli/docker/container/cp/).
  The web maintenance-target service label also rejects an older requested
  history while maintenance remains incomplete; Docker defines
  [service labels](https://docs.docker.com/reference/compose-file/deploy/#labels).
  - Usage: `pnpm tsx scripts/prepare-migration-deployment.ts <requested-image-ref> <stack-name> <pre-migration-image-ref>`
- `wait-migration-quiescence.ts`: Blocks migrations until each selected service
  has zero desired replicas and all actual tasks are terminal, including web in
  maintenance mode. It allows the existing worker drain contract to finish;
  see [Swarm task states](https://docs.docker.com/engine/swarm/how-swarm-mode-works/swarm-task-states/).
- `select-web-deploy.ts`: Selects the latest successful main-push CI release
  after the production deployment concurrency slot is acquired. Walks the fetched
  `origin/main` first-parent history newest first, checking successful CI by
  `head_sha` until it finds a passing commit, bounded by the triggering commit.
  Reads the API's `workflow_runs` array; an empty array means that commit has no
  matching successful run.
  Requires full main history and rejects a response for another commit, branch,
  event, or conclusion; see [`git rev-list`](https://git-scm.com/docs/git-rev-list)
  and the [workflow-run filters](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow).
  Manual requests retain their explicit image tag. Unsuccessful CI triggers cancel their own
  deployment request and never return a successful step result. The workflow
  supplies the standard GitHub event, output, summary, repository, and run-ID
  environment variables; see the [workflow-run API](https://docs.github.com/en/rest/actions/workflow-runs)
  and [GitHub default environment variables](https://docs.github.com/en/actions/reference/workflows-and-actions/variables#default-environment-variables).
  - Usage: `pnpm tsx scripts/select-web-deploy.ts` in `Deploy Web`.
- `testflight-deployment.ts`: Detects signed iOS native changes against the
  latest successful upload receipt, prepares a pending intent immediately before
  Xcode upload, and finalizes that same deployment after upload succeeds. Uses one GitHub deployment
  history with environment `testflight` and task `testflight-upload`, independent
  of the caller workflow's commit or job name. Empty successful history requires
  a first build; API or malformed-history failures stop the release. A newer
  unresolved intent blocks publication, including `--force`, and is rechecked
  inside every uploader attempt. Failed/cancelled uploads stay unresolved because
  Apple may already have accepted the binary. Only a confirmed success or an
  operator's `INACTIVE` reconciliation clears that guard; mark an intent inactive
  only after verifying Apple has no upload or that the upload command never began.
  Explicit manual publication uses `--force`; automatic releases compare the uploaded and
  requested source trees, including rollback differences. Git's
  [NUL-terminated diff output and disabled rename detection](https://git-scm.com/docs/git-diff)
  preserve unusual filenames and native deletions moved outside native paths.
  History reads one newest-first page of 100 deployments at a time with each
  deployment's latest status, continuing by cursor only when needed; GitHub
  documents the [ordered deployment connection](https://docs.github.com/en/graphql/reference/repos#repository)
  and [latest-status projection](https://docs.github.com/en/graphql/reference/deployments#deployment).
  Intent and receipt writes use [exact deployment refs](https://docs.github.com/en/rest/deployments/deployments)
  and [pending/success statuses](https://docs.github.com/en/rest/deployments/statuses).
  The receipt records upload success, while Apple separately
  [processes uploaded builds](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/)
  before they appear in App Store Connect.
  `testflight-deployment-cli.ts` supplies the workflow command interface. The
  finalizer validates the original deployment ID, source SHA, build number and
  upload-attempt run URL. It checks that deployment's authoritative latest status
  using the REST response's [global node ID](https://docs.github.com/en/graphql/guides/using-global-node-ids),
  preserves `INACTIVE` reconciliation, and completes an already `SUCCESS` receipt
  without another status write. The history read and intent creation are separate
  API operations; publisher attempts rely on the caller's `deploy-web-production`
  and reusable `deploy-ios` [concurrency serialization](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency),
  rather than an atomic API lock.
  Rerun only a failed receipt job to finalize the original
  successful upload without reuploading; the workflow retains those original outputs.
  - Detection: `pnpm tsx scripts/testflight-deployment-cli.ts detect <owner/repo> <full-source-sha> [--force]`
  - Prepare, immediately before upload: `pnpm tsx scripts/testflight-deployment-cli.ts prepare <owner/repo> <full-source-sha> <build-number> <upload-attempt-run-url>`
  - Finalize the same intent, only after a successful upload: `pnpm tsx scripts/testflight-deployment-cli.ts record <owner/repo> <deployment-id> <full-source-sha> <build-number> <upload-attempt-run-url>`
- `report-repeated-cycling-efforts.ts`: Read-only historical cycling report
  using the same user-bound discovery, comparison, trend, and cycling-performance
  repositories as MCP. It makes no provider network requests and computes no
  cycling metrics. See the [implementation](./report-repeated-cycling-efforts.ts)
  and [analysis workflow](../docs/mcp.md#repeated-cycling-analysis-workflow).
  - Usage: `pnpm tsx scripts/with-env.ts -- pnpm tsx scripts/report-repeated-cycling-efforts.ts --user-id=<authorized-user-uuid> --start=2000-01-01 --end=2099-12-31 --timezone=America/Los_Angeles`
  - This is privileged repository tooling: database credentials loaded by
    `with-env.ts` authenticate the operator. Supply one authorized stored user;
    the script never chooses an account automatically. Remote clients use
    MCP's token-scoped tools. Dates are inclusive in `--timezone` (default
    `UTC`); `.env.local` overrides Infisical connection settings.
  - Output includes counts for every kind/strength, exact provider-defined
    repeats, route/climb repeats, ten most frequent groups, multi-year groups,
    observed provider identity support, and up to five longitudinal comparisons.
    Repetitions count canonical activity memberships within each group;
    memberships across groups overlap. Multi-year means first/last occurrences
    lie in different UTC years, not continuous coverage.
  - Selection order is exact workouts/tests, exact or strongly inferred
    routes/climbs, other strongly inferred identities, then weak name/duration
    candidates. There is no standalone structured-protocol discovery kind;
    comparisons retain returned interval evidence. Generic power follows all
    identity-aware results and is descriptive only.
  - Discovery pages are exhausted before counting/ranking. Limits remain 2,000
    activities and 250 route candidates; exceeding them fails and requires a
    narrower scope. Trends include at most 100 repetitions and preserve
    pagination, caveats, null metrics, quality flags, and full comparison
    provenance. Evidence includes private names, activity IDs and possibly route
    details; keep generated reports private.
  - Missing configuration, user scope, or analytics prerequisites fails with a
    nonzero exit. Empty results and fewer than three usable longitudinal
    examples are explicitly incomplete; zero matches do not prove absence of
    repeats. Freshness/completeness is not certified. Provider support means
    observed evidence in repeated groups, not an exhaustive upstream capability
    inventory. Historical recovery follows the
    [identity runbook](../docs/activity-effort-identity-runbook.md).
  - Ordinary workout bests are lower-bound observed capability, not maximal
    capacity. Lower observed power does not demonstrate fitness decline.
    Identity alone does not establish maximal intent, comparable equipment,
    conditions, pacing, coverage, or FTP validity; see the
    [trend contract](../packages/server/src/mcp/effort-trend-tool.ts).

- `compose-command.ts`: Canonical local Docker Compose wrapper.
  - Pins the project name, project directory, default compose file, and child `PWD` to the physical workspace before forwarding arguments to Docker Compose.
  - Usage: `pnpm compose -- ps` or `pnpm compose -- --profile metric-stream up -d`.
  - Docker documents [Compose project-name isolation](https://docs.docker.com/compose/how-tos/project-name/) and the [`--project-directory` option](https://docs.docker.com/reference/cli/docker/compose/).
- `compose-env.ts`: Generates workspace-specific ports and connection URLs in `.env.local`; `--up` also starts Postgres, ClickHouse, and Redis through the pinned Compose identity.
- `workspace-archive.ts`: Shared Paseo teardown and Conductor archive command.
  Runs the Compose wrapper with all profiles and `down --remove-orphans --volumes`
  for the workspace's default, E2E, and PeerDB integration projects. The default
  and PeerDB integration shutdowns include the PeerDB overlay so its declared
  volumes are removed too. Shared images and build cache remain available;
  see [Compose shutdown options](https://docs.docker.com/reference/cli/docker/compose/down/).
  - Usage: `mise exec -- pnpm tsx scripts/workspace-archive.ts` from the workspace being archived.
- `run-tests.ts`: Starts the workspace Compose dependencies, validates `.env.local`, and runs the requested integration-inclusive Vitest tier with `TEST_DATABASE_URL` set.
- `check-dns-records.sh`: Validates that every domain in `deploy/stack.yml` has a matching record in `deploy/dns.tf`. Prevents 521 errors due to missing DNS records.
- `generate-schema-diagram.ts`: Generates DBML and PlantUML diagrams from the Drizzle schema modules (`src/db/schema/`).
  - Uses `drizzle-dbml-generator` and custom parsing logic to build a high-quality ERD.
  - Outputs: `docs/schema.dbml`, `docs/schema.puml`.
  - Reads [DBML composite primary keys](https://dbml.dbdiagram.io/docs/#index-definition)
    and renders a foreign key containing every primary-key column as zero-or-one,
    using [PlantUML relationship notation](https://plantuml.com/ie-diagram).
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
- `ensure-mobile-preview-channel.ts`: Uses the pinned official EAS CLI to
  create a missing PR channel and verify that it maps only to its same-named
  branch. It refuses production channel names and conflicting mappings. The
  temporary EAS project configuration keeps channel management separate from
  native app configuration. Requires existing Infisical keys `EXPO_APP_ID`
  and `EXPO_TOKEN`; see [EAS channel commands](https://docs.expo.dev/eas/cli/#channelcreate).
  - Usage: `pnpm tsx scripts/with-env.ts -- pnpm tsx scripts/ensure-mobile-preview-channel.ts pr-3060`
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
