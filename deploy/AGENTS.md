# Deploy Agent Instructions

> **Read the [README.md](./README.md) first** for architecture and implementation details.

## High-Level Mandates
- **Always use Terraform**: Never manually modify infrastructure on Hetzner or Cloudflare.
- **Secrets via Infisical**: Never hardcode secrets in `.tf` files or `stack.yml`. CI fetches deploy-tagged single-line secrets into an `env_file` for stack deploy; multiline secrets must be injected as Docker Swarm secrets.
- **Zero-Downtime via Swarm**: `deploy.update_config` on `web`/`worker` uses `order: start-first` + healthcheck-gated `monitor` + `failure_action: rollback`. Never bypass this (e.g., no `docker service rm` + recreate — always `docker stack deploy` or `docker service update`).
- **Deterministic Migrations**: Migrations run in CI **before** `stack deploy` as a one-shot container against the remote swarm (`docker --context prod run --rm --network dofek_default ... migrate`). Do not run migrations inside `web` startup in production.
- **No Server-Side Deploy Scripts**: The server only runs `dockerd` + swarm. All deploy logic lives in CI and talks to the remote Docker API over SSH. Do not add bash helpers to `/opt/dofek`.
- **DNS Consistency**: Every domain added to `stack.yml` MUST have a corresponding `cloudflare_dns_record` in `dns.tf`. `scripts/check-dns-records.sh` enforces this in CI.

## Common Tasks

### Deploying a New Image Tag
CI pushes images to GHCR, then `deploy-web-stack.yml` runs `docker --context prod stack deploy -c deploy/stack.yml --with-registry-auth dofek` with `IMAGE_TAG` exported in the shell. Swarm does a rolling update; no manual intervention.

To force a redeploy of the same tag (e.g., `latest` after a rebuild), re-run the workflow — `stack deploy` will detect no spec change but can be nudged with `docker --context prod service update --force --with-registry-auth dofek_web`.

### Debugging Failed Deploys
1. `docker --context prod service ps dofek_web` — see the rolling-update state, any failed tasks, and the restart history.
2. `docker --context prod service logs -f dofek_web` — stream logs.
3. Check `docker --context prod service inspect dofek_web --pretty` for the current spec.
4. SSH is still allowed for inspection (reading logs, `docker ps`, `docker network inspect`) but not for making changes — fixes belong in `stack.yml` / Terraform.

### Modifying OTel Config
Changes to `otel-collector-config.yaml` are synced to the server by `terraform_data.otel_config_sync` and the collector service is updated with `--force` so it re-reads the bind-mounted config.

## Guardrails
- **Immutable Server**: `hcloud_server.dofek` has `lifecycle { ignore_changes = [ssh_keys, user_data, image] }` to prevent accidental destruction of the live server during drift. To reprovision, you must explicitly taint the resource.
- **Port 5432**: Database port is bound to `127.0.0.1:5432` only. Access it via SSH tunnel or pgAdmin.
- **Overlay network is attachable**: the `default` network in `stack.yml` is declared `attachable: true` specifically so CI can attach one-shot containers (migrations). Do not remove — it breaks the migration step.
