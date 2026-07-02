# Loading Performance Runbook Guidance TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation.

**Goal:** Document the evidence-first loading performance workflow so future agents do not optimize the wrong layer.

**Behavior:** Agent docs and runbooks instruct workers to start with Axiom, classify the slowdown vector, preserve stale data during refetch, and only add ClickHouse read models for proven request-time bottlenecks.

**Scope:** Documentation only. Non-goals: code changes or tests for static config beyond docs lint/typecheck already run by repo.

**Docs:** `AGENTS.md`, `packages/web/AGENTS.md`, `packages/mobile/AGENTS.md`, `analytics/README.md`, new performance runbook.

---

## Current Evidence

- The current discussion identified multiple vectors: client blanking, persistence, invalidation, batching, queueing, ClickHouse query shape, freshness UX, and monitors.
- Existing docs cover ClickHouse/dbt rules but not a comprehensive loading-performance workflow.

## Test Strategy

- Documentation review checklist rather than static config tests.
- Link every third-party/platform behavior claim to official docs or existing internal evidence.

## File Structure

- Create: `docs/performance/loading-performance-runbook.md`
- Modify: `AGENTS.md`
- Modify: `packages/web/AGENTS.md`
- Modify: `packages/mobile/AGENTS.md`
- Modify: `analytics/README.md` only if adding analytics-specific guidance.

## Tasks

### Task 1: Draft Runbook

- [ ] Document the slowdown taxonomy.
- [ ] Include Axiom discovery/query steps and blocked-query fallback.
- [ ] Include client loading policy: do not blank existing data during refetch.
- [ ] Include backend gate: no ClickHouse/dbt work without Axiom/ClickHouse evidence.

### Task 2: Update Agent Guidance

- [ ] Add concise web/mobile loading policy.
- [ ] Add analytics guidance for proven request-time bottlenecks.
- [ ] Keep human docs standalone; do not require agent skills for humans.

### Task 3: Verification

- [ ] Run `rtk pnpm lint` if docs are linted.
- [ ] Check AGENTS symlinks remain valid where touched.
- [ ] Confirm every new third-party claim has a citation.
