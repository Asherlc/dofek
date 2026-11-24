# Fly pipeline runner

This Terraform root provisions a Fly app and one private 512 MB Machine with
one shared vCPU in San Jose once an image digest is supplied. The
`pipeline-runner` Docker target uses userspace WireGuard to run the provider-sync
entry point on Linux. The Machine has no public service, attached
volume, or autoscaler. [Fly Machine restart policy](https://docs.fly.io/machines/guides-examples/machine-restart-policy)

## Provision

From this directory, copy `terraform.tfvars.example` to `terraform.tfvars` and set a globally unique app name. For an existing app, first restore its authoritative local state and matching variables to this directory. Keep a protected backup and use a single active copy of the state. State, local inputs, and saved plans belong outside version control.

Sign in with `flyctl auth login`. Supply a short-lived organization token through `FLY_API_TOKEN` in the current shell. Use the organization configured in `terraform.tfvars` in place of `personal` if it differs. [Fly API tokens](https://docs.fly.io/security/tokens)

```bash
export FLY_API_TOKEN="$(flyctl tokens create org --org personal --expiry 15m)"
terraform init
terraform plan -out=runner.tfplan
```

Review the plan, then run `terraform apply runner.tfplan`. The first apply can create just the app to provide a target for image publication. Publish the worker image, set `runner_image` to its immutable OCI reference, then plan and apply again. Terraform boots the Machine during creation and parks it afterward. [Push an image to the Fly registry](https://docs.fly.io/blueprints/using-the-fly-docker-registry)

### Production setup

Set `production_sync = true` in the Fly root inputs. Review and apply the
Fly plan, then apply the OCI Terraform plan that enables UDP 51820 on the
existing host. The Oracle stack's WireGuard gateway authenticates one
configured peer and relays Redis, PostgreSQL, and OTLP only on its tunnel IP.
Wireproxy and the Node worker both run as UID and GID 1000. Wireproxy listens
on loopback for PostgreSQL (5432), Redis (6379), and OTLP (4318). It forwards
these connections to the Oracle peer over WireGuard. The worker starts with
the tunnel key variables removed from its environment. The entry point
keeps the tunnel up while the worker drains on SIGTERM.
[Wireproxy TCP client tunnels](https://github.com/windtf/wireproxy/blob/e00074911d2e8b23bac6b74703fa1a2b522cff2b/README.md)

Both peers use a 1,200-byte tunnel MTU. This leaves room for WireGuard
encapsulation on an outer path as small as 1,280 bytes. The release updates
the gateway and worker from the same revision. After rollout, confirm a
completed sync with the Fly Machine ID in Axiom. [WireGuard MTU handling](https://git.zx2c4.com/wireguard-tools/tree/src/wg-quick/linux.bash)
The Fly production release checks the singleton Machine's configuration and
waits for its private readiness check. [Fly Machine checks](https://docs.fly.io/reference/health-checks/)

Production Infisical holds `FLY_SYNC_APP_NAME`, the app-scoped
`FLY_SYNC_DEPLOY_TOKEN`, the two gateways' key pairs under
`SYNC_WIREGUARD_GATEWAY_{PRIVATE,PUBLIC}_KEY` and
`SYNC_WIREGUARD_RUNNER_{PRIVATE,PUBLIC}_KEY`, and the comma-separated
`SYNC_WORKER_PROVIDERS`. The initial list is `kilter,tension`. Both use the
same climbing-board ingestion implementation. Select additional provider
queues after exercising their full sync workload inside the Machine budget
and verifying that their dependencies are reachable. The portable worker
validates the list against the configured, enabled sync providers at startup.
Rotate the deployment token in Infisical before its expiry. [Fly API tokens](https://docs.fly.io/security/tokens)

The canonical production release builds the worker from the same source
revision as the Oracle release, drains the existing Fly Machine before
database migrations, and updates its image by digest in place after the
Oracle stack is ready. Terraform owns the singleton Machine and infrastructure
configuration. The application release owns its current image.

Fly offers one slot across eligible provider queues. Oracle briefly yields an
eligible first attempt when that slot is available. Oracle resumes after three
seconds and processes work that remains queued. When Fly is busy, Oracle can
claim new work within the provider's concurrency limit. BullMQ preserves
the original job ID, retry budget, and queue-wide concurrency limit. Priority is enabled for
configured queues without a BullMQ rate limiter. [BullMQ global concurrency](https://docs.bullmq.io/guide/queues/global-concurrency)

Before a database restore, drain Fly with the same command as the release.

```bash
flyctl machine stop "$machine_id" --app "$app_name" --signal SIGTERM --timeout 300 --wait-timeout 6m
```

Start Fly after the primary stack completes its restore and passes readiness.

```bash
flyctl machine start --app "$app_name" --wait "$machine_id"
```

### See which host ran sync jobs

Both workers send a structured `provider_sync_attempt_finished` event to the
existing Axiom dataset. Oracle uses the Swarm node hostname. Fly uses the
Machine ID. The event records the provider, queue, attempt number, processor
outcome, and elapsed time. A BullMQ retry contributes another attempt. An
attempt interrupted by a forced stop can be absent from the finished events.
Elapsed time measures wall-clock execution, including waits.

In the Axiom Query Editor run the following APL over the desired time range.
Each row's share is its attempt count or duration divided by the column total.
Filter by `tostring(fields['provider_id'])` after the `extend` to measure the
split among selected providers. [Axiom map fields](https://axiom.co/docs/apl/data-types/map-fields)

```apl
['dofek-logs']
| extend fields = ['attributes.custom']
| where tostring(fields['event']) == 'provider_sync_attempt_finished'
| summarize attempts = count(), elapsed_ms = sum(tolong(fields['duration_ms']))
    by site = tostring(fields['worker_site']), instance = tostring(fields['worker_instance'])
| order by attempts desc
```

## Verify a one-shot qualification image

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

The original kernel-based image completed Kilter and Tension queue fixtures through a
local WireGuard gateway with real PostgreSQL and Redis. Its telemetry reached
the collector over the tunnel. An additional 2,500-record Kilter extraction
probe ran alongside the worker in the same 512 MiB container, with a combined
peak of 401 MiB. These measurements use fixture data.

The qualification Machine reported a 434 MiB root filesystem, estimated at
about $0.07 per 30 days while continuously stopped. Production compute,
root filesystem, and outbound traffic have separate billing measurements.
[Fly Machine pricing](https://docs.fly.io/about/pricing#stopped-fly-machines)

## Rootless qualification on 2026-11-24

The userspace runner completed the two queue fixtures and sent both execution
records to the collector. The simultaneous 2,500-record extraction probe and
worker peaked at 267 MiB in a native Linux ARM64 container with a 512 MiB cap
and swap disabled. The image also built for Linux amd64. The amd64 workload
under desktop emulation reached the cap and used swap. Measure native amd64
memory and metered transfer after the Fly release.
