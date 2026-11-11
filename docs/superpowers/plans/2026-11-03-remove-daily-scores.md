# Remove Daily Scores Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for integration;
> platform tasks use superpowers:dispatching-parallel-agents with disjoint files.

**Goal:** Remove the Daily summary and the custom scores behind it everywhere.
**Architecture:** Delete score displays, API fields, and calculations together.
Keep observed metrics and descriptive training-load series.
**Tech Stack:** TypeScript, React, React Native, tRPC, dbt, Vitest.
**Spec:** ../specs/2026-11-03-remove-daily-scores-design.md

## Global Constraints

- Work on the existing branch; no branch changes.
- Preserve observed measurements and established workload metrics.
- No replacement scores, compatibility bridges, or absence-only tests.
- Retire custom recovery, 0–21 strain/targets, sleep performance/need, and
  dependent Today Plan/recommendation calculations.
- Agents own disjoint paths; root integrates and commits/pushes verified work.

## Review Focus

- Dashboard insights must load without waiting for removed queries.
- Recovery and Training screens retain observed data and navigation.
- Server schemas and clients agree after score fields are removed.
- Personalization and analytics must not continue calculating retired scores.
- Current docs describe retained behavior; historical records remain intact.

### Task 1: Web removal

- [x] Remove DailyOverview and dependent score, target, sleep-need, Today Plan
  displays and queries throughout packages/web, including stories/fixtures.
- [x] Update/delete existing tests for changed/deleted behavior. Run targeted
  web tests and review retained dashboard states.

### Task 2: Mobile removal

- [x] Remove equivalent score, target, sleep-need, Today Plan displays and
  queries throughout packages/mobile, preserving real routes and observations.
- [x] Update/delete affected tests, stories, and fixtures; run targeted tests.

### Task 3: Backend and algorithm retirement

- [x] Remove score APIs/contracts/services, shared score calculations, and
  dependent recommendations/personalization/read-model calculations outside
  packages/web and packages/mobile. Preserve raw metrics and workload series.
- [x] Update surviving tests; delete retired tests and run focused suites.

### Task 4: Integration and review

- [x] Review all task diffs and update active documentation.
- [ ] Run typecheck, affected unit/mobile tests, lint/schema checks as applicable.
- [ ] Resolve any remaining consumers, perform independent review, commit and
  push the current branch. Report verification and concise retrospective.
