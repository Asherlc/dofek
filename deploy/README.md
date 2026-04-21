# Infrastructure and Deployment

Infrastructure-as-code and deployment configuration for Dofek.

## Architecture

Dofek is deployed as a **single-node Docker Swarm** stack on **Hetzner Cloud** (HCloud) with **Cloudflare** for DNS, R2 storage, and CDN.

- **Compute**: Hetzner Cloud `cax11` ARM64 server running Ubuntu 24.04. The server runs `dockerd` initialized as a single-node swarm manager; it has no deploy scripts or secrets on disk.
- **Storage**:
  - **PostgreSQL**: Managed via TimescaleDB (running in the swarm).
  - **Volume**: 20GB Hetzner Block Storage for database data, mounted at `/var/lib/postgresql/data`.
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
- **Secrets**: Managed via **Infisical**. CI exports secrets at deploy time into a temporary `.env.prod` file on the runner; `docker stack deploy` inlines them into the service spec. The server never stores secrets on disk.

## Implementation Details

### Terraform (`*.tf`)
- `server.tf`: Defines the `hcloud_server` with `cloud-init.yml` for automated setup. Two idempotent `terraform_data` resources handle post-provision state:
  - `swarm_init`: ensures the server has `docker swarm init` run exactly once (cloud-init also does this for fresh servers, but `user_data` is in `ignore_changes`, so this covers drift on the live server).
  - `otel_config_sync`: bind-mounts `otel-collector-config.yaml` into `/opt/dofek` on the server and forces the collector service to re-read it.
- `dns.tf`: Configures Cloudflare DNS records. Root domains (`dofek.fit`, `dofek.live`) are proxied (CDN enabled), while management subdomains (`ota.dofek.asherlc.com`, `portainer.dofek.asherlc.com`) are unproxied for direct access.
- `storage.tf`: Manages Cloudflare R2 buckets. Custom domains for Storybook are configured manually in the Cloudflare dashboard.

### Server Configuration (`server/`)
- `cloud-init.yml`: Installs Docker CE, configures Docker log rotation (10m, 3 files), sets up a daily `docker image prune -af` cron, and idempotently runs `docker swarm init`. No deploy helpers, no Infisical CLI.

### Swarm Stack (`stack.yml`)
- Single file defining all services: `web`, `worker`, `training-export-worker`, `traefik`, `db`, `redis`, `collector`, `ota`, `databasus`, `pgadmin`, `portainer`, `netdata`.
- Zero-downtime updates for `web` and `worker` are configured via `deploy.update_config` (`order: start-first`, `failure_action: rollback`, healthcheck-gated `monitor` window).
- The `default` overlay network is declared `attachable: true` so CI can run one-shot migration containers on it from a remote Docker context.

### Monitoring (`otel-collector-config.yaml`)
- Uses `filelog` receiver to tail Docker logs from `/var/lib/docker/containers/*/*.log`.
- Parsed with `json_parser` and `regex_parser` (to extract container IDs).
- Filters out noisy Postgres `NOTICE` lines to reduce volume.
- Exports to Axiom and Sentry via `otlphttp`.

## Deployment

Deployments are push-based from CI, using a remote Docker context over SSH. CI never runs shell scripts on the server — it only calls the Docker API.

1. **Build**: GitHub Actions builds the `server` and `ml` images and pushes them to GHCR.
2. **Terraform apply** (if infra changed): updates Hetzner/Cloudflare and re-syncs the OTel config.
3. **Deploy App** (`deploy-app.yml`):
   1. Install Infisical CLI and export secrets to `$RUNNER_TEMP/.env.prod`.
   2. Create a remote Docker context: `docker context create prod --docker host=ssh://root@<host>`.
   3. Login to GHCR on the CI runner.
   4. `docker --context prod pull ghcr.io/asherlc/dofek:<tag>`.
   5. Run migrations as a one-shot container attached to the swarm overlay network:
      `docker --context prod run --rm --network dofek_default --env-file .env.prod ghcr.io/…:<tag> migrate`.
   6. `docker --context prod stack deploy -c deploy/stack.yml --with-registry-auth --prune dofek` — swarm performs the rolling update natively.
4. **Deploy ML** (`deploy-ml.yml`): `docker --context prod service update --image ghcr.io/asherlc/dofek-ml:<tag> --with-registry-auth dofek_training-export-worker`.

## Management UIs
- **Portainer**: `https://portainer.dofek.asherlc.com` (Protected by Authentik)
- **Netdata**: `https://netdata.dofek.asherlc.com` (Protected by Authentik)
- **Databasus**: `https://databasus.dofek.asherlc.com` (DB management + backups)
- **pgAdmin**: `https://pgadmin.dofek.asherlc.com` (Postgres UI)
