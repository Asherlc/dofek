# Fly pipeline runner

This independent Terraform root provisions a Fly app and, once an image digest is supplied, one private 512 MB Machine with one shared vCPU in San Jose. It uses the image's entry point, so a portable Linux runner can use the same image on another provider. The Machine has no public service or attached volume. The restart policy lets a one-shot worker exit without restarting. [Fly Machine restart policy](https://docs.fly.io/machines/guides-examples/machine-restart-policy)

## Provision

From this directory, copy `terraform.tfvars.example` to `terraform.tfvars` and set a globally unique app name. For an existing app, first restore its authoritative local state and matching variables to this directory. Keep a protected backup and use a single active copy of the state. State, local inputs, and saved plans belong outside version control.

Sign in with `flyctl auth login`. Supply a short-lived organization token through `FLY_API_TOKEN` in the current shell. Use the organization configured in `terraform.tfvars` in place of `personal` if it differs. [Fly API tokens](https://docs.fly.io/security/tokens)

```bash
export FLY_API_TOKEN="$(flyctl tokens create org --org personal --expiry 15m)"
terraform init
terraform plan -out=runner.tfplan
```

Review the plan, then run `terraform apply runner.tfplan`. The first apply can create just the app to provide a target for image publication. Publish the worker image, set `runner_image` to its immutable OCI reference, then plan and apply again. Terraform boots the Machine during creation and parks it afterward. [Push an image to the Fly registry](https://docs.fly.io/blueprints/using-the-fly-docker-registry)

## Verify a one-shot runner

```bash
app_name=$(terraform output -raw app_name)
machine_id=$(terraform output -raw machine_id)
flyctl machine start "$machine_id" --app "$app_name"
flyctl machine wait "$machine_id" --app "$app_name" --state stopped --wait-timeout 45s
flyctl machine status "$machine_id" --app "$app_name"
flyctl logs --no-tail --app "$app_name" --machine "$machine_id"
```

Confirm exit code 0 and the expected output. These commands assume a short smoke job that exits on completion.

## Qualification on 2026-11-23

A synthetic Kilter job used BullMQ and SQLite in a standalone container. Local builds passed on Linux ARM64 and emulated amd64. On Fly, the Machine started in 779 ms and ran for 6.3 seconds. The probe checked two records, 1,273 walls, and 1,159 gyms at about 138 MiB peak process RSS. The Machine exited with code 0 and the next Terraform plan found no changes.

The Machine reported a 434 MiB root filesystem, estimated at about $0.07 per 30 days while continuously stopped. Billing totals are still unmeasured. Production queue routing and live autoscaling remain outside this root. [Fly Machine pricing](https://docs.fly.io/about/pricing#stopped-fly-machines)
