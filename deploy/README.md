# Infrastructure and Deployment

Infrastructure-as-code and deployment configuration for Dofek.

## Architecture

Dofek is deployed as a Docker-based stack on **Hetzner Cloud** (HCloud) with **Cloudflare** for DNS, R2 storage, and CDN.

- **Compute**: Hetzner Cloud `cax11` ARM64 server running Ubuntu 24.04.
- **Storage**:
  - **PostgreSQL**: Managed via TimescaleDB (running in Docker).
  - **Volume**: 20GB Hetzner Block Storage for database data, mounted at `/var/lib/postgresql/data`.
  - **S3 (R2)**: Cloudflare R2 buckets for training data (`dofek-training-data`), OTA updates (`dofek-ota`), Storybook (`dofek-storybook`), and DB backups (`dofek-db-backups`).
- **Networking**:
  - **Firewall**: `hcloud_firewall` allows SSH (port 22) from restricted IPs and HTTP/HTTPS (80/443) from everywhere.
  - **DNS**: Cloudflare manages multiple zones: `dofek.fit`, `dofek.live`, and subdomains on `asherlc.com`.
  - **Reverse Proxy**: Traefik (Docker) handles SSL termination via Let's Encrypt (DNS-01 challenge) and routes traffic based on `Host()` rules.
- **Observability**:
  - **OpenTelemetry**: `otel-collector` gathers traces, logs, and metrics.
  - **Axiom**: Primary destination for structured logs and metrics via OTLP.
  - **Sentry**: Receives application logs/errors.
  - **Netdata**: Real-time server health and performance monitoring.
- **Secrets**: Managed via **Infisical**. The deployment script fetches secrets at runtime and injects them into the Docker stack.

## Implementation Details

### Terraform (`*.tf`)
- `server.tf`: Defines the `hcloud_server` with `cloud-init.yml` for automated setup. It uses a `terraform_data` resource with an `ssh` provisioner to sync `docker-compose.deploy.yml` and trigger service restarts.
- `dns.tf`: Configures Cloudflare DNS records. Root domains (`dofek.fit`, `dofek.live`) are proxied (CDN enabled), while management subdomains (`ota.dofek.asherlc.com`, `portainer.dofek.asherlc.com`) are unproxied for direct access.
- `storage.tf`: Manages Cloudflare R2 buckets. Note: Custom domains for Storybook are configured manually in the Cloudflare dashboard.

### Server Configuration (`server/`)
- `cloud-init.yml`: Installs Docker CE, `docker-rollout` (for zero-downtime deployments), and the Infisical CLI. It also configures Docker log rotation (10m, 3 files).
- `run-compose-with-infisical.sh`: A wrapper script that pulls secrets from Infisical and runs `docker compose` or `docker rollout` with the correct environment.

### Monitoring (`otel-collector-config.yaml`)
- Uses `filelog` receiver to tail Docker logs from `/var/lib/docker/containers/*/*.log`.
- Parsed with `json_parser` and `regex_parser` (to extract container IDs).
- Filters out noisy Postgres `NOTICE` lines to reduce volume.
- Exports to Axiom and Sentry via `otlphttp`.

## Deployment

Deployments are triggered by GitHub Actions or manually via Terraform.

1. **Build**: GitHub Actions builds the `server` and `ml` (training-export-worker) images and pushes them to GHCR.
2. **Apply**: `terraform apply` updates the server state and triggers the `remote-exec` provisioner.
3. **Rollout**: The server executes `/opt/dofek/run-compose-with-infisical.sh rollout up -d` to perform a zero-downtime update using the `docker-rollout` plugin.

## Management UIs
- **Portainer**: `https://portainer.dofek.asherlc.com` (Protected by Authentik)
- **Netdata**: `https://netdata.dofek.asherlc.com` (Protected by Authentik)
- **Databasus**: `https://databasus.dofek.asherlc.com` (DB management + backups)
- **pgAdmin**: `https://pgadmin.dofek.asherlc.com` (Postgres UI)
