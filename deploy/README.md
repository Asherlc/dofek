# Infrastructure and Deployment

Infrastructure-as-code and deployment configuration for Dofek.

## Architecture

Dofek production is deployed as a **single-node Docker Swarm** stack on Oracle Cloud Infrastructure (OCI) Always Free with **Cloudflare** for DNS, R2 storage, and CDN. Hetzner-backed production, staging, and PR review-app infrastructure has been retired.

- **Compute**: Production runs on an OCI Ampere A1 ARM64 host provisioned by `deploy/oracle-free/` and addressed through the `ORACLE_SERVER_HOST` GitHub Actions variable. The server runs `dockerd` initialized as a single-node swarm manager and has no deploy scripts or secrets on disk.
- **Storage**:
  - **PostgreSQL**: Managed via TimescaleDB with PostGIS enabled for geospatial metric data.
  - **ClickHouse**: Runs in the swarm as the stored analytics read-model service for heavy activity stream reads. The raw `metric_stream` copy is populated by the Redpanda ClickHouse sink for Redpanda-first sources and remains compatible with tracked ClickHouse migrations and chunk-range backfills. See [docs/clickhouse-metric-stream.md](../docs/clickhouse-metric-stream.md).
  - **Redpanda**: Runs internally in the swarm as the hot ingest log for high-volume `metric_stream` events. The ClickHouse sink service consumes the topic, and Redpanda Connect archives it to R2.
  - **PeerDB**: Runs internally in the swarm as the Postgres-to-ClickHouse CDC service for lower-volume raw fitness tables into `postgres_fitness.*`.
  - **Volume**: Production uses the OCI data volume mounted at `/mnt/dofek-data`.
  - **DB data path**: The `db` service bind-mounts Postgres data to `/mnt/dofek-data/postgres`.
  - **Databasus state path**: The `databasus` service bind-mounts its internal state to `/mnt/dofek-data/databasus` so backup schedules and storage config survive Docker volume churn.
  - **CloudBeaver state path**: The `cloudbeaver` service bind-mounts its workspace to `/mnt/dofek-data/cloudbeaver`, including the Terraform-synced preconfigured Postgres and ClickHouse datasource file.
  - **S3 (R2)**: Cloudflare R2 buckets for training data (`dofek-training-data`), web build assets (`dofek-web-assets`), OTA updates (`dofek-ota`), Storybook (`dofek-storybook`), DB backups (`dofek-db-backups`), and canonical metric-stream replay archives (`dofek-metric-stream-archive`).
- **Networking**:
  - **Firewall**: OCI security lists allow production SSH/HTTP/HTTPS.
  - **DNS**: Cloudflare manages multiple zones: `dofek.fit`, `dofek.live`, and subdomains on `asherlc.com`.
  - **Reverse Proxy**: Traefik handles SSL termination via Let's Encrypt (DNS-01 challenge) and routes traffic based on `Host()` rules declared in `deploy.labels` on each swarm service. Traefik's `providers.swarm` watches the Docker API for service changes.
- **Observability**:
  - **OpenTelemetry**: `otel-collector` gathers traces, logs, and metrics.
  - **Axiom**: Primary destination for structured logs and metrics via OTLP.
  - **Sentry**: Receives application logs/errors.
  - **Netdata**: Real-time server health and performance monitoring.
- **Secrets**: Managed via **Infisical**. CI logs in with OIDC machine identity, renders `.github/templates/infisical-dotenv.tmpl` via `infisical export --template`, and writes a temporary environment-specific `.env.<env>` file on the runner for `docker stack deploy`. The server never stores secrets on disk.

## Implementation Details

### Terraform (`*.tf`)
- `oracle-free/`: Separate Terraform root for the OCI production host. The reserved public IP is copied into the `ORACLE_SERVER_HOST` GitHub Actions variable and into the main `deploy/` root as `var.oracle_server_host`.
- `dns.tf`: Configures Cloudflare DNS records. Root domains (`dofek.fit`, `dofek.live`) are proxied (CDN enabled), while management subdomains (`ota.dofek.asherlc.com`, `portainer.dofek.asherlc.com`) are unproxied for direct access.
- `storage.tf`: Manages Cloudflare R2 buckets, lifecycle rules, the `assets.dofek.fit` bucket-level custom domain, and the CORS policy required for browser module loads from that cross-origin asset hostname. Cloudflare documents R2 custom domains as bucket-level domain bindings, not ordinary origin `CNAME` records, and documents that custom domains return CORS headers only when the bucket has a matching CORS policy: https://developers.cloudflare.com/r2/buckets/public-buckets/#custom-domains and https://developers.cloudflare.com/r2/buckets/cors/#use-cors-with-a-custom-domain. The `storybook.dofek.fit` custom domain is still configured manually in the Cloudflare dashboard.
  The `assets.dofek.fit` custom domain was first restored manually during the
  2026-07-10 production incident, so the first Terraform apply after this
  resource was added must either import/adopt that existing Cloudflare object if
  the provider supports it or remove and recreate it in a controlled apply;
  creating the same R2 custom domain twice returns Cloudflare error `10052`
  (`Domain already in use`).

### Server Configuration (`server/`)
- `cloud-init.yml`: Installs Docker CE, configures Docker log rotation (10m, 3 files), and idempotently runs `docker swarm init`. No deploy helpers, no Infisical CLI.

### Swarm Stack (`stack.yml`)
- Single file defining all services: `web`, `worker`, `analytics-worker`, `cdc-health`, `traefik`, `db`, `clickhouse`, `redpanda`, `metric-stream-clickhouse-sink`, `metric-stream-r2-archive`, `redis`, `collector`, `ota`, `databasus`, `cloudbeaver`, `pgadmin`, `portainer`, `netdata`.
- Traefik consumes the swarm provider and routes traffic from labels declared on stack services.
- Zero-downtime updates for `web` and `worker` are configured via `deploy.update_config` (`order: start-first`, `failure_action: rollback`, healthcheck-gated `monitor` window).
- The worker healthcheck calls the worker process's loopback-only `/readyz` endpoint on port 3001. That endpoint verifies every existing BullMQ Worker's running state and Redis clients; the healthcheck must not start a second Node runtime or construct fresh queue clients inside the worker's 400 MiB cgroup. See the [Docker healthcheck reference](https://docs.docker.com/reference/compose-file/services/#healthcheck) and [BullMQ Worker API](https://api.docs.bullmq.io/classes/v5.Worker.html).
- The `default` overlay network is declared `attachable: true` so CI can run one-shot migration containers on it from a remote Docker context.
- The `db` service has a 2 GiB container memory limit to prevent one PostgreSQL workload from exhausting the single-node host. If it hits that limit, treat it as a query/workload incident rather than increasing the cap by default.
- PostgreSQL runs `timescale/timescaledb-ha:pg18.3-ts2.26.4-all` so TimescaleDB and PostGIS are both available. It is configured with `max_connections=40`, `work_mem=4MB`, `maintenance_work_mem=64MB`, `max_locks_per_transaction=4096` for large Timescale chunk scans, and logical replication settings needed by ClickHouse change-data capture. Production keeps six logical slots/senders and caps each slot at 64 GiB of retained WAL so PeerDB has recovery headroom without allowing an inactive slot to retain unbounded WAL.
- ClickHouse has a 13 GiB container memory limit, a 1 CPU Swarm limit, and a checked-in `clickhouse_memory_limits_13g` profile with a 13 GiB `max_server_memory_usage` cap so large analytics queries fail or throttle inside ClickHouse instead of triggering host-level OOM kills or CPU-starving SSH/Docker on the single-node host. It also loads checked-in server profile settings from `deploy/clickhouse/users.d/` and server settings from `deploy/clickhouse/config.d/`; the production stack mounts these as Docker Swarm configs so app-managed geospatial `Nullable(Point)` columns, bounded memory, and seven-day system-log TTL retention work without manual server changes. Docker Swarm config contents are immutable, so changing a checked-in config file must also rotate the config key in `deploy/stack.yml` (for example `clickhouse_memory_limits_13g`) instead of reusing the same config name with new contents.
- All production entrypoint modes that run dbt use `--threads 1 --select $DBT_SAFE_MODELS` to avoid concurrent or unsafe ClickHouse model builds on the single-node host. `analytics-worker` also has a 0.5 CPU Swarm limit and currently runs the dbt-native microbatched `sensor_scalar_sample` and `deduped_sensor` models plus the dirty-keyed dashboard and cycling serving models every 15 minutes. `analytics.activity_summary` is served from the incremental `analytics.activity_summary_rows` table through a thin view; `analytics.cycling_activity` and `analytics.daily_cycling` serve the cycling page; and `analytics.daily_recovery`, `analytics.daily_strain`, `analytics.daily_sleep`, and `analytics.weekly_healthspan` serve dashboard recovery, strain, sleep, and healthspan reads. After both dbt groups succeed, the analytics worker sequentially refreshes every live app query cache key registered in Redis, preserving the previous cached value unless recomputation succeeds. Failed model builds or cache refreshes enter the bounded retry path instead of being reported as a successful analytics cycle. dbt documents `build` as running selected models and their tests, and Redis documents TTL-based key expiration in its official references: <https://docs.getdbt.com/reference/commands/build> and <https://redis.io/docs/latest/commands/expire/>. The `cdc-health` service runs `scripts/check-clickhouse-cdc.ts` every five minutes so PeerDB slot loss and stale mirrors are continuously reported instead of being discovered only during dashboard debugging.
- Netdata has a 768 MiB container memory limit and a checked-in `deploy/netdata/netdata.conf` that bounds dbengine retention to two tiers: one day of per-second data capped at 96 MiB and seven days of per-minute data capped at 128 MiB. The stack mounts this file as a Docker Swarm config, so changing it must also rotate the config key in `deploy/stack.yml` (for example `netdata_db_limits_v2`).
- PeerDB uses an internal catalog Postgres service, Temporal, worker services, and a private MinIO staging bucket. Its persistent catalog and staging data live under `/mnt/dofek-data/peerdb-catalog` and `/mnt/dofek-data/peerdb-minio`. The catalog uses the PostgreSQL 18 image layout: mount the host directory at `/var/lib/postgresql`, not `/var/lib/postgresql/data`, so the image can manage its versioned data directory. Production mirrors use 100,000-row CDC batches and single-worker 100,000-row initial snapshot partitions so PeerDB can stay inside its fixed memory limits at the cost of slower catch-up.
- Redpanda stores hot `metric_stream` ingest data under `/mnt/dofek-data/redpanda` (a bind mount on the large data disk — a default named volume lands on the small root disk and fills during a metric-stream backfill). Redpanda local retention is not the long-term source of truth; Redpanda Connect writes the `metric-stream-v1` topic to the `dofek-metric-stream-archive` R2 bucket for canonical replay. The ClickHouse sink and R2 archive services must be healthy before any metric-stream writer change is considered deployed safely.
- The historical Postgres `fitness.metric_stream` hypertable has been retired; metric-stream durability is Redpanda plus the R2 archive, and ClickHouse is the serving copy. The `cdc-health` service alerts on remaining PeerDB slot lag at 16 GiB and fails the check at 32 GiB so operators have headroom before Postgres reaches the 64 GiB per-slot WAL cap.
- Slack is forced to HTTP mode in production via `SLACK_MODE=http` on the `web` service. This avoids Socket Mode multi-consumer overlap during rolling deploys when `web` has multiple replicas.
- Management UIs (Portainer, Databasus, CloudBeaver, pgAdmin, PeerDB UI, Netdata) are exposed on dedicated subdomains with TLS termination through Traefik. Protect them at the network layer or with each tool's built-in auth.

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
- Because migrations run before `docker stack deploy`, every production schema change must remain compatible with both the old app version and the new app version during rollout.

### Production Secrets

Production secrets are stored in Infisical and rendered by CI into a temporary
`.env.<env>` file for `docker stack deploy`; the file is not stored on the
server. Required app, database, ClickHouse, PeerDB, export, and
mobile pipeline keys are listed in the deploy steps and mobile CI sections
below. Missing required keys must fail the workflow before rollout.

### Flow Diagram

```text
CI (main) -> build dofek (+ dofek-ml for local ML tooling)
         -> deploy-web production check (dofek app image tag must exist)
         -> deploy-terraform (shared prerequisite)
         -> deploy-web-stack
              -> fetch env via Infisical Secrets Action
              -> pre-migration stack apply without pruning
              -> wait for postgres writable
              -> migrate (one-shot container on <stack>_default)
              -> prune deploy <stack> with requested app image tag
```

1. **Build**: GitHub Actions builds the `server` image for every `main` push and pushes it to GHCR with the commit-derived tag (`<tag>`), because `Deploy Web` is triggered by the successful `CI` `workflow_run` for `main` and deploys that tag. The web build inside the image uses `VITE_ASSET_BASE_URL=https://assets.dofek.fit/web/<tag>/`, so Vite-generated JavaScript and CSS references point at immutable R2-backed CDN assets instead of the Express origin; Vite's `base` option controls the public base path for built assets: https://vite.dev/config/shared-options.html#base. `<tag>` is the image tag used consistently for both the GHCR image and the web asset prefix. See GitHub's `workflow_run` event documentation for the trigger behavior: https://docs.github.com/en/actions/reference/events-that-trigger-workflows#workflow_run. The `ml` image is built only when ML image inputs change.
2. **Terraform apply** (if infra changed): updates Cloudflare-managed production DNS and storage. `ORACLE_SERVER_HOST` is required for production DNS and deploy targeting.
3. **Deploy Web Stack** (`deploy-web-stack.yml`):
   1. Install the Infisical CLI, login with OIDC machine identity (`identity-id=46b66f72-0c77-4cfe-be1b-a43395e77be7`), and render `${{ github.workspace }}/.env.<env>` from `.github/templates/infisical-dotenv.tmpl`.
      The template escapes embedded newlines only when `secret.IsMultilineEncodingEnabled` is true.
      - Must include `CREDENTIAL_ENCRYPTION_KEY_BASE64` (base64-encoded 32-byte key).
      - Must include `CLICKHOUSE_PASSWORD` for the ClickHouse service. The deploy workflow URL-encodes it into `CLICKHOUSE_PASSWORD_ENCODED` for app `CLICKHOUSE_URL` interpolation.
      - Must include `POSTGRES_PASSWORD`; PeerDB's catalog database and internal MinIO stage use this existing secret.
      - Must include `PEERDB_UI_NEXTAUTH_SECRET` as a dedicated high-entropy PeerDB UI session-signing secret.
      - Must include `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `STRIPE_PRICE_ID` for Stripe billing checkout, portal, and webhook verification. Public return URLs use the deploy workflow's `PUBLIC_URL`.
      - Must include `REDPANDA_BROKERS` and `METRIC_STREAM_TOPIC` for metric-stream producer and sink services.
      - Must include `METRIC_STREAM_R2_BUCKET`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` for the Redpanda Connect R2 archive.
      - Optional: `CREDENTIAL_ENCRYPTION_KEY_NAMESPACE` (default `dofek`) and `CREDENTIAL_ENCRYPTION_KEY_NAME` (default `provider-credentials`).
   2. Point Docker CLI at the remote daemon with `DOCKER_HOST=ssh://ubuntu@<host>`.
   3. Login to GHCR on the CI runner.
   4. `docker pull ghcr.io/asherlc/dofek:<tag>`.
      The workflow also ensures pinned third-party stack images exist on the
      host, but skips those pulls when the exact image is already present.
      Image cleanup is controlled by this deploy workflow: it prunes unused
      Docker objects before image pulls and prunes obsolete images after a
      successful stack deploy. Do not run a continuous background image pruner
      on the production host, because newly pulled deploy images are not
      referenced by a service until after migrations complete.
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
      served from domains such as `dofek.asherlc.com`. If the CORS policy
      changes while objects are already cached at Cloudflare, purge the
      `assets.dofek.fit` cache hostname so cached asset responses refresh with
      the current `Access-Control-Allow-Origin` header. Cloudflare documents
      this cache behavior for R2 custom-domain CORS here:
      https://developers.cloudflare.com/r2/buckets/cors/#use-cors-with-a-custom-domain.
      Cloudflare documents R2 lifecycle object expiration rules here:
      https://developers.cloudflare.com/r2/buckets/object-lifecycles/.
   6. Apply the stack configuration before migrations with a non-prune,
      detached `docker stack deploy` and a temporary overlay that sets web,
      worker and analytics-worker replicas to zero.
      On existing stacks this uses the currently
      deployed app image tag, so database, ClickHouse, network, config, and
      resource-limit changes are applied before migrations without rolling new
      app code ahead of schema changes or letting old app tasks issue expensive
      analytics queries during the migration window. On clean-slate hosts it
      uses the deploy image tag so the DB service and overlay network exist
      before readiness checks. The final stack deploy restores the app service
      replicas from `deploy/stack.yml`. The deploy workflow waits explicitly
      for Postgres and ClickHouse before running migrations instead of keeping a
      long-lived Docker-over-SSH stack-deploy wait open while the single-node
      host restarts services.
   7. Wait until Postgres is writable (`SELECT NOT pg_is_in_recovery()`).
   8. Run **schema migrations** as a one-shot container attached to the swarm overlay network:
      `docker run --rm --network <stack>_default --env-file .env.<env> ghcr.io/…:<tag> migrate`.
      When `CLICKHOUSE_URL` is present, this also runs tracked ClickHouse
      analytics migrations before the stack update.
   9. Validate required host bind-mount directories before deploying the stack. This must fail before `docker stack deploy` if paths such as `/mnt/dofek-data/redis` are missing, because Swarm rejects tasks with missing bind sources.
   10. `docker stack deploy -c deploy/stack.yml --with-registry-auth --prune --detach=true <stack>` — swarm performs a single stack-wide update and CI then polls the key services until their desired replicas are running and any update state is complete. The deploy workflow bounds this wait at 20 minutes so a wedged Swarm rollback fails CI instead of running indefinitely.
      The workflow parses the Infisical dotenv file inside a child process for stack interpolation. Do not append the full dotenv file to `GITHUB_ENV`; GitHub Actions prints step environments and can expose Infisical-only secrets that GitHub does not automatically mask.
   11. Wait for PeerDB and run the one-shot ClickHouse CDC setup command. The command loads `src/db/peerdb/metric-stream-cdc.sql`, substitutes deployment connection values, creates the Postgres and ClickHouse peers if missing, and applies the metric-stream, raw analytics, and provider inventory mirrors.

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

Databasus backup state:

- Databasus stores its own users, storage targets, database definitions, schedules, and backup history in `/mnt/dofek-data/databasus`.
- Terraform creates that directory and performs a one-time copy from the legacy `databasus_data` Docker volume when the bind-mount path is still empty.
- If that path is empty or replaced, Databasus comes up as a fresh install and scheduled DB backups stop even if the `dofek-db-backups` bucket still exists.
- After any Databasus storage or deploy change, verify the latest object in `dofek-db-backups` is less than 24 hours old.

Required Infisical keys for mobile pipelines:

- `EXPO_PUBLIC_SENTRY_DSN`
- `SENTRY_AUTH_TOKEN` (Sentry sourcemap upload for native and OTA mobile releases: [iOS](../.github/workflows/deploy-ios.yml), [OTA](../.github/workflows/deploy-ota.yml))
- `EXPO_PUBLIC_OTEL_ENDPOINT`
- `EXPO_TOKEN` (OTA publish workflows)
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
  on the old release.
- On clean-slate hosts, the pre-migration deploy uses the requested deploy tag
  because there is no old release to preserve.
- After the pre-migration stack apply, the workflow runs DB readiness,
  migrations, and then the normal prune deploy with the requested app image tag.

This preserves migration gating while remaining safe for both warm updates and scratch deployments.

### Deployment Runbook: Traefik Subdomain 404

If management subdomains return `404 page not found`, use:

- `docs/traefik-subdomain-404-runbook.md`

### Deployment Runbook: Stale ClickHouse Body Measurements

If yesterday's or today's body weight exists in Postgres but is missing from
ClickHouse-backed body measurement reads, use:

- `docs/clickhouse-body-measurement-staleness-runbook.md`

## Management UIs
- **Portainer**: `https://portainer.dofek.asherlc.com`
- **Netdata**: `https://netdata.dofek.asherlc.com`
- **Databasus**: `https://databasus.dofek.asherlc.com` (DB management + backups)
- **CloudBeaver**: `https://cloudbeaver.dofek.asherlc.com` (Postgres + ClickHouse UI)
- **pgAdmin**: `https://pgadmin.dofek.asherlc.com` (Postgres UI)
- **PeerDB**: `https://peerdb.dofek.asherlc.com` (CDC mirror dashboard)
