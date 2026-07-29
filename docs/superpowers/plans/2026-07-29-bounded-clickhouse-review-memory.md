# Bounded ClickHouse Review Memory TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:test-driven-development before implementation.

**Goal:** Keep local and browser E2E review seeding from exhausting a shared
Conductor Docker VM.

**Behavior:** Each review ClickHouse container has a bounded cgroup limit and
rejects tracked server allocations below that outer boundary while the
complete review pipeline still succeeds.

**Scope:** Default and browser E2E Compose ClickHouse resource configuration,
review/testing documentation, and incident evidence. Non-goals: production
ClickHouse sizing, retries, timeouts, query rewrites, or smaller review data.

**Docs:** `docs/testing.md`, `scripts/README.md`,
`docs/production-incident-baseline.md`, issue
[#2201](https://github.com/Asherlc/dofek/issues/2201).

---

## Current Evidence

- Exact failing audit step:
  `pnpm compose -- --project-suffix e2e -f docker-compose.e2e.yml exec -T server ./entrypoint.sh analytics-e2e`.
- First fatal line: dbt received
  `NameResolutionError("HTTPConnection(host='clickhouse', port=8123): Failed to resolve 'clickhouse' ([Errno -2] Name does not resolve)")`
  while building `daily_recovery_inputs`.
- The ClickHouse container immediately reported `Exited (137)`,
  `OOMKilled=true`, and `ExitCode=137`.
- Before the fix, both Compose stacks rendered no ClickHouse memory limit and
  runtime inspection reported `HostConfig.Memory=0`.
- The default stack configured up to 3,221,225,472 bytes of tracked ClickHouse
  memory on an 8,216,862,720-byte shared VM. The E2E stack did not mount a
  tracked-server limit at all.
- The current full review pipeline uses one dbt thread, succeeds, and reached
  approximately 900 MiB ClickHouse RSS.
- The first proposed profile used a 1,536 MiB container limit and 1,024 MiB
  tracked-server limit. The real pipeline rejected
  `activity_vo2max_estimate` with ClickHouse error 241: it would use
  913.97 MiB tracked memory while RSS was 1.07 GiB against the 1.00 GiB
  server maximum. The strategy is blocked pending approval for a different
  inner limit.

## Test Strategy

- Config validation: render both Compose stacks before and after the change and
  inspect their effective ClickHouse memory values.
- Runtime validation: recreate ClickHouse and assert the cgroup limit plus
  `system.server_settings.max_server_memory_usage`.
- Integration: rerun migrations, deterministic Postgres seed, review
  ClickHouse copy, local dbt build, and the focused review-seed integration
  test.
- E2E: run the real `analytics-e2e` entrypoint under the bounded E2E service.

## File Structure

- Modify: `docker-compose.yml` — bound default local ClickHouse memory.
- Modify: `docker-compose.e2e.yml` — apply the same review boundary.
- Modify: `deploy/clickhouse/config.d/memory-limits.xml` — keep tracked server
  memory below the cgroup ceiling.
- Modify: `scripts/README.md` and `docs/testing.md` — document the durable
  profile and rationale.
- Modify: `docs/production-incident-baseline.md` — preserve incident evidence.

## Tasks

### Task 1: Capture the Failing Resource Contract

- [x] Run
  `rtk pnpm compose -- config` and confirm ClickHouse has no rendered memory
  limit.
- [x] Run
  `rtk pnpm compose -- --project-suffix e2e -f docker-compose.e2e.yml config`
  and confirm E2E ClickHouse has no rendered memory limit.
- [x] Run `rtk docker inspect <clickhouse-container>` and confirm
  `HostConfig.Memory=0`.

### Task 2: Validate the First Bounded Profile

- [x] Set both ClickHouse container limits to 1,536 MiB.
- [x] Set local tracked server memory to 1,024 MiB and mount it in E2E.
- [x] Recreate the service and confirm the effective container and server
  limits.
- [x] Run the real review path and capture the first memory-limit failure.
- [x] Revert the failed profile instead of weakening the strategy without
  approval.

### Task 3: Resolve the Blocked Limit Decision

- [ ] Obtain approval for a new tracked-server limit or another explicitly
  bounded review strategy.
- [ ] Repeat rendered configuration, runtime, and full review-pipeline
  validation from a recreated ClickHouse service.
- [ ] Do not add retries, timeouts, fallback data, or warn-and-continue
  behavior.

### Task 4: Run Review and Test Gates

- [ ] Run `rtk pnpm setup-db`.
- [ ] Run
  `rtk pnpm tsx scripts/with-env.ts -- pnpm seed`.
- [ ] Run `rtk pnpm review:seed-clickhouse`.
- [ ] Run `rtk pnpm analytics:build`.
- [ ] Run the focused review-seed integration test.
- [ ] Run the real bounded E2E `analytics-e2e` entrypoint.
- [ ] Run lint, typecheck, and Docker-free tests required before push.
