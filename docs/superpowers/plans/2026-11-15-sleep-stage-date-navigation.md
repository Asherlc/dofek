# Sleep Stage Date Navigation Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement the approved plan task by task. Do not recursively delegate.

**Goal:** Browse individual nights' sleep stages on web and mobile, with the web timeline above Data Sources.

**Architecture:** Add a date-aware sleep query that reuses the current overlapping-session stage lookup. An omitted date means the latest recorded night; an explicit date means exactly that sleep day, including an empty result for a missing night. Both clients keep timeline selection independent of the trend range.

**Tech Stack:** Existing tRPC, Zod, Postgres/ClickHouse repositories, React, React Native, and existing native date picker.

**Spec:** The user approved the three-step plan in this conversation on 2026-11-15 and subsequently reported an empty stage chart. This document records that scope; no additional approval is needed for implementation.

## Global Constraints

- Remain on branch `whoop-sleep-stage-data-by-time` in the existing worktree.
- Reuse existing date controls, dependencies, stage charts, sleep-day semantics, and overlapping-source selection.
- Default to the latest recorded night; selected dates must never silently show another night.
- Keep trend range and timeline date independent, and disallow future dates.
- Web section title: `Night’s Stages`; place above `Data Sources`. Provide equivalent date selection on mobile.
- Keep loading, empty, error, and cached-refresh-error states distinct; never display the old date's stages under a new date.
- Preserve current API compatibility for installed mobile clients and user/access-window restrictions.
- Write regression tests before production edits and observe RED then GREEN. Run noninteractive tests through pnpm and prefix shell commands with rtk.
- No branch changes, new dependencies, production writes, speculative abstractions, or recursive delegation. Commit and push after passing required checks.

## Review Focus

- An explicit missing date returns no intervals, rather than the last earlier night.
- Overnight windows and overlapping providers use the same existing sleep-day definition.
- Browsing dates preserves selection across background refreshes and trend-range changes.
- Empty/error states leave date navigation available, and cached data is identified with its actual date.
- Latest selection outside the current trend range and restricted access windows remain correct.

### Task 1: Date-aware timeline on both clients

**Files:** Modify `packages/server/src/repositories/sleep-repository.ts`, `packages/server/src/routers/sleep.ts`, their colocated tests and a focused real-engine integration test; `packages/web/src/pages/SleepPage.tsx`, its tests and affected time-range test helpers; `packages/mobile/app/sleep.tsx`, `packages/mobile/app-tests/sleep.test.tsx`, affected stories; relevant package README notes.

**Interfaces:** Add `sleep.stagesByDate` with validated optional `{ date?: YYYY-MM-DD }` input and `{ date: YYYY-MM-DD | null, stages: { stage, started_at, ended_at }[] }` output. Keep existing `latestStages` compatible. Use `fetchSleepNights({days: 0, endDate: date, ...})` for exact dates and `fetchLatestSleepNight` for initial selection. Reuse the existing raw overlapping-session query through one private repository method. Clients consume the response date for the initial selection, not the trend list's last row.

- [ ] Add failing repository/router/UI regressions for exact date, latest default, missing dates, selected date persistence, disabled future navigation, date changes, empty/error navigation, and web ordering.
- [ ] Run focused tests and record the expected RED failures before implementation.
- [ ] Implement the minimal query and date controls. Use the stock web date input and installed native date picker with Previous/Next controls; retain correct cache/error handling.
- [ ] Run focused unit/mobile tests and a real database regression for overlap selection, missing dates, and ownership. Use the canonical integration wrapper.
- [ ] Review scope, types, source selection, and date state. Update short code-adjacent documentation with implementation links, not unsupported external claims.
- [ ] Report validation and hand the diff back to the lead; lead runs whole-scope checks before committing and pushing.

### Task 2: Diagnose and fix the reported blank stage chart

**Files:** Determine from evidence; begin with `packages/web/src/components/Hypnogram.tsx`, `DofekChart.tsx`, and their chart/data helpers. Keep edits separate from Task 1's files.

**Interfaces:** Preserve the stage chart input contract. Establish whether the production symptom comes from API intervals, timestamp parsing, chart bounds, or rendering before editing.

- [ ] Inspect the existing Firefox session and live chart/data if attachment is verified; otherwise use computer control of the running Firefox app. Reproduce locally using existing fixtures when needed.
- [ ] Record the actual failure and causal explanation, then add the smallest failing regression.
- [ ] Apply the direct fix and observe GREEN; validate with an actual rendered chart where available.
- [ ] Append the required incident baseline entry if production debugging establishes an incident. Keep transient diagnostics out of production code.
- [ ] Run required lint, all-package typechecks, relevant unit/mobile and database checks; obtain an independent whole-change review, resolve material findings, commit and push.
