# Deploy Agent Instructions

> **Read the [README.md](./README.md) first** for architecture and implementation details.

## High-Level Mandates

- **Always use Terraform**: Never manually modify infrastructure on OCI, Hetzner, or Cloudflare.
- **Secrets via Infisical**: Never hardcode secrets in `.tf` files or `stack.yml`. CI fetches deploy-tagged single-line secrets into an `env_file` for stack deploy; multiline secrets must be injected as Docker Swarm secrets.
- **Zero-Downtime via Swarm**: `deploy.update_config` on `web`/`worker` uses `order: start-first` + healthcheck-gated `monitor` + `failure_action: rollback`. Never bypass the canonical workflow with `docker service rm`, `docker service update`, or a manual stack deploy.
- **Deterministic Migrations**: CI first applies the stack with the
  ClickHouse-consumer and migration quiesce overlays without pruning, waits for
  Postgres and ClickHouse, runs the requested image's one-shot migrations, and
  then deploys that image with pruning while the consumers remain quiesced.
  The migration overlay keeps `worker` at zero because its
  [entrypoint](../entrypoint.sh) runs migrations on worker startup; the
  requested image is the only app image allowed to start after the migration
  phase. Only after the app converges does CI run the provider-connection
  cutover, post-deploy readiness and CDC gates, and the final deploy that
  restores the consumers. Do not run migrations inside `web` startup or reorder
  these phases. Docker documents the overlay merge behavior used by
  `docker stack deploy`:
  [stack deploy](https://docs.docker.com/reference/cli/docker/stack/deploy/).
- **No Server-Side Deploy Scripts**: The server only runs `dockerd` + swarm. All deploy logic lives in CI and talks to the remote Docker API over SSH. Do not add bash helpers to `/opt/dofek`.
- **DNS Consistency**: Every domain added to `stack.yml` MUST have a corresponding `cloudflare_dns_record` in `dns.tf`. `scripts/check-dns-records.sh` enforces this in CI.

## Common Tasks

### Deploying a New Image Tag

CI pushes images to GHCR, then `deploy-web.yml` delegates through
`deploy-web-environment.yml` to `deploy-web-stack.yml`. Production applies both
`deploy/stack.yml` and `deploy/stack.oracle.yml` in three phases around the
migration and CDC gates: a non-pruning pre-migration apply, a pruned
requested-image apply with consumers quiesced, and a final full-stack apply that
restores those consumers.

To redeploy, re-run or dispatch the canonical workflow with a validated image
tag. Do not bypass the release unit with `docker service update --force` or a
manual base-stack-only deploy.

### Debugging Failed Deploys

1. `docker --context prod service ps dofek_web` — see the rolling-update state, any failed tasks, and the restart history.
2. `docker --context prod service logs -f dofek_web` — stream logs.
3. Check `docker --context prod service inspect dofek_web --pretty` for the current spec.
4. SSH is allowed for inspection (reading logs, `docker ps`, `docker network
   inspect`) but not for deployment mutations. Fixes belong in checked-in stack,
   workflow, or Terraform configuration and roll out through the canonical
   workflow.

### Modifying OTel Config

`otel-collector-config.yaml` is a Docker Swarm **config object** (`otel_collector_config` in `stack.yml`), uploaded into the swarm by `docker stack deploy` on every deploy — no host file. Swarm config objects are **immutable**, so after editing the file you MUST bump the config key's version suffix in `stack.yml` (e.g. `otel_collector_config` → `otel_collector_config_v2`), exactly like `netdata_db_limits_v2`. Without the bump, `docker stack deploy` keeps the old config and the collector won't pick up changes.

## Guardrails

- **Production host**: Production deploys to the OCI host in `ORACLE_SERVER_HOST` with `ssh_user: ubuntu` and `deploy/stack.oracle.yml`. Hetzner production, staging, or review-app resources should not be reintroduced.
- **Port 5432**: Database port is bound to `127.0.0.1:5432` only. Access it via SSH tunnel or pgAdmin.
- **Overlay network is attachable**: the `default` network in `stack.yml` is declared `attachable: true` specifically so CI can attach one-shot containers (migrations). Do not remove — it breaks the migration step.
