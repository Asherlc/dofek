---
name: integration-tests-ready
description: Prepare and troubleshoot integration test runs in this repo. Use when running `pnpm test`, `pnpm test:changed`, the Vitest integration project, or specific `*.integration.test.ts` files, especially when failures mention Docker, generated service ports, Postgres, Redis, ClickHouse, Redpanda, Testcontainers, migrations, FIT decoding, or `setupTestDatabase`.
---

# Integration Tests Ready

## Quick Start

1. Generate collision-free ports and start the complete local dependency set:

```bash
rtk pnpm compose:env --write
rtk docker compose --env-file .env.local up -d --wait --wait-timeout 180 db clickhouse redis redpanda
rtk docker compose --env-file .env.local ps db clickhouse redis redpanda
```

1. Load those generated URLs before starting Vitest:

```bash
rtk bash -lc 'set -a; . ./.env.local; set +a; pnpm vitest run --project integration'
```

For one file:

```bash
rtk bash -lc 'set -a; . ./.env.local; set +a; pnpm vitest run --project integration <path/to/file.integration.test.ts>'
```
1. If the run fails, capture:
- exact failing command
- first fatal error line
- causal explanation for that error before changing behavior

## Triage Flow

1. Confirm Docker is reachable:
```bash
rtk docker ps
```
1. Verify local backing services are up and healthy:
```bash
rtk docker compose --env-file .env.local ps db clickhouse redis redpanda
```
1. Confirm the test process loaded `.env.local`. A ClickHouse refusal at
   `localhost:8123` while Compose exposes a generated port is an environment
   error, not a product failure.
1. Re-run only the failing integration suite to confirm reproducibility.
1. Fix root cause, then re-run the same suite.
1. Re-run the broader command to confirm.

## Common Failures

- `Error: Database did not become ready in time`
  - Check `rtk docker compose --env-file .env.local ps db`.
  - Check DB logs: `rtk docker compose --env-file .env.local logs db --tail 200`.

- ClickHouse `ECONNREFUSED` at `127.0.0.1:8123`
  - Keep the `.env.local` generated before startup; do not regenerate ports
    while the stack is running.
  - Source it in the same shell that starts Vitest.
  - Verify `CLICKHOUSE_URL` uses the generated host port.

- `Unable to start the native FIT decoder`
  - Verify `.build/fit-decoder/bin/dofek-fit-decoder` exists and matches the
    host architecture with `rtk file`.
  - On macOS, a downloaded `fit-decoder-linux` CI artifact cannot run. Build a
    native binary with `rtk pnpm build:fit-decoder` and a complete vcpkg
    checkout in `VCPKG_ROOT`.
  - Mirror the pinned vcpkg commit and bootstrap sequence in
    `.github/workflows/test.yml`; do not substitute an arbitrary toolchain.

- `No host port found for host IP` (Testcontainers)
  - Run the specific failing suite once in isolation.
  - If isolated run passes, classify as transient infra flake under high suite load.
  - If isolated run fails, inspect Docker daemon health and container creation errors with `docker ps -a` and `docker events --since 10m`.

- Migration failure while setting up test DB
  - Record the failing migration filename and SQL statement.
  - Fix migration syntax/order issue; do not skip migrations.

## Classification Guardrail

Do not file a product bug from a broad integration failure until the same file
has been rerun with the generated environment loaded and all required native
helpers present. Record prerequisite failures separately from application
failures.

## Isolated Browser E2E

Generate one unique Compose project name per run, keep every command in the same
shell, and reuse that name so concurrent and stale runs cannot share resources:

```bash
e2e_project_name="dofek-e2e-audit-$(date +%s)-$$"
rtk docker compose -p "$e2e_project_name" -f docker-compose.e2e.yml up -d --build --wait --wait-timeout 180
rtk docker compose -p "$e2e_project_name" -f docker-compose.e2e.yml ps -a
if ! rtk pnpm e2e:web:run; then
  rtk docker compose -p "$e2e_project_name" -f docker-compose.e2e.yml ps -a
  rtk docker compose -p "$e2e_project_name" -f docker-compose.e2e.yml logs --no-color
  rtk docker compose -p "$e2e_project_name" -f docker-compose.e2e.yml down -v
  exit 1
fi
rtk docker compose -p "$e2e_project_name" -f docker-compose.e2e.yml down -v
```

The failure branch captures container state and complete service logs before
teardown. The success path also removes the exact isolated project.

The E2E topology includes a health-checked Redpanda service and explicit
metric-stream producer variables. Server startup connects the producer before
opening the HTTP listener, and `activity-recording.cy.ts` verifies a recorded
activity with sensor samples can be saved through the authenticated API.

## Report Format

When reporting back, include:
1. Failing command.
1. First fatal error line.
1. Root cause in one sentence.
1. Fix applied.
1. Validation command(s) and result.
