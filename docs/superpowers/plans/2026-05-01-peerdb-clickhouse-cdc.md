# PeerDB ClickHouse CDC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy self-hosted PeerDB and configure a CDC mirror from Postgres `fitness.metric_stream` into ClickHouse.

**Architecture:** PeerDB runs internally in the Docker Swarm with its own catalog Postgres, Temporal services, workers, and transient MinIO stage. A one-shot TypeScript setup command creates the Postgres peer, ClickHouse peer, and `metric_stream` CDC mirror after the stack deploys. The first rollout writes into `peerdb.metric_stream` only; analytics reads remain on the current native ClickHouse backfill until the PeerDB initial snapshot is verified.

**Tech Stack:** TypeScript, `pg`, `@clickhouse/client`, Docker Swarm, PeerDB `v0.36.18`, Temporal, MinIO, TimescaleDB, ClickHouse.

---

## Task 1: Add PeerDB CDC Setup Logic

**Files:**
- Create: `src/db/clickhouse-cdc.ts`
- Create: `src/db/clickhouse-cdc.test.ts`
- Create: `src/db/setup-clickhouse-cdc.ts`

- [ ] Write tests for generated PeerDB SQL:
  - Postgres peer uses `db:5432`, user `health`, database `health`.
  - ClickHouse peer uses native port `9000`, database `peerdb`, and `disable_tls = true`.
  - Mirror maps `{ from: fitness.metric_stream, to: metric_stream, exclude: [device_id, source_type, vector] }`.
  - Mirror has `do_initial_copy = true`, `soft_delete = true`, and a deterministic publication name.

- [ ] Implement string builders and `setupClickHouseCdc()`:
  - Create ClickHouse database `peerdb`.
  - Run `CREATE PEER IF NOT EXISTS` for Postgres and ClickHouse.
  - Run `CREATE MIRROR IF NOT EXISTS dofek_metric_stream_cdc`.
  - Fail loudly when required environment variables are missing.

- [ ] Add a direct-run entrypoint in `src/db/setup-clickhouse-cdc.ts`.

## Task 2: Add PeerDB Services To Swarm

**Files:**
- Modify: `deploy/stack.yml`
- Modify: `deploy/server.tf`
- Modify: `.github/workflows/deploy-web-stack.yml`
- Modify: `deploy/README.md`

- [ ] Add internal services:
  - `peerdb-catalog`
  - `peerdb-temporal`
  - `peerdb-temporal-admin-tools`
  - `peerdb-flow-api`
  - `peerdb-flow-snapshot-worker`
  - `peerdb-flow-worker`
  - `peerdb`
  - `peerdb-minio`

- [ ] Add bind mounts:
  - `/mnt/dofek-data/peerdb-catalog`
  - `/mnt/dofek-data/peerdb-minio`

- [ ] Update Terraform provisioners and the workflow bind-mount validation to create and verify those paths.

- [ ] Add post-deploy workflow steps:
  - Wait for PeerDB SQL on `peerdb:9900`.
  - Run `src/db/setup-clickhouse-cdc.ts` in a one-shot app container on the swarm network.

## Task 3: Verify And Document

**Files:**
- Modify: `docs/clickhouse-metric-stream.md`
- Modify: `docs/production-incident-baseline.md`
- Modify: `README.md`

- [ ] Document that `peerdb.metric_stream` is the CDC target and `postgres_fitness.metric_stream` remains the active analytics source until snapshot validation.

- [ ] Run:
  - `pnpm vitest run src/db/clickhouse-cdc.test.ts`
  - `pnpm lint`
  - `pnpm tsc --noEmit`
  - `cd packages/server && pnpm tsc --noEmit`
  - `cd packages/web && pnpm tsc --noEmit`
  - `docker stack config -c deploy/stack.yml`

- [ ] Commit and push.
