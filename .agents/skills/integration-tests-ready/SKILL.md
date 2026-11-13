---
name: integration-tests-ready
description: Prepare and troubleshoot database-backed integration tests, Compose dependencies, generated service ports, migrations, and native FIT decoding. Use for pnpm test:integration, the integration Vitest project, or service-related test failures. Ordinary pnpm test and pnpm test:changed are Docker-free.
---

# Integration Tests Ready

Read [the testing guide](../../../docs/testing.md#integration-dependencies)
and its [test policy](../../../docs/testing.md#test-policy) first. The
[package scripts](../../../package.json) and
[test wrapper](../../../scripts/run-tests.ts) define the current tiers.

## Choose the tier

Run commands from the repository root, non-interactively:

```bash
# Unit and mobile; no Docker needed
rtk pnpm test run

# Database-backed tests; starts this workspace's dependencies and loads URLs
rtk pnpm test:integration

# A single integration file (replace the path)
rtk pnpm test:integration -- src/db/db.integration.test.ts

# Unit, mobile, and database integration projects
rtk pnpm test:all

# Separate PeerDB CDC contract tier
rtk pnpm test:peerdb-integration
```

The integration wrapper provides `TEST_DATABASE_URL`; do not bypass it with
raw Vitest plus manually copied URLs. The `:all` tiers do not include native
Pulsar qualification; follow its [separate procedure](../../../docs/testing.md#native-pulsar-qualification).

## Diagnose prerequisites before changing code

Capture the exact failing command, first fatal error line, and causal explanation.
Confirm Docker and the owning workspace's services:

```bash
rtk docker info
rtk pnpm compose -- ps db clickhouse redis redpanda
rtk pnpm compose -- logs --tail 200 db clickhouse redis redpanda
```

- Use `rtk pnpm compose:up` when services need starting. The wrapper owns port
  allocation and `.env.local`; keep that file while the stack is running.
- A refusal at a default ClickHouse port when this workspace uses a generated
  port indicates missing environment setup. Reproduce through the integration
  wrapper before diagnosing product code.
- For native FIT failures, verify `.build/fit-decoder/bin/dofek-fit-decoder`
  exists and matches the host architecture. Follow the
  [native FIT prerequisites](../../../docs/testing.md#native-fit-decoder),
  including the pinned vcpkg bootstrap. Linux artifacts cannot run on macOS.
- For migration failures, capture the migration and SQL statement; fix the
  cause rather than skipping migrations.
- For Testcontainers port or resource failures, rerun the failing suite in
  isolation to collect evidence, inspect Docker state, and diagnose the cause.
  An isolated pass alone does not establish a cause or make a rerun a fix.

After a direct fix, rerun the failing suite, then the relevant broader tier.
Explicitly report unavailable prerequisites and checks that were not run.

## Browser E2E

Run local browser E2E only when the changed E2E tests require it. Use
`rtk pnpm e2e:web`, or the existing
[isolated E2E procedure](../../../docs/testing.md#isolated-browser-end-to-end-stack)
when inspecting a stack. Every Compose command must use `rtk pnpm compose --`
and the same `--project-suffix e2e`; do not invent a second project identity.
Capture state/logs before cleanup and remove only the disposable E2E project's
resources. Follow the repository's Docker volume/cleanup approval boundaries.
