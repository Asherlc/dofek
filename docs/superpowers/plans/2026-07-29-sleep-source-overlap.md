# Sleep Source Overlap TDD Plan

> **For agentic workers:** Follow the repository's test-driven development rules. This plan implements existing issue [#2127](https://github.com/Asherlc/dofek/issues/2127); do not create a duplicate issue.

**Goal:** Make each nightly sleep selection auditable by showing the canonical session Dofek selected and any other canonical sessions that overlap it.

**Behavior:** The `daily_sleep` serving model retains the selected canonical sleep-session ID and structured evidence for other `analytics.v_sleep` sessions whose time windows overlap the selected session. The sleep APIs return that server-owned selection evidence. Web and mobile identify the selected provider/device and let the user review each conflicting session's provider/device, interval, and duration.

**Scope:** Enrich the existing ClickHouse `daily_sleep` model and sleep API contracts; update the existing web data-sources table and add an equivalent reusable mobile review component. Preserve the current canonical rules: `analytics.v_sleep` resolves greater-than-80-percent overlap by provider/device priority, then `daily_sleep` selects the longest remaining session per sleep day with latest start as the tie-breaker. Changing provider priorities, ingest-time deduplication, editing/deleting sessions, or treating non-overlapping split sleep as a conflict are non-goals.

**Docs:** [Issue #2127](https://github.com/Asherlc/dofek/issues/2127), [`docs/schema.md`](../../schema.md), [`analytics/README.md`](../../../analytics/README.md)

---

## Current Evidence

- `analytics.v_sleep` forms overlap components only when intersection-over-union exceeds `0.8`, then selects the configured provider/device-priority winner and retains the component's provider IDs in `source_providers`.
- `analytics.daily_sleep` can still receive multiple canonical sessions on one sleep day. It selects the longest session, then latest start, but discards the selected session ID and every competing session.
- The web data-sources table labels `source_providers` as “Also reported by.” That field describes providers collapsed into the selected `v_sleep` component, not a remaining canonical session that disagreed enough to lose the nightly selection.
- `recovery.sleepAnalytics`, which powers the mobile sleep screen, omits all source and selection evidence.
- The existing real-ClickHouse daily-sleep lifecycle test covers winner replacement and tombstones but does not assert overlap evidence.

## Test Strategy

- Unit: ClickHouse repository schemas parse the selected session and overlap evidence; recovery maps that evidence without re-selecting on the client; web and mobile components render selected and conflicting sessions with accessible disclosure controls.
- Integration: the real ClickHouse daily-sleep test seeds two canonical sessions with a true interval overlap below the `v_sleep` dedup threshold, proves the longer session wins, and proves the shorter session is retained as review evidence. It also proves a same-day non-overlapping split session is not mislabeled as an overlap and that incremental refresh/tombstones update the evidence.
- UI/mobile/web parity: both platforms show the same server-provided selected source and conflicting session details. Reusable components have colocated tests and stories, including no-conflict and conflict scenarios.

## File Structure

- Modify: `analytics/models/read_models/daily_sleep.sql` — retain the winner ID and aggregate only canonical sessions that truly overlap it.
- Create/modify: `src/db/clickhouse-migrations/`, `src/db/daily-sleep-read-model.integration.test.ts` — add serving columns and executable ClickHouse coverage.
- Modify: `packages/server/src/repositories/clickhouse-sleep-repository.ts` and focused tests — parse/query the evidence.
- Modify: `packages/server/src/routers/recovery.ts` and focused tests — propagate evidence to the mobile contract.
- Modify: `packages/web/src/components/SleepDataSourcesTable.tsx`, tests, stories, and `packages/web/src/pages/SleepPage.tsx` — review UI and truthful labels.
- Create/modify: `packages/mobile/components/SleepSourceReview.tsx`, tests, stories, and `packages/mobile/app/sleep.tsx` — equivalent accessible mobile review UI.

## Tasks

### Task 1: Add Failing Read-Model Tests

- [ ] Extend the real ClickHouse daily-sleep fixture with a lower-overlap competing session and a non-overlapping split session.
- [ ] Assert the selected canonical session ID and structured overlapping-session evidence.
- [ ] Assert incremental deletion replaces or removes stale overlap evidence.
- [ ] Run `rtk pnpm test:integration -- src/db/daily-sleep-read-model.integration.test.ts`.
- [ ] Confirm failure is caused by the absent serving columns and evidence.

### Task 2: Implement the Canonical Serving Contract

- [ ] Add the ClickHouse migration columns and wire the migration registry.
- [ ] Enrich `daily_sleep.sql` from canonical `analytics.v_sleep`, preserving its existing winner order and aggregating only true interval overlaps.
- [ ] Re-run `rtk pnpm test:integration -- src/db/daily-sleep-read-model.integration.test.ts`.
- [ ] Confirm the executable ClickHouse behavior passes.

### Task 3: Add Failing API Tests

- [ ] Extend repository tests for selected-session and overlap parsing/query projection.
- [ ] Extend recovery tests for the camel-case mobile response contract.
- [ ] Run `rtk pnpm vitest run packages/server/src/repositories/clickhouse-sleep-repository.test.ts packages/server/src/routers/recovery.test.ts`.
- [ ] Confirm failures are caused by the absent API evidence.

### Task 4: Implement API Propagation

- [ ] Parse and select the read-model evidence in all daily-sleep repository queries.
- [ ] Propagate it through `sleep.list` and `recovery.sleepAnalytics` without any client-side precedence calculation.
- [ ] Re-run the focused server tests and confirm they pass.

### Task 5: Add Failing Web and Mobile Tests

- [ ] Assert the web table identifies the selected session, distinguishes merged-source lineage from conflicts, and discloses overlapping session details.
- [ ] Assert the mobile component provides equivalent details with an accessible expanded/collapsed state.
- [ ] Run `rtk pnpm vitest run packages/web/src/components/SleepDataSourcesTable.test.tsx`.
- [ ] Run `rtk pnpm test:mobile -- --run packages/mobile/components/SleepSourceReview.test.tsx packages/mobile/app/sleep.test.tsx`.
- [ ] Confirm failures are caused by the missing review UI.

### Task 6: Implement Platform Parity

- [ ] Update the web table/page mapping and its review scenarios.
- [ ] Add the reusable mobile review component, integrate it into the sleep screen, and add its review scenarios.
- [ ] Re-run focused web/mobile tests and confirm they pass.

### Task 7: Final Verification

- [ ] Run `rtk pnpm lint:migrations`, `rtk pnpm lint:analytics-sql`, and `rtk pnpm lint:analytics-policy`.
- [ ] Run `rtk pnpm lint`, `rtk pnpm tsc --noEmit`, `rtk pnpm --dir packages/server tsc --noEmit`, `rtk pnpm --dir packages/web tsc --noEmit`, and `rtk pnpm --dir packages/mobile tsc --noEmit`.
- [ ] Run `rtk pnpm test`, `rtk pnpm test:integration`, and the required mobile tier.
- [ ] Commit, push, open a PR with `Fixes #2127`, monitor CI/reviews, address feedback, and merge after every required check passes.
