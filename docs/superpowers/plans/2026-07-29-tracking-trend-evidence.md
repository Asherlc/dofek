# Tracking Trend Evidence TDD Plan

Write each failing test before its implementation.

**Goal:** Make journal trends understandable without implying statistical certainty the data contract cannot support.

**Behavior:** Web and mobile render the same server-authored journal trend evidence: visible date bounds, explicit missing days, exact accessible observations, a concise coverage statement, and an explicit unavailable uncertainty status.

**Scope:** Replace the unused single-question `journal.trends` response with one canonical multi-series evidence response. Preserve raw journal entries and provider provenance. Do not calculate a confidence interval, causal effect, or directional trend from raw multi-provider observations. Preserve the Behavior Impact contract from issue #2158 because it already exposes its exact descriptive comparison and truthful unavailable-interval status.

**Docs:** Issue [#2157](https://github.com/Asherlc/dofek/issues/2157), the strategy comment on that issue, and the existing Behavior Impact plan at `docs/superpowers/plans/2026-07-28-behavior-readiness-associations.md`.

---

## Current Evidence

- The web Tracking page builds series client-side from `journal.entries`, omits missing dates, and exposes exact values only in a pointer tooltip.
- `TimeSeriesChart` already uses a visible time axis, but its accessible description does not identify the displayed date window or exact observations.
- The unused `journal.trends` endpoint returns only non-null observations for one question and has no evidence metadata.
- Mobile has no equivalent journal trend-review surface.
- Behavior Impact already shows exact values, sample counts, its selected window, and “uncertainty interval not available” on web and mobile after issue #2158.

## Test Strategy

- Server unit: verify one response contains question metadata, daily null gaps, exact observations, date bounds, a server-authored coverage statement, and a discriminated unavailable uncertainty status.
- Server integration: execute the journal query against Postgres and verify create/update/delete changes the evidence response without losing missing dates.
- Web: verify the Tracking tab consumes `journal.trends`, renders dates, gap/uncertainty copy, exact accessible values, and passes daily nulls to the chart.
- Mobile: verify the matching screen renders the same contract, handles loading/error/empty states, changes ranges, and is reachable from Settings.
- Stories: add representative gap-heavy and empty/loading states for both platform surfaces.

## Tasks

### Task 1: Define the Server Contract Test-First

- [x] Add failing repository/router tests for the multi-series evidence response.
- [x] Add failing integration assertions for real Postgres date-gap behavior.
- [x] Implement the repository query and server-owned evidence builder.
- [x] Confirm focused server tests pass.

### Task 2: Add Failing Web Tests

- [x] Update the Journal panel test double to expose `journal.trends`.
- [x] Assert visible date bounds, missing-day semantics, exact values, coverage copy, and unavailable uncertainty.
- [x] Assert chart series include server-provided null days.
- [x] Confirm focused web tests fail before implementation.

### Task 3: Implement Web Tracking Evidence

- [x] Replace client-side trend derivation with the canonical endpoint.
- [x] Render server-authored evidence and an accessible exact-values disclosure.
- [x] Extend the chart accessibility description with the date window and gap semantics.
- [x] Add representative paired Storybook scenarios.
- [x] Confirm focused web tests and Storybook build pass.

### Task 4: Add Failing Mobile Parity Tests

- [x] Add screen tests for evidence, range selection, loading/error/empty states.
- [x] Add a Settings navigation test.
- [x] Confirm the mobile tests fail because the parity surface is absent.

### Task 5: Implement Mobile Parity

- [x] Add an SVG trend chart with visible date bounds and explicit missing-day marks.
- [x] Render exact observations and the server-authored evidence text.
- [x] Add Settings navigation and stack registration.
- [x] Add representative mobile stories.
- [x] Confirm focused mobile tests pass.

### Task 6: Final Verification and Delivery

- [x] Run focused server, web, and mobile suites.
- [x] Run lint, root/server/web/mobile typechecks, required unit tiers, and Storybook builds.
- [x] Review the complete diff for unsupported statistical or causal claims.
- [ ] Commit, push, open a PR with `Fixes #2157`, link it bidirectionally, monitor CI/reviews, address actionable feedback, and merge.
