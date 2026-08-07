# Loading Performance Axiom Baseline TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an evidence baseline that classifies current web/iOS loading delays by cause before any backend optimization begins.

**Behavior:** The repo should contain a current, query-backed performance taxonomy showing which slow paths are client blanking, cache misses, tRPC batching, queue wait, ClickHouse execution, Postgres execution, or data freshness.

**Scope:** Axiom discovery/querying, evidence capture, and issue updates. Non-goals: code behavior changes or ClickHouse/dbt changes.

**Docs:** `docs/production-incident-baseline.md`, `.context/axiom-loading-phase-2.md`, `docs/superpowers/plans/2026-07-02-cross-client-loading-performance-phase-2.md`.

---

## Current Evidence

- Axiom discovery on 2026-07-02 found prod dataset `dofek-logs`.
- Live queries were blocked by the Axiom limiter, including `['dofek-logs'] | take 1` over 5m. Latest trace: `0453ee88edbf80341747ff374392b383`.
- Checked-in Axiom evidence from 2026-06-18 shows `mobileDashboard.dashboard` was fast while `anomalyDetection.check`, `activity.stream`, and ClickHouse queue wait made parent/UI loads slow.

## Test Strategy

- Evidence test: the output document must contain query text, timestamps/window, counts, max/avg/p95 durations, and classification.
- Process test: no backend TDD issue may proceed to implementation unless this baseline names a current backend bottleneck or records Axiom access as blocked.

## File Structure

- Create: `docs/performance/loading-baseline-YYYY-MM-DD.md` - durable evidence report.
- Modify: `.context/axiom-loading-phase-2.md` - raw query notes and blocked traces.
- Modify: related issue comments - link baseline evidence.

## Tasks

### Task 1: Discover And Unblock Axiom

- [ ] Run `rtk /Users/ashercohen/.agents/skills/axiom-sre/scripts/init`.
- [ ] Run `rtk /Users/ashercohen/.agents/skills/axiom-sre/scripts/discover-axiom prod`.
- [ ] Run `rtk sh -c "printf %s \"['dofek-logs'] | getschema\" | /Users/ashercohen/.agents/skills/axiom-sre/scripts/axiom-query prod --since 15m"`.
- [ ] If blocked, record the trace ID and stop backend performance implementation until Axiom access/export is available.

### Task 2: Query Current Slow Paths

- [ ] Query slow tRPC logs by procedure for the largest allowed window.
- [ ] Query `clickhouse.queue_wait` by queue and procedure.
- [ ] Query named suspects: `mobileDashboard.dashboard`, `anomalyDetection.check`, `activity.stream`, `recovery.readinessScore`, `recovery.workloadRatio`, `sync.dataHealth`, `sleep.latestStages`, `healthspan.score`.
- [ ] Query error/failure logs for ClickHouse infrastructure errors and timeouts.

### Task 3: Write The Evidence Taxonomy

- [ ] Create `docs/performance/loading-baseline-YYYY-MM-DD.md`.
- [ ] Classify each slow vector and cite exact query outputs.
- [ ] Identify which follow-up issues are unblocked by evidence and which remain client-only.

### Task 4: Verification

- [ ] Run `rtk pnpm lint` if docs linting applies.
- [ ] Confirm every backend optimization issue references this baseline before code changes.
