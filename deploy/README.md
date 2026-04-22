# Infrastructure and Deployment

Infrastructure-as-code and deployment configuration for Dofek.

## Architecture

Dofek is deployed as a **single-node Docker Swarm** stack on **Hetzner Cloud** (HCloud) with **Cloudflare** for DNS, R2 storage, and CDN.

- **Compute**: Hetzner Cloud `cax11` ARM64 server running Ubuntu 24.04. The server runs `dockerd` initialized as a single-node swarm manager; it has no deploy scripts or secrets on disk.
- **Storage**:
  - **PostgreSQL**: Managed via TimescaleDB (running in the swarm).
  - **Volume**: Terraform provisions a Hetzner Block Storage volume (`data_volume_size_gb`, default `100GB`) attached with `automount=true`.
  - **DB data path**: The `db` service bind-mounts Postgres data to `/mnt/HC_Volume_105292545/postgres` on the attached Hetzner volume.
  - **S3 (R2)**: Cloudflare R2 buckets for training data (`dofek-training-data`), OTA updates (`dofek-ota`), Storybook (`dofek-storybook`), and DB backups (`dofek-db-backups`).
- **Networking**:
  - **Firewall**: `hcloud_firewall` allows SSH (port 22) from restricted IPs and HTTP/HTTPS (80/443) from everywhere.
  - **DNS**: Cloudflare manages multiple zones: `dofek.fit`, `dofek.live`, and subdomains on `asherlc.com`.
  - **Reverse Proxy**: Traefik handles SSL termination via Let's Encrypt (DNS-01 challenge) and routes traffic based on `Host()` rules declared in `deploy.labels` on each swarm service. Traefik's `providers.swarm` watches the Docker API for service changes.
- **Observability**:
  - **OpenTelemetry**: `otel-collector` gathers traces, logs, and metrics.
  - **Axiom**: Primary destination for structured logs and metrics via OTLP.
  - **Sentry**: Receives application logs/errors.
  - **Netdata**: Real-time server health and performance monitoring.
- **Secrets**: Managed via **Infisical**. CI fetches `prod` secrets at runtime with `Infisical/secrets-action` (OIDC machine identity), injects them as environment variables, and writes a temporary `.env.prod` file on the runner for `docker stack deploy`. The server never stores secrets on disk.

## Implementation Details

### Terraform (`*.tf`)
- `server.tf`: Defines the `hcloud_server` with `cloud-init.yml` for automated setup. Two idempotent `terraform_data` resources handle post-provision state:
  - `swarm_init`: ensures the server has `docker swarm init` run exactly once (cloud-init also does this for fresh servers, but `user_data` is in `ignore_changes`, so this covers drift on the live server).
  - `otel_config_sync`: bind-mounts `otel-collector-config.yaml` into `/opt/dofek` on the server and forces the collector service to re-read it.
  - `hcloud_volume.dofek_data`: attaches persistent block storage for DB growth headroom; size is controlled by `data_volume_size_gb`.
- `dns.tf`: Configures Cloudflare DNS records. Root domains (`dofek.fit`, `dofek.live`) are proxied (CDN enabled), while management subdomains (`ota.dofek.asherlc.com`, `portainer.dofek.asherlc.com`) are unproxied for direct access.
- `storage.tf`: Manages Cloudflare R2 buckets. Custom domains for Storybook are configured manually in the Cloudflare dashboard.

### Server Configuration (`server/`)
- `cloud-init.yml`: Installs Docker CE, configures Docker log rotation (10m, 3 files), and idempotently runs `docker swarm init`. No deploy helpers, no Infisical CLI.

### Swarm Stack (`stack.yml`)
- Single file defining all services: `web`, `worker`, `training-export-worker`, `traefik`, `db`, `redis`, `collector`, `ota`, `databasus`, `pgadmin`, `portainer`, `netdata`.
- Zero-downtime updates for `web` and `worker` are configured via `deploy.update_config` (`order: start-first`, `failure_action: rollback`, healthcheck-gated `monitor` window).
- The `default` overlay network is declared `attachable: true` so CI can run one-shot migration containers on it from a remote Docker context.
- `metric_stream` storage controls (Timescale hypertable + compression) are managed via `docs/metric-stream-timescaledb-runbook.md` and `drizzle/0006_metric_stream_timescale_policies.sql`.

### Monitoring (`otel-collector-config.yaml`)
- Uses `filelog` receiver to tail Docker logs from `/var/lib/docker/containers/*/*.log`.
- Parsed with `json_parser` and `regex_parser` (to extract container IDs).
- Filters out noisy Postgres `NOTICE` lines to reduce volume.
- Exports to Axiom and Sentry via `otlphttp`.

## Deployment

Deployments are push-based from CI, using a remote Docker context over SSH. CI never runs shell scripts on the server — it only calls the Docker API.

### Release Unit (Important)

- A web deploy is a **single swarm stack release**, not separate app/ML rollouts.
- `IMAGE_TAG` is shared across both GHCR images:
  - `ghcr.io/asherlc/dofek:<tag>`
  - `ghcr.io/asherlc/dofek-ml:<tag>`
- `docker stack deploy` is the only production rollout command for web deploys. It updates `web`, `worker`, and `training-export-worker` together from `deploy/stack.yml`.

### Flow Diagram

```text
CI (main) -> build dofek + dofek-ml (same tag)
         -> deploy-web check (both tags must exist)
         -> deploy-terraform (shared prerequisite)
         -> deploy-app
              -> fetch env via Infisical Secrets Action
              -> bootstrap stack if dofek_db is missing
              -> wait for postgres writable
              -> migrate (one-shot container on dofek_default)
              -> docker stack deploy dofek
```

1. **Build**: GitHub Actions builds the `server` and `ml` images and pushes them to GHCR with the same tag.
2. **Terraform apply** (if infra changed): updates Hetzner/Cloudflare and re-syncs the OTel config.
3. **Deploy App** (`deploy-app.yml`):
   1. Run `Infisical/secrets-action` with OIDC (`env-slug=prod`) and `export-type=file` to write `${{ github.workspace }}/.env.prod`. The workflow defaults to the production identifiers (`identity-id=46b66f72-0c77-4cfe-be1b-a43395e77be7`, `project-slug=dofek`) and can be overridden with repo variables `INFISICAL_IDENTITY_ID` / `INFISICAL_PROJECT_SLUG`.
   2. Point Docker CLI at the remote daemon with `DOCKER_HOST=ssh://root@<host>`.
   3. Login to GHCR on the CI runner.
   4. `docker pull ghcr.io/asherlc/dofek:<tag>` and `docker pull ghcr.io/asherlc/dofek-ml:<tag>`.
   5. Bootstrap step for clean-slate hosts: if `docker service inspect dofek_db` fails, run
      `docker stack deploy -c deploy/stack.yml --with-registry-auth dofek` first so the swarm DB service and overlay network exist.
   6. Wait until Postgres is writable (`SELECT NOT pg_is_in_recovery()`).
   7. Run migrations as a one-shot container attached to the swarm overlay network:
      `docker run --rm --network dofek_default --env-file .env.prod ghcr.io/…:<tag> migrate`.
   8. `docker stack deploy -c deploy/stack.yml --with-registry-auth --prune dofek` — swarm performs a single stack-wide update, including `training-export-worker`.

### Deployment Runbook: Cold-Start and DB Availability

If a deploy is running against a fresh host (or after removing previous non-swarm containers), `dofek_db` and `dofek_default` may not exist yet. In that case, waiting for Postgres before any stack deploy will fail forever because there is no DB service to reach.

The deploy workflow handles this with a bootstrap gate:
- If `dofek_db` exists, continue normally.
- If `dofek_db` is missing, run a non-prune stack deploy first to create the swarm services/network.
- After bootstrap, run DB readiness and migrations, then run the normal prune deploy.

This preserves migration gating while remaining safe for both warm updates and scratch deployments.

## Management UIs
- **Portainer**: `https://portainer.dofek.asherlc.com` (Protected by Authentik)
- **Netdata**: `https://netdata.dofek.asherlc.com` (Protected by Authentik)
- **Databasus**: `https://databasus.dofek.asherlc.com` (DB management + backups)
- **pgAdmin**: `https://pgadmin.dofek.asherlc.com` (Postgres UI)
