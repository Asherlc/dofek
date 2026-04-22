---
name: integration-tests-ready
description: Prepare and troubleshoot integration test runs in this repo. Use when running `pnpm test`, `pnpm test:changed`, or specific `*.integration.test.ts` files, especially when failures mention Docker, Postgres, Redis, Testcontainers, migrations, or `setupTestDatabase`.
---

# Integration Tests Ready

## Quick Start

1. Start integration dependencies:
```bash
docker compose up -d db redis
docker compose ps db redis
```
2. Run the target test command:
```bash
pnpm test:changed
```
or
```bash
pnpm vitest <path/to/file.integration.test.ts>
```
3. If the run fails, capture:
- exact failing command
- first fatal error line
- causal explanation for that error before changing behavior

## Triage Flow

1. Confirm Docker is reachable:
```bash
docker ps
```
2. Verify local backing services are up and healthy:
```bash
docker compose ps db redis
```
3. Re-run only the failing integration suite to confirm reproducibility.
4. Fix root cause, then re-run the same suite.
5. Re-run the broader command (`pnpm test:changed` or `pnpm test`) to confirm.

## Common Failures

- `Error: Database did not become ready in time`
  - Check `docker compose ps db`.
  - Check DB logs: `docker compose logs db --tail 200`.

- `No host port found for host IP` (Testcontainers)
  - Run the specific failing suite once in isolation.
  - If isolated run passes, classify as transient infra flake under high suite load.
  - If isolated run fails, inspect Docker daemon health and container creation errors with `docker ps -a` and `docker events --since 10m`.

- Migration failure while setting up test DB
  - Record the failing migration filename and SQL statement.
  - Fix migration syntax/order issue; do not skip migrations.

## Report Format

When reporting back, include:
1. Failing command.
2. First fatal error line.
3. Root cause in one sentence.
4. Fix applied.
5. Validation command(s) and result.
