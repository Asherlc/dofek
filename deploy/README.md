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
  - **Redpanda**: Runs internally in the swarm as the hot ingest log for high-volume `metric_stream` events. Separate legacy, live, and history ClickHouse sink services consume their designated topics, and matching Redpanda Connect services archive them to R2; see the [route contract](../docs/metric-stream-redpanda-r2-runbook.md#required-services).
  - **PeerDB**: Runs internally in the swarm as the Postgres-to-ClickHouse CDC service for lower-volume raw fitness tables into `postgres_fitness.*`.
  - **Volume**: Production uses the OCI data volume mounted at `/mnt/dofek-data`.
  - **DB data path**: The `db` service bind-mounts Postgres data to `/mnt/dofek-data/postgres`.
  - **Operational UI state**: Databasus remains enabled because it owns the
    PostgreSQL backup schedule. CloudBeaver and the other optional management
    UIs are scaled to zero by the Oracle production override.
  - **S3 (R2)**: Cloudflare R2 buckets for training data
    (`dofek-training-data`), private direct file imports (`dofek-imports`), web
    build assets (`dofek-web-assets`), OTA updates (`dofek-ota-releases`), Storybook
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
- ClickHouse runs the pinned `26.6.1.1193-alpine` stable image with a 13 GiB container memory limit, a 1.5 CPU Swarm limit, and a checked-in `clickhouse_memory_limits_13g` profile with a 13 GiB `max_server_memory_usage` cap so large analytics queries fail or throttle inside ClickHouse instead of triggering host-level OOM kills or CPU-starving SSH/Docker on the single-node host. Version 26.6 is required for the provider-deletion live-candidate projection to stop an ordered read at its batch limit; ClickHouse 26.3 selected the same projection but read the provider's entire qualifying range. The pinned release is published by ClickHouse: <https://github.com/ClickHouse/ClickHouse/releases/tag/v26.6.1.1193-stable>. Docker defines `deploy.resources.limits.cpus` as the maximum CPU allocation: <https://docs.docker.com/reference/compose-file/deploy/#cpus>. The service also loads checked-in server profile settings from `deploy/clickhouse/users.d/` and server settings from `deploy/clickhouse/config.d/`; the production stack mounts these as Docker Swarm configs so app-managed geospatial `Nullable(Point)` columns, bounded memory, and seven-day system-log TTL retention work without manual server changes. Docker Swarm config contents are immutable, so changing a checked-in config file must also rotate the config key in `deploy/stack.yml` (for example `clickhouse_memory_limits_13g`) instead of reusing the same config name with new contents.
- The default ClickHouse profile cancels read-only HTTP queries when their client disconnects and applies a four-minute elapsed-time ceiling to every query. This keeps a timed-out web/dbt client from leaving server work alive across later retry cycles; ClickHouse documents both [`cancel_http_readonly_queries_on_client_close`](https://clickhouse.com/docs/operations/settings/settings#cancel_http_readonly_queries_on_client_close) and the elapsed-time behavior controlled by [`max_execution_time`](https://clickhouse.com/docs/operations/settings/settings#max_execution_time) with `timeout_before_checking_execution_speed=0`.
- All production entrypoint modes that run dbt build the ordered activity and sleep/dashboard model groups with `--threads 1` to avoid concurrent or unsafe ClickHouse model builds on the single-node host. `analytics-worker` also has a 0.5 CPU Swarm limit and currently runs the dbt-native microbatched `sensor_scalar_sample` and `deduped_sensor` models plus the dirty-keyed dashboard and cycling serving models every 15 minutes. `analytics.activity_summary` is served from the incremental `analytics.activity_summary_rows` table through a thin view; `analytics.cycling_activity` and `analytics.daily_cycling` serve the cycling page; and `analytics.daily_recovery`, `analytics.daily_strain`, `analytics.daily_sleep`, and `analytics.weekly_healthspan` serve dashboard recovery, strain, sleep, and healthspan reads. After both dbt groups succeed, the analytics worker sequentially refreshes every live app query cache key registered in Redis, preserving the previous cached value unless recomputation succeeds. The worker's loopback `/readyz` endpoint exposes the current step, last failure, and last successful cycle; Swarm probes that endpoint instead of process liveness. A first-cycle failure is unhealthy immediately. While idle, a previous success becomes unhealthy when its age exceeds the configured build interval plus retry delay; while a cycle is running, that same budget is measured from the current cycle's start so the normal interval does not consume its execution watchdog. Failed model builds and cache refreshes are captured by Sentry with their failing step before entering the bounded retry path, so retries remain recovery rather than the health signal. Docker documents healthcheck exit-status behavior, dbt documents `build` as running selected models and their tests, Sentry documents captured exceptions, and Redis documents TTL-based key expiration: <https://docs.docker.com/reference/dockerfile/#healthcheck>, <https://docs.getdbt.com/reference/commands/build>, <https://docs.sentry.io/platforms/javascript/guides/node/usage/#capturing-errors>, and <https://redis.io/docs/latest/commands/expire/>. The `cdc-health` service runs `scripts/check-clickhouse-cdc.ts` every five minutes and atomically records the latest result. Its container probe fails after two consecutive failed reports or when the state is more than one interval plus 60 seconds old, so PeerDB slot loss, stale mirrors, and a stuck monitor become visible to Swarm instead of being hidden behind process liveness. Docker documents that a container becomes unhealthy after the configured consecutive probe failures and that Swarm replaces a task whose container fails its healthcheck: <https://docs.docker.com/reference/dockerfile/#healthcheck> and <https://docs.docker.com/engine/swarm/how-swarm-mode-works/services/#tasks-and-scheduling>.
- Reconciled datasets request an immediate analytics build through the shared
  `analytics-refresh` queue. Periodic maintenance requests use that same queue;
  there is no additional interval sleep after a successful build. Pending
  requests combine until processing begins, and requests arriving during a
  build form one subsequent batch. BullMQ's
  [deduplication pattern](https://docs.bullmq.io/patterns/deduplication) and
  [global concurrency](https://docs.bullmq.io/guide/queues/global-concurrency)
  keep these scheduled and immediate builds sequential. See the
  [processing-status runbook](../docs/processing-status-runbook.md).
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
- PeerDB uses an internal catalog Postgres service, Temporal, worker services, and a private SeaweedFS S3 staging bucket (service hostname `peerdb-minio`). Its persistent catalog and staging data live under `/mnt/dofek-data/peerdb-catalog` and `/mnt/dofek-data/peerdb-minio`. The catalog uses the PostgreSQL 18 image layout: mount the host directory at `/var/lib/postgresql`, not `/var/lib/postgresql/data`, so the image can manage its versioned data directory. Production mirrors use 100,000-row CDC batches and single-worker 100,000-row initial snapshot partitions so PeerDB can stay inside its fixed memory limits at the cost of slower catch-up.
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
- Logs use `dofek-logs`, with metadata grouped into the `attributes.custom` map;
  traces use `dofek-traces`. Axiom requires a dedicated dataset per OTel signal:
  [OTel ingestion](https://axiom.co/docs/send-data/opentelemetry). Both retain
  data for 29 days; see the [Axiom runbook](../docs/axiom-observability-runbook.md)
  for map configuration, query paths, and field-limit diagnosis.

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
- The deployment resolves the requested app tag once to a manifest digest.
  `APP_IMAGE` is the resulting full immutable reference, required when rendering
  the production stack. Asset extraction, migrations, readiness/CDC operations,
  and the requested-image rollouts all consume that reference. Docker documents
  [digest pinning](https://docs.docker.com/reference/cli/docker/image/pull/#pull-an-image-by-digest-immutable-identifier)
  and the [registry manifest descriptor](https://docs.docker.com/reference/cli/docker/buildx/imagetools/inspect/#json-output).
- `docker stack deploy` is the only production rollout command for web deploys. It updates `web` and `worker` together from `deploy/stack.yml`.
- Swarm rollback is **image rollback only**. It does not roll back database schema changes that were already applied.
- Migrations run after the non-pruning pre-migration stack apply and after the
  existing PeerDB mapping identities have been reconciled and checked against
  the still-old source and destination schemas. Preparation does not add new
  table mappings. After Postgres/ClickHouse migrations and publication setup,
  CDC setup applies the full mapping contract, including newly created tables.
  Deployment then validates the
  final schema and requires exact processing markers to cross every
  marker-bearing mirror before restoring ClickHouse consumers. PeerDB documents
  its pause/edit/resume behavior in the [mirror editing guide](https://docs.peerdb.io/features/edit-mirror)
  and its state-change API in the [state-change reference](https://docs.peerdb.io/peerdb-api/endpoints/change-mirror-state).
  See the [CDC deploy boundary and interrupted-addition recovery procedure](../docs/clickhouse-read-model-deploy-runbook.md#known-failure-new-peerdb-table-added-before-its-migration).

### Production Secrets

Production secrets are stored in Infisical and rendered by CI into a temporary
`.env.<env>` control-plane file on the runner; the file is not stored on the
server. CI validates that complete export, then renders mode-`0600` allowlisted
files for `web`, `worker`, `analytics-worker`, `cdc-health`, `collector`, and
all six metric-stream sink/archive services, and one-shot database, CDC, and
R2 operations. Each service or operation receives only its own file; the OTA
service receives its explicit stack environment. Docker documents that `env_file` is set per Compose service, and
Infisical documents templated CLI exports:
[Docker service environment files](https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/),
[Infisical CLI export](https://infisical.com/docs/cli/commands/export).
Required app, database, ClickHouse, PeerDB, export, and mobile pipeline keys are
listed in the deploy steps and mobile CI sections below. Missing required keys
must fail the workflow before rollout.

The renderer also creates `web-pre-migration.env` for the canonical dependency
apply, which can still run the previously deployed web image. This artifact
contains the normal web environment plus `METRIC_STREAM_TOPIC` derived strictly
from `METRIC_STREAM_LEGACY_TOPIC`. The workflow selects it with a command-scoped
`WEB_ENV_FILE` assignment for that apply only; both requested-image deployment
phases use `web.env`, whose producer contract contains only live/history keys.
The explicit live/history values remain in the migration artifact for clean-slate
deploys that already use the requested image. No generic producer key is required
in Infisical. See the [renderer](../scripts/deploy-service-environment.ts) and
[workflow](../.github/workflows/deploy-web-stack.yml); Bash documents the scope of
[command-prefixed environment assignments](https://www.gnu.org/software/bash/manual/html_node/Environment.html).

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
              -> compare deployed/requested image migration histories; select rolling or maintenance
              -> non-pruning stack apply with analytics-worker, all metric-stream ClickHouse sinks, and processing-reconciliation quiesced
              -> wait for quiesced tasks to stop (also web in maintenance mode)
              -> wait for Postgres, ClickHouse, and PeerDB
              -> reconcile live PeerDB mappings; validate the old destination schema
              -> migrate requested image on <stack>_default
              -> prune deploy requested image with analytics-worker, all metric-stream ClickHouse sinks, and processing-reconciliation quiesced
              -> wait for app convergence and Postgres; run cutover
              -> wait for ClickHouse, PeerDB, and Temporal; configure CDC
              -> validate the final schema; write and observe exact causal markers
              -> final deploy restores analytics-worker, all metric-stream ClickHouse sinks, and processing-reconciliation
              -> verify backup freshness and record Sentry release
```

Production web deployments are serialized and never cancel an in-progress
deployment. Automatic and manual triggers share the same production concurrency
group, using GitHub's default single pending run. New requests replace pending
work while the active deployment finishes. A rollout intentionally quiesces
`analytics-worker`,
all three metric-stream ClickHouse sinks, and `processing-reconciliation` before
migrations and restores all five only after the final stack converges, so a
newer run must wait rather than interrupt that state transition. After acquiring
the deployment slot, automatic runs fetch the current `main` branch with full
history, walk its first-parent commits newest first, and check the CI workflow's
successful runs for each exact `head_sha`. The first passing commit is selected;
the triggering commit bounds the search so an API response cannot roll a release
back to an older commit. Each returned run must match the queried commit and be
a successful `main` push. This uses one API call per candidate and avoids relying
on a broad run list's recency. Git documents
[first-parent traversal](https://git-scm.com/docs/git-rev-list), and checkout documents
[full history fetching](https://github.com/actions/checkout#fetch-all-history-for-all-tags-and-branches).
A newer untested commit does not block that release,
and an older CI completion cannot select an older image than the latest passing
release. The selected commit and CI run are recorded in the workflow summary.
GitHub documents the default
[pending-run replacement](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
and the [workflow-run API](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow).

Requests triggered by unsuccessful CI use an isolated concurrency group so they
cannot replace valid pending production work. They cancel their own workflow
before deployment and retain a nonzero step result while cancellation is
processed. Superseded pending requests are cancelled by GitHub concurrency;
inspect the server deployment job to confirm the rollout outcome. GitHub documents
the cancellation API and its required Actions write permission:
<https://docs.github.com/en/rest/actions/workflow-runs#cancel-a-workflow-run>.
For a reported stale page, compare the live HTML's `web/<tag>/` asset prefix with
the selected workflow tag, verify the running Swarm image digest matches the
resolved `APP_IMAGE`, and inspect the production job's actual conclusion in the
[canonical deployment workflow](../.github/workflows/deploy-web-stack.yml).

### Checking the Latest Production Deployment

Start with the parent [Deploy Web workflow](../.github/workflows/deploy-web.yml),
which calls the environment and stack workflows. Listing only
`deploy-web-stack.yml` runs can return old standalone runs and miss deployments
inside parent runs. GitHub describes how called jobs appear in the caller's run
in its [reusable workflow documentation](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows).

```bash
gh api repos/Asherlc/dofek/actions/workflows/deploy-web.yml \
  --jq '{name, state, updated_at, html_url}'
gh run list --repo Asherlc/dofek --workflow deploy-web.yml --limit 10
gh run view RUN_ID --repo Asherlc/dofek --json jobs
```

If passing main CI runs have no subsequent deployment, check the workflow's
`state` before investigating a queue. `disabled_manually` means automatic
deployment is disabled; `updated_at` alone does not identify who disabled it or
why. GitHub documents [workflow state](https://docs.github.com/en/rest/actions/workflows#get-a-workflow)
and [disabling workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows).

Confirm the live image and each running web container's revision using read-only
inspection. Print only the selected fields, never the complete container
environment:

```bash
ssh dofek-server 'docker service inspect dofek_web \
  --format "{{.UpdatedAt}} {{.Spec.TaskTemplate.ContainerSpec.Image}}"'
ssh dofek-server 'docker service ps dofek_web --no-trunc'
ssh dofek-server 'docker ps -q --filter label=com.docker.swarm.service.name=dofek_web \
  | xargs -r docker inspect \
  | jq '\''map({startedAt: .State.StartedAt,
    revision: .Config.Labels["org.opencontainers.image.revision"],
    release: [.Config.Env[] | select(startswith("SENTRY_RELEASE="))]})'\'''
```

Container start times and service update times are supporting evidence, not proof
of a completed deployment: tasks can restart and service specifications can
change independently. Correlate the live revision and digest with the parent
run's selected release and server stack job. Report the server job's completion
time separately from container start times, OTA publication, signed iOS upload,
and the overall run conclusion. Automatic `Deploy Web` runs also publish matching
mobile releases after the server succeeds; manual mobile releases use the
separate [Deploy workflow](../.github/workflows/deploy.yml).
See the [web deployment jobs](../.github/workflows/deploy-web.yml)
and Docker's [service inspect](https://docs.docker.com/reference/cli/docker/service/inspect/)
and [container inspect](https://docs.docker.com/reference/cli/docker/container/inspect/)
references.

Automatic `Deploy Web` runs publish mobile OTA updates and check whether a signed
iOS build is needed after a successful server rollout. Manually dispatched
`Deploy Web` runs deploy only the server. Explicit mobile releases remain available
through the [Deploy workflow](../.github/workflows/deploy.yml) with target `ota`,
`ios`, or `all`. Both release paths complete the matching server
rollout before publishing and pass the server image's validated
`SENTRY_RELEASE` commit to the selected reusable mobile publishers. Each publisher
checks out that exact commit. A failed or cancelled server rollout prevents
publishing. GitHub documents reusable workflow
[outputs](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows#using-outputs-from-a-reusable-workflow)
and job [dependencies](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds).

The stack workflow reports that commit from a separate job after the rollout
succeeds, using the same checkout that the image resolver requires to match
the immutable image's `SENTRY_RELEASE`. This job does not load deployment
secrets: the deploy runner masks exported dotenv values, and GitHub suppresses
job outputs matching those masks. Both mobile publishers reject an empty or
malformed commit before checkout. For current runs, check the Report deployed
source commit job and its output evaluation. Runs before this fix may instead
show `Skip output 'commit_sha' since it may contain secret` in the deploy job;
see GitHub's
[masking semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#masking-a-value-in-a-log).

After rollout, OTA publication performs one
[manifest validation](../scripts/check-ota-manifest.ts). An unavailable or invalid
manifest stops publication before upload, including when a transient request
failure causes the check to fail. Inspect the failed check and server availability,
address the cause, then rerun the failed publication job; the check does not retry
or conceal an unavailable server. GitHub supports rerunning a
[specific failed job](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs#re-running-a-specific-job-in-a-workflow).

Mobile publisher calls do not inherit repository secrets. Runtime credentials
come from the existing [Infisical OIDC action](../.github/actions/load-infisical-secrets/action.yml);
GitHub automatically supplies the scoped `GITHUB_TOKEN` to reusable workflows,
as documented in its [reusable workflow context](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#github-context).

For a manual mobile release, dispatch **Deploy** (`deploy.yml`) with target `ota`
or `ios` from the desired source ref. Without an `image_tag`, the workflow builds
and deploys that commit's server image before publishing the selected mobile
release. Target `all` publishes both mobile releases after the server. When
reusing an existing `image_tag`, select its matching source ref in the dispatch:
the immutable image's `SENTRY_RELEASE` must equal the checked-out source commit,
or deployment fails before migrations. The OTA, signed iOS, and stack workflows
are reusable only. For a server-only manual rollout, dispatch **Deploy** with
target `web` (including infrastructure) or `web-stack` (stack only).
Automatic and manual server/mobile releases share the production concurrency
group until publishing completes, using GitHub's
[workflow concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
and [manual workflow ref selection](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

Signed iOS builds and uploads run in separate macOS jobs, each with a 30-minute
limit. The archive job packages the signed `.xcarchive` in a tar file to preserve
bundle permissions and symlinks, and retains it for seven days. The upload job
downloads that exact artifact by ID, including on an upload-only rerun, and
exports/uploads it without rebuilding. After artifact expiry, rerun the archive
job and its dependent jobs to create a fresh build; an upload-only rerun cannot
recover an expired archive. GitHub documents
[passing artifacts between jobs](https://docs.github.com/en/actions/tutorials/store-and-share-data#passing-data-between-jobs-in-a-workflow)
and preserving file permissions with a
[tar archive](https://github.com/actions/upload-artifact#permission-loss).

Signed iOS publishing uses GitHub deployments with environment `testflight` and
task `testflight-upload`. Immediately before Xcode export/upload, it creates a
pending deployment for the actual source SHA, build number and original upload
attempt. After the upload succeeds, a separate job marks that same deployment
successful. The uploader checks for unresolved attempts again before creating
its record, including when only that job is rerun. Newer unresolved attempts
block automatic and manual publication, including forced builds; only an
explicitly reconciled `inactive` record is skipped. The
[native release helper](../scripts/testflight-deployment.ts) owns this lifecycle;
GitHub supports multiple statuses on the
[same deployment](https://docs.github.com/en/rest/deployments/statuses#about-deployment-statuses).

Automatic releases compare native inputs with the latest successfully uploaded
revision, including rollback targets, and skip an already-uploaded SHA. No prior
successful receipt selects a first build; unavailable or malformed evidence
fails the check. Manual `ios` and `all` requests force a signed build after the
unresolved-attempt check. Apple
[processing and tester availability](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/)
follow upload separately. History reads fetch bounded pages in descending
creation order and inspect each deployment's latest status, stopping at the first
successful upload or unresolved attempt. Older pages are fetched only when
needed; the entire history is never collected into one response. See GitHub's
[deployment fields and ordering](https://docs.github.com/en/graphql/reference/deployments#deployment)
and [cursor pagination](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api).
Receipt reads use `deployments: read`; the uploader and finalizer receive
`deployments: write`. GitHub documents deployment
[creation](https://docs.github.com/en/rest/deployments/deployments#create-a-deployment)
and [status reporting](https://docs.github.com/en/rest/deployments/statuses#create-a-deployment-status).

If upload succeeds but finalizing its receipt fails, rerun only **Record
successful TestFlight upload**, using `gh run rerun --job <record-job-id>` or the
job's rerun control. This reuses the original deployment ID and upload evidence;
it does not upload another binary. Finalization preserves an operator's `inactive`
reconciliation and leaves an already-successful record unchanged. GitHub documents
[specific-job reruns](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs#re-running-a-specific-job-in-a-workflow).

If the uploader fails or is cancelled after creating its pending record, inspect
the original run and match its exact version/build number in App Store Connect.
Before changing its receipt manually, wait for or stop the original finalizer
job so reconciliation does not compete with an active status write.
A failed upload command alone does not prove that Apple rejected the binary.
When upload is confirmed, finalize that original deployment as successful.
The [release CLI](../scripts/testflight-deployment-cli.ts) validates its stored
identity before finalization:

```bash
pnpm tsx scripts/testflight-deployment-cli.ts record <owner/repo> <deployment-id> <full-source-sha> <build-number> <original-upload-attempt-url>
```

Only after confirming that upload never occurred, append an `inactive` status
to that deployment with an explanation and the original run URL. Use the
[deployment status endpoint](https://docs.github.com/en/rest/deployments/statuses#create-a-deployment-status)
with `auto_inactive: false`; do not create a replacement record or clear an
uncertain attempt based only on its job conclusion. An unresolved record remains
a visible release blocker until this reconciliation is complete. Absence from
App Store Connect while processing is uncertain does not establish that no upload
occurred; retain the pending record when the evidence is inconclusive.

1. **Build**: GitHub Actions builds the `server` image for every `main` push and pushes it to GHCR with the commit-derived tag (`<tag>`). A successful main CI completion requests deployment; when its slot starts, `Deploy Web` selects the latest passing main push and resolves that tag to the immutable image it deploys. The web build inside the image uses `VITE_ASSET_BASE_URL=https://assets.dofek.fit/web/<tag>/`, so Vite-generated JavaScript and CSS references point at immutable R2-backed CDN assets instead of the Express origin; Vite's `base` option controls the public base path for built assets: https://vite.dev/config/shared-options.html#base. `<tag>` is the image tag used consistently for both the GHCR image and the web asset prefix. See GitHub's `workflow_run` event documentation for the trigger behavior: https://docs.github.com/en/actions/reference/events-that-trigger-workflows#workflow_run. The `ml` image is built only when ML image inputs change.
   Automatic deploys check out the selected CI run's full commit SHA for both
   Terraform and stack configuration. GitHub documents that a
   `workflow_run` workflow's `GITHUB_SHA` is the last commit on the default
   branch rather than necessarily the selected release's commit, so using
   the selected run's `head_sha` as the deploy commit keeps image code,
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
      - App Store subscription verification and Notifications V2 require
        `APP_STORE_ISSUER_ID`, `APP_STORE_KEY_ID`, `APP_STORE_PRIVATE_KEY`,
        `APP_STORE_APP_ID`, `APP_STORE_BUNDLE_ID`,
        `APP_STORE_SUBSCRIPTION_PRODUCT_ID`, and
        `APP_STORE_ROOT_CERTIFICATES_PEM` in the web service environment.
        `APP_STORE_SUBSCRIPTION_PRODUCT_ID` must be
        `com.dofek.premium.monthly`; `APP_STORE_APP_ID` is the positive numeric
        Apple ID for the app; and the bundle ID must match the signed app.
        Preserve the In-App Purchase private key and Apple root-certificate
        chain as multiline Infisical values, never checked-in values. Apple
        makes an In-App Purchase private key available for download only once
        and says it must not be stored in a source repository:
        [App Store Server API key setup](https://developer.apple.com/documentation/appstoreserverapi/creating-api-keys-to-authorize-api-requests).
        The server names any missing variable when the App Store configuration
        is loaded; release validation must call an App Store billing path after
        deploy and before attaching the subscription to an App Store review.
      - Configure both the production and sandbox App Store Server
        Notifications URLs as `${PUBLIC_URL}/api/webhooks/app-store`, selecting
        Notifications V2 for each. Apple otherwise sends sandbox notifications
        to the production URL when no sandbox URL is present:
        [enter server URLs for App Store Server Notifications](https://developer.apple.com/help/app-store-connect/configure-in-app-purchase-settings/enter-server-urls-for-app-store-server-notifications).
      - Must include `REDPANDA_BROKERS`, `METRIC_STREAM_LEGACY_TOPIC`,
        `METRIC_STREAM_LIVE_TOPIC`, and `METRIC_STREAM_HISTORY_TOPIC`. Web and
        worker producers receive only the live/history route keys. The renderer
        maps each sink/archive's designated route key to its internal
        `METRIC_STREAM_TOPIC` and sets a distinct `METRIC_STREAM_CONSUMER_GROUP`
        matching its service name. The legacy services retain their existing
        topic and group so committed offsets remain attached to those identities;
        [Redpanda Connect documents group offset resumption](https://docs.redpanda.com/connect/components/inputs/redpanda/#consumer-groups).
        Create and verify all three explicit topic keys in the production
        Infisical environment before deployment; a generic topic cannot satisfy
        a missing route. See the [route table](../docs/metric-stream-redpanda-r2-runbook.md#required-services).
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
   4. Resolve `ghcr.io/asherlc/dofek:<tag>` to its registry manifest digest with
      `scripts/resolve-deploy-image.ts`, then pull and inspect that immutable
      reference on the remote Docker daemon. Its full `SENTRY_RELEASE` must
      equal the checked-out commit. The resolver retains the existing web
      service's complete desired digest reference for the pre-migration phase;
      an existing tag-only reference fails instead of being resolved again.
      Docker's [stack deployment](https://docs.docker.com/reference/cli/docker/stack/deploy/)
      normally resolves tags against the registry, so every subsequent command
      receives the selected digest. Stack interpolation sets the derived
      `APP_IMAGE` after loading dotenv, preventing exported configuration from
      replacing it. The workflow then validates the rendered stack files.
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
      detached `docker stack deploy`, the temporary five-service quiesce
      overlay, and the migration quiesce overlay. On existing stacks
      this preserves the web service's complete desired image digest, so database, ClickHouse,
      network, config, and resource-limit changes are applied before migrations
      without rolling new app code ahead of schema changes. The overlays keep
      `analytics-worker`, all three metric-stream ClickHouse sinks,
      `processing-reconciliation`, and the migration-running `worker` at zero
      replicas during the migration window; see the
      [worker entrypoint](../entrypoint.sh). On clean-slate hosts the
      stack apply uses the requested immutable image so the DB service and overlay network
      exist before readiness checks. After migrations, the workflow deploys the
      requested app image with only the five-service quiesce overlay still applied,
      which restores `worker` using the same image that ran the migrations while
      `analytics-worker`, all three metric-stream ClickHouse sinks, and
      `processing-reconciliation` remain stopped until the final stack deploy.
      Migrations whose first line is `-- dofek: deployment-mode=maintenance`
      also apply `stack.maintenance.yml`, stopping web before the schema changes.
      The workflow compares the requested image's journal with the deployed web
      image's journal, so a retry after a committed migration still selects
      maintenance until the app image advances. Missing or divergent image
      histories fail before the stack apply. Fresh stacks use maintenance mode.
      The maintenance apply records the requested journal's final tag in web's
      `dofek.migration-maintenance-target` service label. A subsequent request
      must include that boundary, so an older release cannot restart old readers
      after the database advances. The matching-image apply removes the label;
      rollback restores it with the stopped old specification. Docker documents
      [service labels](https://docs.docker.com/reference/compose-file/deploy/#labels).
      Before any migration, CI verifies zero desired replicas and terminal
      actual task states for every quiesced service, allowing the worker's
      30-minute graceful drain to finish. A desired shutdown alone does not prove
      that a task stopped; see [Swarm task states](https://docs.docker.com/engine/swarm/how-swarm-mode-works/swarm-task-states/).
      The old web and worker specifications remain at zero until migrations
      succeed, so Swarm rollback restores a stopped specification. A maintenance
      rollout failure fails immediately and leaves consumers gated; rerun the
      canonical workflow with the matching release rather than restoring the old
      image. Docker documents [service rollback](https://docs.docker.com/reference/cli/docker/service/rollback/)
      and [stack overlay application](https://docs.docker.com/reference/cli/docker/stack/deploy/).
      The deploy workflow waits explicitly for Postgres and ClickHouse instead
      of keeping a long-lived Docker-over-SSH stack-deploy wait open while the
      single-node host restarts services.
      At convergence, `scripts/verify-deploy-image.ts` checks each app service's
      desired manifest identity, desired replica count, and every running task's
      image reference. An optional tag does not change the repository/digest
      identity; a local image configuration ID is not a manifest digest. Docker
      describes the service/task relationship in
      [Swarm services and tasks](https://docs.docker.com/engine/swarm/how-swarm-mode-works/services/).
   8. Wait until Postgres is writable (`SELECT NOT pg_is_in_recovery()`) and
      ClickHouse answers `/ping`; wait for PeerDB SQL and its Flow API, then
      run `peerdb-cdc-contract prepare` against existing mapping identities
      only. Apply registered additive `pre-cdc` destination migrations and
      preserve existing projection checks; defer every new table mapping until
      its source, destination, and publication membership exist.
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
   11. `docker stack deploy -c deploy/stack.yml -c deploy/stack.cdc-quiesce.yml --with-registry-auth --prune --detach=true <stack>` — swarm rolls out the requested app image while keeping `analytics-worker`, all three metric-stream ClickHouse sinks, and `processing-reconciliation` at zero replicas, and CI polls the key services until their desired replicas are running and any update state is complete. The migration-only overlay is used only by the pre-migration apply to keep the old worker from starting against a newer migration journal. The deploy workflow bounds this initial wait at 35 minutes so the worker's 30-minute graceful-drain contract can complete while a wedged Swarm rollback still fails CI. The final rollout restoring `analytics-worker`, all three metric-stream ClickHouse sinks, and `processing-reconciliation` remains bounded at 20 minutes.
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
       the fitness-raw, provider-inventory, and sensor-priority mirrors. It
       configures publication membership before reconciling the full mapping
       contract, including new mappings. Finalize then validates the full schema
       and writes causal markers; verify requires those exact markers in each
       mirror's assigned destination before consumers can resume. See the
       [checked-in CDC setup](../src/db/clickhouse-cdc.ts) and
       [contract deployment](../src/db/peerdb/mirror-deployment.ts).
   15. Run the final `docker stack deploy -c deploy/stack.yml ...` to restore
       `analytics-worker`, all three metric-stream ClickHouse sinks, and
       `processing-reconciliation` only when every post-quiesce readiness step
       and ClickHouse CDC setup succeeds. If a prerequisite fails, the workflow
       leaves all five services at zero replicas and reports that the operator
       must resolve the failed step and rerun the deployment. After restoration,
       each of the five services and the three metric-stream R2 archive services
       must keep the same Swarm task at `1/1` continuously for 60 seconds. The
       [workflow](../.github/workflows/deploy-web-stack.yml) checks all eight
       services serially; a replacement task or any
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
- Prefer expand/contract for schema changes: deploy additive/backward-compatible
  schema first, then ship dependent code and remove old schema in a later release.
  An approved schema-breaking migration must carry the maintenance marker above
  so the canonical workflow stops old readers and writers before applying it.
  Maintenance includes an availability interruption; do not roll back to the
  removed schema's app image after migration. See Docker's
  [rollback boundary](https://docs.docker.com/reference/cli/docker/service/rollback/).

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

- `.github/workflows/cleanup-pr-r2.yml` waits for the same PR’s mobile publication through [GitHub workflow concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency), loads required identity before deleting, then removes `pr-<number>/` objects from `dofek-storybook` and `<app-id>/pr-<number>/` objects from `dofek-ota-releases` when the PR closes. Both deletions can be rerun safely using [AWS recursive removal](https://docs.aws.amazon.com/cli/latest/reference/s3/rm.html). The historical `dofek-ota` bucket remains untouched.
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
- `EXPO_APP_ID` (the [PR preview workflow](../.github/workflows/mobile-preview-ota.yml)
  links each preview channel to this existing Expo project; the OTA server
  also requires the identifier in its
  [application configuration](https://github.com/mercuretechnologies/xprem/blob/main/config/apps.go))
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

The [deploy workflow](../.github/workflows/deploy-web-stack.yml) handles this by
always applying the stack configuration before migrations, using the immutable
references selected by the [image resolver](../scripts/resolve-deploy-image.ts):

- On existing stacks, the pre-migration deploy uses the web service's existing
  desired image digest reference so infrastructure/config changes are applied
  while app code remains on that release. The migration quiesce overlay sets `worker` to zero so
  that old release cannot run its startup migration against a database that the
  requested image will advance. The CDC quiesce overlay also sets
  `analytics-worker`, all three metric-stream ClickHouse sinks, and
  `processing-reconciliation` to zero so all five remain stopped until the
  final stack deploy.
- For a pending maintenance-marked schema boundary, the pre-migration apply
  additionally stops web and verifies that all quiesced tasks actually exit.
  Selection uses the deployed image journal, including when the database already
  committed the migration during an earlier failed deployment. The web service's
  maintenance-target label rejects older release requests until a matching image
  replaces it. See the
  [canonical workflow](../.github/workflows/deploy-web-stack.yml) and Docker's
  [task-state lifecycle](https://docs.docker.com/engine/swarm/how-swarm-mode-works/swarm-task-states/).
- On clean-slate hosts, the pre-migration deploy uses the requested immutable
  image (`APP_IMAGE`) because there is no old release to preserve; the migration quiesce overlay
  still keeps `worker` stopped until the one-shot migration completes, and the
  CDC quiesce overlay keeps `analytics-worker`,
  all three metric-stream ClickHouse sinks, and `processing-reconciliation` stopped.
- After the pre-migration stack apply, the workflow waits for Postgres and
  ClickHouse, runs migrations, and then performs the pruned deploy with the
  requested immutable image (`APP_IMAGE`) while `analytics-worker`,
  all three metric-stream ClickHouse sinks, and `processing-reconciliation` remain
  quiesced. The final stack deploy restores all five.

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

## Activity image storage

Provider activity image originals use the private `dofek-activity-media` R2
bucket declared in `storage.tf`, selected by `ACTIVITY_MEDIA_R2_BUCKET`, which
`stack.yml` sets on web and worker. Provision the bucket through Terraform
before deploying image acquisition. Reuse the existing Infisical credentials
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` with the configured `R2_ENDPOINT`.
The media bucket has no
age-based expiry or public domain. Access uses authenticated, five-minute
signed GET URLs; treat those URLs as bearer credentials
([Cloudflare presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)).
Account erasure must remove the user's complete `images/<user-id>/` prefix.
