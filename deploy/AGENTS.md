# Agent guidelines — `deploy/`

> **Read [`deploy/README.md`](README.md) before doing anything in this directory.** It is the source of truth for production architecture, services, the deploy pipeline, secrets handling, and operational runbooks. Do not act on infrastructure here without that context — almost every common failure mode is documented there.

The repo-wide rules in the root [`AGENTS.md`](../AGENTS.md) (symlinked as `CLAUDE.md`) still apply. The notes below are deploy-specific extensions and reminders.

## Hard rules for this directory

- **Validate locally before opening a PR.** Any change to `*.tf`, `server/cloud-init.yml`, `server/run-compose-with-infisical.sh`, `docker-compose.deploy.yml`, or `otel-collector-config.yaml` must be verified with `terraform plan` (and usually `terraform apply`) using Infisical-supplied secrets **before** the PR exists. CI running `terraform apply` is not a substitute. When CI fails on infra, prod is in an unknown state and follow-up PRs stack new failures on top.
- **Never SSH into the server to fix anything.** SSH is for **debugging only** — reading logs, inspecting `docker ps`, checking volume contents. The fix must always be a code/infrastructure change committed here so that the next provision is correct. If you find yourself wanting to `vim /opt/dofek/...`, stop and update the compose file or Terraform instead.
- **Never bypass safety checks.** Don't skip `--no-verify`, raise size limits, disable required CI checks, or modify GitHub branch protection. If a check is wrong, fix it in this repo or stop and ask.
- **Fail fast in deploy scripts.** No `warn-and-continue` on missing env files / missing required vars. The `REQUIRED_INFISICAL_VARS` mechanism in `server/run-compose-with-infisical.sh` exists precisely to fail loudly with a clear list of missing keys.
- **Surface the real error.** The `deploy-app.yml` / `deploy-ml.yml` workflows used to print "Timed out waiting for db/redis" whenever the helper script failed for any reason (e.g. an `infisical` install failure on the host). Don't reintroduce blanket error messages that invent a cause. If the helper script can fail before compose ever runs, the error must say so.
- **Always use the latest stable version when bumping a pin.** But pin to a specific version — don't use `latest`. Verify the version actually exists in the source repo (apt, GHCR, etc.) before pinning; some packages have two version streams (see Infisical CLI note in the README).

## Common task playbooks

### "CI deploy failed, please look"

1. Read `deploy/README.md` → "Operational notes & common failures" first; many failures are catalogued there.
2. `gh run list --workflow=deploy-terraform.yml --limit=5`, `gh run list --workflow=deploy-web.yml --limit=5`.
3. `gh run view <id> --log-failed | head -200` — but actual root-cause lines are usually buried mid-log; grep for `Error|error|fail|Timed`.
4. Map the symptom back to the runbook in `deploy/README.md`. The misleading "Timed out waiting for db/redis" message in particular almost always means the helper script failed before compose ran.

### Adding a service to the production stack

1. Add the service to `docker-compose.deploy.yml` with image, env, volumes, healthcheck, Traefik labels.
2. If it needs new secrets, add them to Infisical (`infisical secrets set --env=prod KEY=value`) **and** add the keys to `REQUIRED_INFISICAL_VARS` in `server.tf` (the `terraform_data.deploy_compose` `remote-exec` block) so deploys fail fast if they're missing.
3. If it needs DNS, add a record in `dns.tf`.
4. Update the services table in `deploy/README.md`.
5. `terraform plan` locally — confirm only the expected resources change.
6. `terraform apply` locally to roll the change out, or push and let CI apply.

### Bumping the Infisical CLI version

The CLI version is **not** the same as the Infisical app version on GitHub releases. Verify the version on Cloudsmith before bumping (see README). Update both `server/run-compose-with-infisical.sh` and `server/cloud-init.yml` together; they must stay in sync.

### Adding/changing a required Infisical key

Update both:
- `server.tf` → the `REQUIRED_INFISICAL_VARS` list in the `terraform_data.deploy_compose` `remote-exec` provisioner.
- `deploy/README.md` → the "Required Infisical `prod` keys" list.
- Set the key in Infisical (`infisical secrets set --env=prod KEY=value`) before running terraform — otherwise the validator will (correctly) refuse to deploy.

## Things that have bitten us

- **Infisical CLI version pinned to the wrong number.** `0.159.x` is the Infisical app/server version; the CLI was at `0.38.x` on Cloudsmith. The pin needs to match the CLI track, not the app track. (Fixed; this is the kind of error to watch for when bumping any "Infisical" version anywhere.)
- **Misleading deploy error: "Timed out waiting for db/redis to become healthy".** Used to be the catch-all error message for any failure of the helper script — so a broken `infisical` install was reported as a healthcheck timeout, sending debugging in entirely the wrong direction. The workflows now say "compose up for db/redis failed" with the exit code and explicitly point upward to the real cause. Don't regress this.
- **HCP Terraform "workspace already locked" race.** `terraform init` followed immediately by `terraform apply` can race the workspace lock on HCP. The workflow now uses `-lock-timeout=5m` for both. If you see this fail despite the timeout, check the HCP UI for a stuck lock (Workspace → Settings → Locking) and force-unlock.
- **Provisioner failures leaving prod in a partially-updated state.** `terraform_data.deploy_compose` runs `compose pull` then `compose up`. If `pull` succeeds but `up` fails (e.g. a missing secret), the new images are on the host but not running. Re-run after fixing the underlying cause.
- **`pgadmin`-style "missing required vars" failures.** New required Infisical key + Terraform apply happens before the key is set in Infisical. Always set the key first, then apply.

## Which file does what

| File | Owns |
|------|------|
| `main.tf` | HCP Terraform cloud block, provider versions, provider blocks |
| `variables.tf` | Input variables (tokens, SSH keys, sizing) |
| `outputs.tf` | Server IP, etc. |
| `server.tf` | Hetzner server, firewall, SSH key, `terraform_data.deploy_compose` (uploads compose + runs initial `compose up`) |
| `storage.tf` | Hetzner volume(s) for `/opt/dofek` data |
| `dns.tf` | Cloudflare DNS records for prod hostnames |
| `imports.tf` | `terraform import` blocks for resources brought into state |
| `docker-compose.deploy.yml` | Full prod stack |
| `otel-collector-config.yaml` | OTel Collector pipeline (logs/traces → Axiom, metrics → Axiom) |
| `server/cloud-init.yml` | First-boot bootstrap of Docker CE, docker-rollout, Infisical CLI |
| `server/run-compose-with-infisical.sh` | Helper invoked by GHA + Terraform that exports Infisical secrets and runs compose / docker-rollout |
| `cloudflare/` | Separate Terraform module for Cloudflare R2 buckets + Storybook DNS |

`server/cloud-init.yml` only runs on first boot of the server; the `hcloud_server.dofek` resource has `lifecycle { ignore_changes = [user_data, ...] }` so editing it does not re-provision a running server. To apply cloud-init changes, taint the resource (which destroys + recreates the server — be very sure before doing this; the persistent volume keeps the data, but downtime is required).
