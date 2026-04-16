# Deploy Agent Instructions

> **Read the [README.md](./README.md) first** for architecture and implementation details.

## High-Level Mandates
- **Always use Terraform**: Never manually modify infrastructure on Hetzner or Cloudflare.
- **Secrets via Infisical**: Never hardcode secrets in `.tf` files or `docker-compose`. Use the `run-compose-with-infisical.sh` script on the server.
- **Zero-Downtime**: Use `rollout` instead of `up` for application services (`web`, `worker`) to ensure availability during updates.
- **DNS Consistency**: Every domain added to `docker-compose.deploy.yml` MUST have a corresponding `cloudflare_dns_record` in `dns.tf`.

## Common Tasks

### Updating Docker Images
The `IMAGE_TAG` is managed in `/opt/dofek/.env.deploy` on the server. Terraform triggers a re-deploy if the `docker-compose.deploy.yml` hash changes. To force a re-pull of the same tag (e.g., `latest`), use `terraform taint terraform_data.deploy_compose`.

### Debugging Failed Deploys
1. SSH into the server using the IP from `terraform output server_ip`.
2. Check `docker-compose.deploy.yml` in `/opt/dofek`.
3. Run logs: `./run-compose-with-infisical.sh compose logs -f <service>`.

### Modifying OTel Config
Changes to `otel-collector-config.yaml` are automatically synced to the server and the collector service is restarted by Terraform's `terraform_data` trigger.

## Guardrails
- **Immutable Server**: `hcloud_server.dofek` has `lifecycle { ignore_changes = [ssh_keys, user_data, image] }` to prevent accidental destruction of the live server during drift. To reprovision, you must explicitly taint the resource.
- **Port 5432**: Database port is bound to `127.0.0.1:5432` only. Access it via SSH tunnel or pgAdmin.
