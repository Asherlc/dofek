# Infrastructure and Deployment

Infrastructure-as-code and deployment configuration for Dofek.

## Architecture

Dofek production is deployed as a **single-node Docker Swarm** stack on an
Oracle Cloud Infrastructure (OCI) Ampere A1 host, with **Cloudflare** for DNS,
R2 storage, and CDN. Hetzner-backed production, staging, and PR review-app
infrastructure has been retired.

- **Compute**: Production runs on an OCI Ampere A1 ARM64 host provisioned by `deploy/oracle-free/` and addressed through the `ORACLE_SERVER_HOST` GitHub Actions variable. The server runs `dockerd` initialized as a single-node swarm manager and has no deploy scripts or secrets on disk.
- **Storage**:
  - **PostgreSQL**: Managed via TimescaleDB with PostGIS enabled for geospatial metric data.
  - **ClickHouse**: Runs in the swarm as the stored analytics read-model service for heavy activity stream reads. The raw `metric_stream` copy is populated by the Redpanda ClickHouse sink for Redpanda-first sources and remains compatible with tracked ClickHouse migrations and chunk-range backfills. See [docs/clickhouse-metric-stream.md](../docs/clickhouse-metric-stream.md).
  - **Redpanda**: Runs internally in the swarm as the hot ingest log for high-volume `metric_stream` events. The ClickHouse sink service consumes the topic, and Redpanda Connect archives it to R2.
  - **PeerDB**: Runs internally in the swarm as the Postgres-to-ClickHouse CDC service for lower-volume raw fitness tables into `postgres_fitness.*`.
  - **Volume**: Production uses the OCI data volume mounted at `/mnt/dofek-data`.
  - **DB data path**: The `db` service bind-mounts Postgres data to `/mnt/dofek-data/postgres`.
  - **Operational UI state**: Databasus remains enabled because it owns the
    PostgreSQL backup schedule. CloudBeaver and the other optional management
    UIs are scaled to zero by the Oracle production override.
  - **S3 (R2)**: Cloudflare R2 buckets for training data
    (`dofek-training-data`), private direct file imports (`dofek-imports`), web
    build assets (`dofek-web-assets`), OTA updates (`dofek-ota`), Storybook
    (`dofek-storybook`), scheduled PostgreSQL backups
    (`dofek-db-backups`), and the durable metric-stream archive
    (`dofek-metric-stream-archive`).
- **Networking**:
  - **Firewall**: OCI security lists allow production SSH/HTTP/HTTPS.
  - **DNS**: Cloudflare manages multiple zones: `dofek.fit`, `dofek.live`, and subdomains on `asherlc.com`.
  - **Reverse Proxy**: Traefik handles SSL termination via Let's Encrypt (DNS-01 challenge) and routes traffic based on `Host()` rules declared in `deploy.labels` on each swarm service. Traefik's `providers.swarm` watches the Docker API for service changes.
- **Observability**:
  - **OpenTelemetry**: `otel-collector` gathers traces, logs, and metrics.
  - **Axiom**: Primary destination for structured logs and metrics via OTLP.
  - **Sentry**: Receives application errors only from `web` and `worker`
    deployments whose explicit `DEPLOY_ENVIRONMENT` is `prod` or `production`.
    Local processes do not initialize Sentry even if they inherit a DSN. The
    SDK sends the explicit `production` environment value documented in
    [Sentry's Node configuration options](https://docs.sentry.io/platforms/javascript/guides/node/configuration/options/).
    Production images also set `SENTRY_RELEASE` to the full source commit SHA,
    matching the release used by the browser build. After the complete Swarm
    rollout converges, the deploy workflow records that release as deployed to
    `production` for both `dofek-web` and `dofek-server`; Sentry treats a deploy
    as an environment-specific instance of a release, and requires the release
    identifier to match the SDK event:
    [Sentry Release Action](https://github.com/getsentry/action-release#usage),
    [Create a Deploy API](https://docs.sentry.io/api/releases/create-a-deploy/).
  - **Netdata**: Defined in the base stack but disabled by the Oracle
    production override. Host and application telemetry must be inspected
    through the active collector/Axiom path or direct diagnostics.
- **Secrets**: Managed via **Infisical**. CI logs in with OIDC machine identity, renders `.github/templates/infisical-dotenv.tmpl` via `infisical export --template`, and writes a temporary environment-specific `.env.<env>` file on the runner for `docker stack deploy`. The server never stores secrets on disk.

## Implementation Details

### Terraform (`*.tf`)

- `oracle-free/`: Separate Terraform root for the OCI production host. The reserved public IP is copied into the `ORACLE_SERVER_HOST` GitHub Actions variable and into the main `deploy/` root as `var.oracle_server_host`.
- `dns.tf`: Configures Cloudflare DNS records. Root domains (`dofek.fit`,
  `dofek.live`) are proxied (CDN enabled). DNS records for management
  subdomains still exist. Databasus remains active for backup operations; the
  other management services are disabled in Oracle production.
- `storage.tf`: Manages Cloudflare R2 buckets, lifecycle rules, the `assets.dofek.fit` bucket-level custom domain, and the CORS policy required for browser module loads from that cross-origin asset hostname. Cloudflare documents R2 custom domains as bucket-level domain bindings, not ordinary origin `CNAME` records, and documents that custom domains return CORS headers only when the bucket has a matching CORS policy: https://developers.cloudflare.com/r2/buckets/public-buckets/#custom-domains and https://developers.cloudflare.com/r2/buckets/cors/#use-cors-with-a-custom-domain. The `storybook.dofek.fit` custom domain is still configured manually in the Cloudflare dashboard.
  It also manages the private `dofek-imports` bucket. Its CORS policy permits only
  production application origins to make `PUT` requests and exposes `ETag` for
  multipart completion. Raw objects expire after seven days and incomplete
  multipart uploads after one day. Cloudflare's presigned URL flow still requires
  bucket CORS for browsers: https://developers.cloudflare.com/r2/buckets/cors/#use-cors-with-a-presigned-url.
  The `assets.dofek.fit` custom domain was first restored manually during the
  2026-07-10 production incident, so the first Terraform apply after this
  resource was added must either import/adopt that existing Cloudflare object if
  the provider supports it or remove and recreate it in a controlled apply;
  creating the same R2 custom domain twice returns Cloudflare error `10052`
  (`Domain already in use`).

### Server Configuration (`server/`)

- `cloud-init.yml`: Installs Docker CE, configures Docker log rotation (10m, 3 files), and idempotently runs `docker swarm init`. No deploy helpers, no Infisical CLI.

### Swarm Stack (`stack.yml` + `stack.oracle.yml`)

- `stack.yml` defines the complete application, storage, ingest, PeerDB,
  Temporal, observability, OTA, and optional management-service topology.
  Production always applies `stack.oracle.yml` on top of it.
- Traefik consumes the swarm provider and routes traffic from labels declared on stack services.
- Zero-downtime updates for `web` and `worker` are configured via `deploy.update_config` (`order: start-first`, `failure_action: rollback`, healthcheck-gated `monitor` window).
- The BullMQ worker has a 30-minute stop grace period. BullMQ's graceful `Worker.close()` stops accepting new jobs and waits for active jobs, while Docker otherwise sends `SIGKILL` after a 10-second default. Provider HTTP calls have a shared two-minute deadline, and provider-data deletion advances through one durable 1,000-row continuation job per batch, so the grace period covers bounded work instead of masking unbounded requests or multi-hour loops. The initial rollout convergence deadline is 35 minutes so CI can observe the full graceful-drain result. See [BullMQ graceful shutdown](https://docs.bullmq.io/guide/workers/graceful-shutdown), [Docker `stop_grace_period`](https://docs.docker.com/reference/compose-file/services/#stop_grace_period), and [Node.js `AbortSignal.timeout()`](https://nodejs.org/api/globals.html#static-method-abortsignaltimeoutdelay).
- The worker healthcheck calls the worker process's loopback-only `/readyz` endpoint on port 3001. That endpoint verifies every existing BullMQ Worker's running state and Redis clients; the healthcheck must not start a second Node runtime or construct fresh queue clients inside the worker's 512 MiB cgroup. See the [Docker healthcheck reference](https://docs.docker.com/reference/compose-file/services/#healthcheck) and [BullMQ Worker API](https://api.docs.bullmq.io/classes/v5.Worker.html).
- The `default` overlay network is declared `attachable: true` so CI can run one-shot migration containers on it from a remote Docker context.
- The `db` service has a 2 GiB container memory limit to prevent one PostgreSQL workload from exhausting the single-node host. If it hits that limit, treat it as a query/workload incident rather than increasing the cap by default.
- PostgreSQL runs `timescale/timescaledb-ha:pg18.3-ts2.26.4-all` so TimescaleDB and PostGIS are both available. It is configured with `max_connections=40`, `work_mem=4MB`, `maintenance_work_mem=64MB`, `max_locks_per_transaction=4096` for large Timescale chunk scans, and logical replication settings needed by ClickHouse change-data capture. Production keeps six logical slots/senders and caps each slot at 64 GiB of retained WAL so PeerDB has recovery headroom without allowing an inactive slot to retain unbounded WAL.
- ClickHouse runs the pinned `26.6.1.1193-alpine` stable image with a 13 GiB container memory limit, a 1 CPU Swarm limit, and a checked-in `clickhouse_memory_limits_13g` profile with a 13 GiB `max_server_memory_usage` cap so large analytics queries fail or throttle inside ClickHouse instead of triggering host-level OOM kills or CPU-starving SSH/Docker on the single-node host. Version 26.6 is required for the provider-deletion live-candidate projection to stop an ordered read at its batch limit; ClickHouse 26.3 selected the same projection but read the provider's entire qualifying range. The pinned release is published by ClickHouse: <https://github.com/ClickHouse/ClickHouse/releases/tag/v26.6.1.1193-stable>. The service also loads checked-in server profile settings from `deploy/clickhouse/users.d/` and server settings from `deploy/clickhouse/config.d/`; the production stack mounts these as Docker Swarm configs so app-managed geospatial `Nullable(Point)` columns, bounded memory, and seven-day system-log TTL retention work without manual server changes. Docker Swarm config contents are immutable, so changing a checked-in config file must also rotate the config key in `deploy/stack.yml` (for example `clickhouse_memory_limits_13g`) instead of reusing the same config name with new contents.
- The default ClickHouse profile cancels read-only HTTP queries when their client disconnects and applies a four-minute elapsed-time ceiling to every query. This keeps a timed-out web/dbt client from leaving server work alive across later retry cycles; ClickHouse documents both [`cancel_http_readonly_queries_on_client_close`](https://clickhouse.com/docs/operations/settings/settings#cancel_http_readonly_queries_on_client_close) and the elapsed-time behavior controlled by [`max_execution_time`](https://clickhouse.com/docs/operations/settings/settings#max_execution_time) with `timeout_before_checking_execution_speed=0`.
- All production entrypoint modes that run dbt build the ordered activity and sleep/dashboard model groups with `--threads 1` to avoid concurrent or unsafe ClickHouse model builds on the single-node host. `analytics-worker` also has a 0.5 CPU Swarm limit and currently runs the dbt-native microbatched `sensor_scalar_sample` and `deduped_sensor` models plus the dirty-keyed dashboard and cycling serving models every 15 minutes. `analytics.activity_summary` is served from the incremental `analytics.activity_summary_rows` table through a thin view; `analytics.cycling_activity` and `analytics.daily_cycling` serve the cycling page; and `analytics.daily_recovery`, `analytics.daily_strain`, `analytics.daily_sleep`, and `analytics.weekly_healthspan` serve dashboard recovery, strain, sleep, and healthspan reads. After both dbt groups succeed, the analytics worker sequentially refreshes every live app query cache key registered in Redis, preserving the previous cached value unless recomputation succeeds. The worker's loopback `/readyz` endpoint exposes the current step, last failure, and last successful cycle; Swarm probes that endpoint instead of process liveness. A first-cycle failure is unhealthy immediately, and a previous success becomes unhealthy when its age exceeds the configured build interval plus retry delay. Failed model builds and cache refreshes are captured by Sentry with their failing step before entering the bounded retry path, so retries remain recovery rather than the health signal. Docker documents healthcheck exit-status behavior, dbt documents `build` as running selected models and their tests, Sentry documents captured exceptions, and Redis documents TTL-based key expiration: <https://docs.docker.com/reference/dockerfile/#healthcheck>, <https://docs.getdbt.com/reference/commands/build>, <https://docs.sentry.io/platforms/javascript/guides/node/usage/#capturing-errors>, and <https://redis.io/docs/latest/commands/expire/>. The `cdc-health` service runs `scripts/check-clickhouse-cdc.ts` every five minutes and atomically records the latest result. Its container probe fails after two consecutive failed reports or when the state is more than one interval plus 60 seconds old, so PeerDB slot loss, stale mirrors, and a stuck monitor become visible to Swarm instead of being hidden behind process liveness. Docker documents that a container becomes unhealthy after the configured consecutive probe failures and that Swarm replaces a task whose container fails its healthcheck: <https://docs.docker.com/reference/dockerfile/#healthcheck> and <https://docs.docker.com/engine/swarm/how-swarm-mode-works/services/#tasks-and-scheduling>.
- The CDC state probe starts the TypeScript runtime inside a service limited to
  0.10 CPU, so its healthcheck allows 15 seconds to complete. Production
  measurements showed the previous 5-second limit repeatedly terminating a
  healthy probe before it could read the state file. This timeout is scoped to
  the probe process; the state-age and consecutive-failure thresholds still
  determine CDC health.
- `cdc-health` owns only the bounded CDC check and its state file. The separate
  `processing-reconciliation` service runs reconciliation synchronously, then
  waits 300 seconds before its next run with its own resource budget; its script
  reports failures to Sentry and its loop logs the nonzero exit before the next
  scheduled retry. A reconciliation failure never changes CDC state.
- Netdata has a 768 MiB container memory limit and a checked-in `deploy/netdata/netdata.conf` that bounds dbengine retention to two tiers: one day of per-second data capped at 96 MiB and seven days of per-minute data capped at 128 MiB. The stack mounts this file as a Docker Swarm config, so changing it must also rotate the config key in `deploy/stack.yml` (for example `netdata_db_limits_v2`).
- PeerDB uses an internal catalog Postgres service, Temporal, worker services, and a private MinIO staging bucket. Its persistent catalog and staging data live under `/mnt/dofek-data/peerdb-catalog` and `/mnt/dofek-data/peerdb-minio`. The catalog uses the PostgreSQL 18 image layout: mount the host directory at `/var/lib/postgresql`, not `/var/lib/postgresql/data`, so the image can manage its versioned data directory. Production mirrors use 100,000-row CDC batches and single-worker 100,000-row initial snapshot partitions so PeerDB can stay inside its fixed memory limits at the cost of slower catch-up.
- Redpanda stores hot `metric_stream` ingest data under `/mnt/dofek-data/redpanda` (a bind mount on the large data disk — a default named volume lands on the small root disk and fills during a metric-stream backfill). Redpanda local retention is not the long-term source of truth; Redpanda Connect writes the `metric-stream-v1` topic to the `dofek-metric-stream-archive` R2 bucket for canonical replay. The ClickHouse sink and R2 archive services must be healthy before any metric-stream writer change is considered deployed safely.
- The historical Postgres `fitness.metric_stream` hypertable has been retired; metric-stream durability is Redpanda plus the R2 archive, and ClickHouse is the serving copy. The `cdc-health` service alerts on remaining PeerDB slot lag at 16 GiB and fails the check at 32 GiB so operators have headroom before Postgres reaches the 64 GiB per-slot WAL cap.
- The Oracle override scales Portainer, CloudBeaver, pgAdmin, PeerDB UI, and
  Netdata to zero. Databasus remains at one replica because it owns the backup
  schedule; its base-stack route is active for backup operations.

### Monitoring (`otel-collector-config.yaml`)

- Uses `filelog` receiver to tail Docker logs from `/var/lib/docker/containers/*/*.log`.
- Parsed with `json_parser` and `regex_parser` (to extract container IDs).
- Filters out noisy Postgres `NOTICE` lines to reduce volume.
- Exports to Axiom via `otlphttp`.

## Deployment

Deployments are push-based from CI, using a remote Docker context over SSH. CI never runs shell scripts on the server — it only calls the Docker API.

### Staging

The old Hetzner staging environment is disabled. The main `deploy/` Terraform
root no longer provisions a staging server, volume, DNS records, or deploy
workflow output; successful main CI and manual deploys update production only.
See [docs/staging.md](../docs/staging.md).

### SSH Access (Debugging Only)

For operational debugging, use SSH host aliases instead of raw IP commands so the correct key and user are used consistently.

`~/.ssh/config` entry:

```sshconfig
Host dofek-server
  HostName <ORACLE_SERVER_HOST>
  User ubuntu
  IdentityFile ~/.ssh/id_ed25519_infisical
  IdentitiesOnly yes

```

Quick checks:

```bash
ssh dofek-server 'hostname && whoami'
ssh dofek-server 'df -h'
ssh dofek-server 'docker system df'
```

If direct SSH fails with `Permission denied`, verify you are using the matching host alias and user (`ubuntu` for production OCI) or pass `-i ~/.ssh/id_ed25519_infisical` explicitly.

### Release Unit (Important)

- A web deploy is a **single swarm stack release**, not separate app/ML rollouts.
- `IMAGE_TAG` is shared across GHCR images built from main:
  - `ghcr.io/asherlc/dofek:<tag>` (production stack)
  - `ghcr.io/asherlc/dofek-ml:<tag>` (local ML tooling; not deployed to the stack)
- `docker stack deploy` is the only production rollout command for web deploys. It updates `web` and `worker` together from `deploy/stack.yml`.
- Swarm rollback is **image rollback only**. It does not roll back database schema changes that were already applied.
- Migrations run after the non-pruning pre-migration stack apply and before the
  pruning rollout of the requested app image. Every production schema change
  must therefore remain compatible with both the old and new app versions
  during rollout.

### Production Secrets

Production secrets are stored in Infisical and rendered by CI into a temporary
`.env.<env>` control-plane file on the runner; the file is not stored on the
server. CI validates that complete export, then renders mode-`0600` allowlisted
files for `web`, `worker`, `analytics-worker`, `cdc-health`, `collector`, and
one-shot database, CDC, and R2 operations. Each service or operation receives only its own file;
the metric-stream sink and OTA service receive only their explicit stack
environment. Docker documents that `env_file` is set per Compose service, and
Infisical documents templated CLI exports:
[Docker service environment files](https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/),
[Infisical CLI export](https://infisical.com/docs/cli/commands/export).
Required app, database, ClickHouse, PeerDB, export, and mobile pipeline keys are
listed in the deploy steps and mobile CI sections below. Missing required keys
must fail the workflow before rollout.

The web image build and post-rollout Sentry release step also require the
GitHub Actions `SENTRY_AUTH_TOKEN` secret already used for browser source-map
uploads. The token must be able to manage releases for both `dofek-web` and
`dofek-server`; Sentry documents `org:ci` as the scope intended for CI release
and deployment workflows:
[Sentry API permissions](https://docs.sentry.io/api/permissions/).

### Flow Diagram

```text
CI (main) -> build dofek (+ dofek-ml for local ML tooling)
         -> deploy-web production check (dofek app image tag must exist)
         -> deploy-terraform (shared prerequisite)
         -> deploy-web-stack
              -> export and validate Infisical dotenv via OIDC
              -> render least-privilege service dotenv files
              -> upload immutable web assets
              -> sweep expired backups
              -> validate host bind sources
              -> non-pruning stack apply with analytics-worker, metric-stream-clickhouse-sink, and processing-reconciliation quiesced
              -> wait for Postgres and ClickHouse
              -> migrate requested image on <stack>_default
              -> prune deploy requested image with analytics-worker, metric-stream-clickhouse-sink, and processing-reconciliation quiesced
              -> wait for app convergence and Postgres; run cutover
              -> wait for ClickHouse, PeerDB, and Temporal; configure CDC
              -> final deploy restores analytics-worker, metric-stream-clickhouse-sink, and processing-reconciliation
              -> verify backup freshness and record Sentry release
```

Production web deployments are serialized and never cancel an in-progress
deployment. Automatic and manual triggers share the same production concurrency
group. A rollout intentionally quiesces `analytics-worker`,
`metric-stream-clickhouse-sink`, and `processing-reconciliation` before
migrations and restores all three only after the final stack converges, so a
newer run must
wait rather than interrupt that state transition. Automatic runs also deploy
only when an eligibility job confirms through the GitHub commits API that their
successful CI commit is still the current `main` commit. Only eligible runs
enter the production job's concurrency group, so an older success that finishes
out of order cannot displace a valid pending deployment and is skipped before
Terraform instead of rolling production back. GitHub documents both the
commits endpoint and that concurrency groups retain at most one running and one
pending job, with `cancel-in-progress` controlling whether a running job is
terminated:
<https://docs.github.com/en/rest/commits/commits#get-a-commit>,
<https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency>.

1. **Build**: GitHub Actions builds the `server` image for every `main` push and pushes it to GHCR with the commit-derived tag (`<tag>`), because `Deploy Web` is triggered by the successful `CI` `workflow_run` for `main` and deploys that tag. The web build inside the image uses `VITE_ASSET_BASE_URL=https://assets.dofek.fit/web/<tag>/`, so Vite-generated JavaScript and CSS references point at immutable R2-backed CDN assets instead of the Express origin; Vite's `base` option controls the public base path for built assets: https://vite.dev/config/shared-options.html#base. `<tag>` is the image tag used consistently for both the GHCR image and the web asset prefix. See GitHub's `workflow_run` event documentation for the trigger behavior: https://docs.github.com/en/actions/reference/events-that-trigger-workflows#workflow_run. The `ml` image is built only when ML image inputs change.
   Automatic deploys also check out the successful CI run's full commit SHA
   before rendering stack configuration. GitHub documents that a
   `workflow_run` workflow's `GITHUB_SHA` is the last commit on the default
   branch rather than necessarily the triggering workflow's commit, so using
   a live API result as the freshness boundary and
   `github.event.workflow_run.head_sha` as the deploy commit prevents a queued
   stale success from rolling production backward while keeping image code,
   healthchecks, entrypoints, and stack configuration from different revisions
   from being mixed:
   <https://docs.github.com/en/actions/reference/events-that-trigger-workflows#workflow_run>.
   Manual image-tag deploys must dispatch the workflow with `--ref` set to the
   full source commit for that image. After pulling the app image, the workflow
   compares its full `SENTRY_RELEASE` with the checked-out Git commit and fails
   before asset upload, migrations, or stack deployment when they differ.
2. **Terraform apply** (if infra changed): updates Cloudflare-managed production DNS and storage. `ORACLE_SERVER_HOST` is required for production DNS and deploy targeting.
3. **Deploy Web Stack** (`deploy-web-stack.yml`):
   1. Install the Infisical CLI, login with OIDC machine identity (`identity-id=46b66f72-0c77-4cfe-be1b-a43395e77be7`), and render `${{ github.workspace }}/.env.<env>` from `.github/templates/infisical-dotenv.tmpl`.
      The template escapes embedded newlines only when `secret.IsMultilineEncodingEnabled` is true.
      After validating the complete export, CI uses
      `scripts/render-deploy-service-env.ts` to create service-scoped files in
      the runner's temporary directory. The complete file remains available
      only to runner-side stack interpolation and control-plane derivation; never
      use it as a service `env_file`.
      - Must include `CREDENTIAL_ENCRYPTION_KEY_BASE64` (base64-encoded 32-byte key).
      - Must include `CLICKHOUSE_PASSWORD` for the ClickHouse service. The deploy workflow URL-encodes it into `CLICKHOUSE_PASSWORD_ENCODED` for app `CLICKHOUSE_URL` interpolation.
      - Must include `POSTGRES_PASSWORD`; PeerDB's catalog database and internal MinIO stage use this existing secret.
      - Must include `PEERDB_UI_NEXTAUTH_SECRET` as a dedicated high-entropy PeerDB UI session-signing secret.
      - Must include `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `STRIPE_PRICE_ID` for Stripe billing checkout, portal, and webhook verification. Public return URLs use the deploy workflow's `PUBLIC_URL`.
      - Must include `REDPANDA_BROKERS` and `METRIC_STREAM_TOPIC` for metric-stream producer and sink services.
      - Must include `METRIC_STREAM_R2_BUCKET`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` for the Redpanda Connect R2 archive.
      - Must include `ACCOUNT_ERASURE_LEDGER_KEYRING_JSON` as
        `{"activeKeyId":"<id>","keys":{"<id>":"<base64-32-byte-key>"}}`.
        Keep every retained key while restore-ledger objects still reference
        it; rotate by adding the new key, changing `activeKeyId`, deploying,
        and retaining the retired key for the life of the ledger. Web and worker
        startup validate every retained key and reconcile
        the immutable R2 intent ledger before accepting traffic or jobs.
        Terraform locks the `account-erasure/v1/` prefix indefinitely and does
        not apply a lifecycle deletion rule. This narrow deletion ledger keeps
        only a random deletion-request identifier and timestamp, a keyed
        pseudonymous account digest, a key identifier, and the authenticated
        ciphertext needed to recover the status capability. It contains no raw
        account or provider identifiers, email address, health data, or provider
        credentials. Cloudflare documents that R2 bucket locks can prevent
        deletion and overwriting indefinitely, apply to existing and new
        objects, and take precedence over lifecycle deletion:
        [R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/).
      - Must include `BREVO_API_KEY`, `POSTHOG_PERSONAL_API_KEY`, and
        `POSTHOG_PROJECT_ID` so account erasure can delete Brevo transactional
        logs and PostHog persons, events, and recordings. The credentials must
        authorize the documented [Brevo transactional-log deletion API](https://developers.brevo.com/reference/delete-an-smtp-transactional-log)
        and [PostHog Persons API](https://posthog.com/docs/api/persons).
      - Must include `AXIOM_API_TOKEN`, `SENTRY_AUTH_TOKEN`, and `SENTRY_ORG`
        so the final account-erasure phase can verify that processor log
        retention remains within the published 30-day boundary. The Axiom token
        must read dataset configuration, including `retentionDays` and
        `useRetentionPeriod`, and the Sentry token must have `org:read` access:
        [Axiom dataset API](https://axiom.co/docs/restapi/endpoints/updateDataset)
        and [Sentry Retrieve an Organization](https://docs.sentry.io/api/organizations/retrieve-an-organization/).
      - The S3-compatible `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` must have
        Object Read & Write access scoped to all application buckets they use,
        including `dofek-account-erasure-ledger` and `dofek-db-backups`;
        Cloudflare documents that this permission can be scoped to selected
        buckets and permits object reads, writes, and listings:
        <https://developers.cloudflare.com/r2/api/tokens/#permissions>.
      - Optional: `CREDENTIAL_ENCRYPTION_KEY_NAMESPACE` (default `dofek`) and `CREDENTIAL_ENCRYPTION_KEY_NAME` (default `provider-credentials`).
   2. Point Docker CLI at the remote daemon with `DOCKER_HOST=ssh://ubuntu@<host>`.
   3. Login to GHCR on the CI runner.
   4. `docker pull ghcr.io/asherlc/dofek:<tag>`.
      The workflow also ensures pinned third-party stack images exist on the
      host, but skips those pulls when the exact image is already present.
      Image cleanup is controlled by this deploy workflow: it prunes unused
      containers before unused images so stopped task containers cannot retain
      obsolete writable layers or image references, then verifies the remote
      root filesystem has at least 8 GiB free before pulling. Docker documents
      that stopped containers retain writable layers, that container pruning
      removes them, and that `docker image prune -a` removes images unused by
      remaining containers in its
      [resource-pruning guide](https://docs.docker.com/engine/manage-resources/pruning/).
      The workflow prunes obsolete images again after a successful stack deploy.
      Do not run a continuous background image pruner on the production host,
      because newly pulled deploy images are not referenced by a service until
      after migrations complete.
   5. Extract `/app/packages/web/dist` from the pulled deploy image, read the
      `https://assets.dofek.fit/web/<tag>/` prefix embedded in `index.html`,
      and upload every file except `index.html` to
      `s3://dofek-web-assets/web/<tag>/` through the R2 S3-compatible API with
      `Cache-Control: public, max-age=31536000, immutable`. `index.html`
      remains in the server image and is served by Express with `no-cache`; old
      asset prefixes are retained by lifecycle for 90 days so cached HTML can
      still load its hashed chunks and public build files after newer deploys.
      The `dofek-web-assets` bucket must keep Terraform-managed CORS allowing
      cross-origin `GET` and `HEAD` requests, because Vite module scripts and
      module preloads are loaded from `assets.dofek.fit` while the HTML is
      served from domains such as `dofek.fit`. If the CORS policy
      changes while objects are already cached at Cloudflare, purge the
      `assets.dofek.fit` cache hostname so cached asset responses refresh with
      the current `Access-Control-Allow-Origin` header. Cloudflare documents
      this cache behavior for R2 custom-domain CORS here:
      https://developers.cloudflare.com/r2/buckets/cors/#use-cors-with-a-custom-domain.
      Cloudflare documents R2 lifecycle object expiration rules here:
      https://developers.cloudflare.com/r2/buckets/object-lifecycles/.
      Before validating host paths, the production workflow also runs the
      bounded database-backup sweep and verifies that no object older than the
      21-day retention boundary remains.
   6. Validate required host bind-mount directories before the first stack
      apply. Bind sources resolve on the Docker daemon host, not the CI client,
      and Docker's explicit bind-mount syntax errors when a source path is
      absent. The workflow therefore fails before `docker stack deploy` if a
      path such as `/mnt/dofek-data/redis` is missing. See
      [Docker's bind-mount constraints and syntax](https://docs.docker.com/engine/storage/bind-mounts/#syntax).
   7. Apply the stack configuration before migrations with a non-prune,
      detached `docker stack deploy`, the temporary three-service quiesce
      overlay, and the migration quiesce overlay. On existing stacks
      this uses the currently deployed app image tag, so database, ClickHouse,
      network, config, and resource-limit changes are applied before migrations
      without rolling new app code ahead of schema changes. The overlays keep
      `analytics-worker`, `metric-stream-clickhouse-sink`,
      `processing-reconciliation`, and the migration-running `worker` at zero
      replicas during the migration window; see the
      [worker entrypoint](../entrypoint.sh). On clean-slate hosts the
      stack apply uses the deploy image tag so the DB service and overlay network
      exist before readiness checks. After migrations, the workflow deploys the
      requested app image with only the three-service quiesce overlay still applied,
      which restores `worker` using the same image that ran the migrations while
      `analytics-worker`, `metric-stream-clickhouse-sink`, and
      `processing-reconciliation` remain stopped until the final stack deploy.
      The deploy workflow waits explicitly for Postgres and ClickHouse instead
      of keeping a long-lived Docker-over-SSH stack-deploy wait open while the
      single-node host restarts services.
   8. Wait until Postgres is writable (`SELECT NOT pg_is_in_recovery()`) and
      ClickHouse answers `/ping`.
   9. Run the requested image's tracked Postgres and ClickHouse migrations in a
      detached one-shot container on `<stack>_default`. CI polls its status and
      logs, removes it on exit, and fails if it exceeds four hours.
   10. Historical exercise-provenance backfills are
       operator-run one-time tasks, not deployment steps. Run them from the
       image with an explicit `DATABASE_URL` only after reviewing their dry-run
       output, and record the completion date, image commit, and operator in
       the deployment change record. They must not be replayed on every deploy.
       Ordinary integration setup creates the current schema directly and does
       not replay either historical scan.
   11. `docker stack deploy -c deploy/stack.yml -c deploy/stack.cdc-quiesce.yml --with-registry-auth --prune --detach=true <stack>` — swarm rolls out the requested app image while keeping `analytics-worker`, `metric-stream-clickhouse-sink`, and `processing-reconciliation` at zero replicas, and CI polls the key services until their desired replicas are running and any update state is complete. The migration-only overlay is used only by the pre-migration apply to keep the old worker from starting against a newer migration journal. The deploy workflow bounds this initial wait at 35 minutes so the worker's 30-minute graceful-drain contract can complete while a wedged Swarm rollback still fails CI. The final rollout restoring `analytics-worker`, `metric-stream-clickhouse-sink`, and `processing-reconciliation` remains bounded at 20 minutes.
      The workflow parses the Infisical dotenv file inside a child process for stack interpolation. Do not append the full dotenv file to `GITHUB_ENV`; GitHub Actions prints step environments and can expose Infisical-only secrets that GitHub does not automatically mask.
   13. After every requested app service converges, wait for Postgres to be
       writable and run the resumable `provider-connection-cutover` one-shot
       command. It backfills
       `fitness.provider_connection` from legacy provider owners, OAuth tokens,
       and child-table ownership, then validates the OAuth/webhook composite
       foreign keys and removes the obsolete application-wide webhook index.
       The additive migration intentionally does not enforce those foreign keys
       before rollout because the old application does not create connection
       rows. PostgreSQL documents the staged `NOT VALID` and `VALIDATE
       CONSTRAINT` operations used by this cutover:
       <https://www.postgresql.org/docs/current/sql-altertable.html>.
   14. Wait for ClickHouse, PeerDB, and Temporal; create the PeerDB Temporal
       `MirrorName` search attribute if absent; then run the one-shot ClickHouse
       CDC setup command. The command loads
       `src/db/peerdb/metric-stream-cdc.sql`, substitutes deployment connection
       values, creates the Postgres and ClickHouse peers if missing, and applies
       the fitness-raw, provider-inventory, and sensor-priority mirrors.
   15. Run the final `docker stack deploy -c deploy/stack.yml ...` to restore
       `analytics-worker`, `metric-stream-clickhouse-sink`, and
       `processing-reconciliation` only when every post-quiesce readiness step
       and ClickHouse CDC setup succeeds. If a prerequisite fails, the workflow
       leaves all three services at zero replicas and reports that the operator
       must resolve the failed step and rerun the deployment. After restoration,
       each of the three services must keep the same Swarm task at `1/1`
       continuously for 60 seconds; a replacement task or any
       replica loss restarts the stability window. Swarm creates a new task when
       a task crashes, so a transient `1/1` sample is not deployment convergence
       ([Docker Swarm tasks and scheduling](https://docs.docker.com/engine/swarm/how-swarm-mode-works/services/#tasks-and-scheduling)).
       GitHub applies `success()` to successful prior steps, while `always()`
       runs even after failures, so critical deploy steps must not use
       `always()` as their status gate ([GitHub Actions status check functions](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#status-check-functions)).
   16. After the final production stack converges, list the database-backup R2
       bucket and verify that its newest PostgreSQL backup is within the
       configured freshness window.
       Then record the image's full
       `SENTRY_RELEASE` commit SHA as deployed to `production` for
       `dofek-web` and `dofek-server`. Failed, rolled-back, or quiesced
       rollouts never reach this step. The official action requires its
       `release` input to match the SDK release identifier:
       [Sentry Release Action](https://github.com/getsentry/action-release#usage).

When adding a new host bind mount under `/mnt/dofek-data`, update both
`deploy/stack.yml` and the Terraform provisioner that creates the directory. If
the directory is added to an existing `terraform_data` provisioner, bump that
resource's `triggers_replace` value so Terraform actually reruns the remote
`mkdir -p` command on existing servers.

### Rollback Boundary

- A failed swarm rollout can revert service specs and image versions.
- It does **not** revert already-applied database migrations.
- Treat migrations as forward-only production changes.
- If a release includes schema changes, use expand/contract discipline: deploy additive/backward-compatible schema first, then ship code that depends on it, and only remove old schema in a later release.

### ClickHouse Read Models

Deploys do not run Postgres materialized-view sync or refresh maintenance.
Fitness read models that need incremental updates are maintained in ClickHouse,
and dbt is responsible for keeping derived analytics tables current. Do not add
deploy-time Postgres view refreshes or serving-path ClickHouse full refreshes for
normal releases.

### Postgres Statement Diagnostics

Production Postgres enables two built-in diagnostics to support incident triage:

- `pg_stat_statements` is preloaded at server start and enabled via migration.
- `log_min_duration_statement=1000` logs any SQL statement taking 1 second or longer.

Use them during DB incidents to identify the SQL behind timeouts or OOMs:

```bash
# Top statements by total execution time
ssh dofek-server 'container=$(docker ps --format "{{.Names}}" | grep -E "dofek[_-]db" | head -1); \
  printf "%s\n" "select queryid, calls, round(total_exec_time::numeric, 2) as total_ms, round(mean_exec_time::numeric, 2) as mean_ms, left(query, 250) as query from pg_stat_statements order by total_exec_time desc limit 20;" \
  | docker exec -i "$container" sh -lc '\''PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U health -d health -P pager=off -f -'\'''

# Statements currently running
ssh dofek-server 'container=$(docker ps --format "{{.Names}}" | grep -E "dofek[_-]db" | head -1); \
  printf "%s\n" "select pid, state, wait_event_type, wait_event, now() - query_start as duration, left(query, 250) as query from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() order by query_start asc;" \
  | docker exec -i "$container" sh -lc '\''PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U health -d health -P pager=off -f -'\'''

# Recent slow statements from Postgres logs
ssh dofek-server 'docker logs $(docker ps --format "{{.Names}}" | grep -E "dofek[_-]db" | head -1) --since 30m 2>&1 | grep "duration:" | tail -100'
```

### Collector Config Changes

`otel-collector-config.yaml` is a Docker Swarm **config object** (`otel_collector_config` in `stack.yml`) that `docker stack deploy` uploads into the swarm — there is no host file and no Terraform sync. Swarm config objects are **immutable**, so after editing the file you must **bump the config key's version suffix** in `stack.yml` (e.g. `otel_collector_config` → `otel_collector_config_v2`), the same convention as `netdata_db_limits_v2`. A normal `deploy-web-stack` run then creates the new config object and rolls the collector onto it; no `deploy-terraform` needed.

### Mobile CI Secrets (Infisical OIDC)

Mobile/TestFlight workflows now load runtime secrets directly from Infisical via GitHub OIDC using `.github/actions/load-infisical-secrets`.

- Required workflow permission: `id-token: write` (for OIDC token minting).
- Default machine identity: `46b66f72-0c77-4cfe-be1b-a43395e77be7`.
- Default environment: `prod`.

Workflows using this path:

- `.github/workflows/build-mobile.yml`
- `.github/workflows/deploy-ios.yml`
- `.github/workflows/deploy-ota.yml`
- `.github/workflows/mobile-preview-ota.yml`

PR preview object cleanup:

- `.github/workflows/cleanup-pr-r2.yml` deletes `pr-<number>/` objects from `dofek-storybook` and `dofek-ota` when a PR closes.
- R2 lifecycle rules in `deploy/storage.tf` also expire preview prefixes after 14 days as a safety net if a workflow-run cleanup is missed.

Postgres backup status:

- Databasus is an always-on operational service in production, not an optional
  management UI: its process owns the configured backup schedule.
- Databasus stores its own users, storage targets, database definitions, schedules, and backup history in `/mnt/dofek-data/databasus`.
- Terraform creates that directory and performs a one-time copy from the legacy `databasus_data` Docker volume when the bind-mount path is still empty.
- If that path is empty or replaced, Databasus comes up as a fresh install and scheduled DB backups stop even if the `dofek-db-backups` bucket still exists.
- After any Databasus storage or deploy change, verify the latest object in `dofek-db-backups` is less than 24 hours old.
- PeerDB uses its private MinIO bucket only as transient staging while loading
  ClickHouse. The bucket is unversioned and its deterministic lifecycle expires
  objects after one day; MinIO applies that expiration to incomplete multipart
  uploads on unversioned buckets as well. Account-erasure completion also lists
  both objects and multipart uploads and fails closed if scanner lag leaves
  anything past the boundary:
  [PeerDB ClickHouse staging](https://docs.peerdb.io/connect/clickhouse/clickhouse),
  [MinIO lifecycle rule patterns](https://docs.min.io/aistor/administration/object-lifecycle-management/lifecycle-rule-patterns/).
- Database-backup objects expire at 21 days. Account-erasure active-store
  verification scrubs the raw user ID, encrypted remote snapshot, checkpoint
  details, and phase progress by day 7; the 21-day backup window plus
  Cloudflare's documented lifecycle delay keeps the 30-day completion boundary
  measurable. Every web-stack deploy also lists and directly deletes objects
  older than 21 days in bounded batches, then performs a full absence
  verification:
  <https://developers.cloudflare.com/r2/buckets/object-lifecycles/#behavior>.
- The scheduled `Database Backup Freshness` workflow and the production deploy
  workflow fail when the latest object in `dofek-db-backups` is not less than
  24 hours old. Cloudflare documents R2's S3 `ListObjectsV2` support, including
  continuation tokens:
  <https://developers.cloudflare.com/r2/api/s3/api/#implemented-object-level-operations>.
- After any Databasus storage or deploy change, verify both freshness and a
  real isolated restore by following
  [the database backup recovery runbook](../docs/database-backup-recovery-runbook.md).

Required Infisical keys for mobile pipelines:

- `EXPO_PUBLIC_SENTRY_DSN`
- `SENTRY_AUTH_TOKEN` (Sentry sourcemap upload for native and OTA mobile releases: [iOS](../.github/workflows/deploy-ios.yml), [OTA](../.github/workflows/deploy-ota.yml))
- `EXPO_PUBLIC_OTEL_ENDPOINT`
- `EXPO_TOKEN` (OTA publish workflows)
- `EXPO_APP_ID` (OTA server application configuration; the upstream OTA
  server requires this identifier when loading its flat environment
  configuration: [xprem app configuration](https://github.com/mercuretechnologies/xprem/blob/main/config/apps.go))
- `APP_STORE_CONNECT_KEY_ID` (TestFlight deploy)
- `APP_STORE_CONNECT_ISSUER_ID` (TestFlight deploy)
- `APP_STORE_CONNECT_KEY_BASE64` (TestFlight deploy)
- `IOS_DISTRIBUTION_CERT_BASE64` (TestFlight deploy)
- `IOS_DISTRIBUTION_CERT_PASSWORD` (TestFlight deploy)

Optional Infisical keys for mobile pipelines:

- `EXPO_PUBLIC_OTEL_HEADERS` (public client-side OTLP headers; use only write-only ingest credentials because Expo inlines `EXPO_PUBLIC_*` values into the app bundle: https://docs.expo.dev/guides/environment-variables/#reading-environment-variables-from-env-files)

Missing keys fail the workflow immediately with an explicit key name.

### Deployment Runbook: Cold-Start and DB Availability

If a deploy is running against a fresh host (or after removing previous non-swarm containers), `<stack>_db` and `<stack>_default` may not exist yet. In that case, waiting for Postgres before any stack deploy will fail forever because there is no DB service to reach.

The deploy workflow handles this by always applying the stack configuration
before migrations:

- On existing stacks, the pre-migration deploy uses the currently running app
  image tag so infrastructure/config changes are applied while app code remains
  on the old release. The migration quiesce overlay sets `worker` to zero so
  that old release cannot run its startup migration against a database that the
  requested image will advance. The CDC quiesce overlay also sets
  `analytics-worker`, `metric-stream-clickhouse-sink`, and
  `processing-reconciliation` to zero so all three remain stopped until the
  final stack deploy.
- On clean-slate hosts, the pre-migration deploy uses the requested deploy tag
  because there is no old release to preserve; the migration quiesce overlay
  still keeps `worker` stopped until the one-shot migration completes, and the
  CDC quiesce overlay keeps `analytics-worker`,
  `metric-stream-clickhouse-sink`, and `processing-reconciliation` stopped.
- After the pre-migration stack apply, the workflow waits for Postgres and
  ClickHouse, runs migrations, and then performs the pruned deploy with the
  requested image tag while `analytics-worker`,
  `metric-stream-clickhouse-sink`, and `processing-reconciliation` remain
  quiesced. The final stack deploy restores all three.

This preserves migration gating while remaining safe for both warm updates and scratch deployments.

### Deployment Runbook: Traefik Subdomain 404

For a `404 page not found` on an active Traefik route, use:

- `docs/traefik-subdomain-404-runbook.md`

### Deployment Runbook: Stale ClickHouse Body Measurements

If a recent body measurement is missing from ClickHouse-backed reads, use:

- `docs/clickhouse-body-measurement-staleness-runbook.md`

## Management UIs

The base stack defines Portainer, Netdata, Databasus, CloudBeaver, pgAdmin, and
PeerDB UI services and routes. Databasus remains active because it owns the
PostgreSQL backup schedule. `deploy/stack.oracle.yml` sets the other management
services to zero replicas in production, so a DNS response or Traefik 404 for
one of their historical hostnames does not mean that UI should be running.
