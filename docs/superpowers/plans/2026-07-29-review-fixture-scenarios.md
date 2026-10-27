# Review Fixture Scenarios TDD Plan

> **For agentic workers:** Implement the tasks in test-first order. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make empty, partial, conflicting-source, stale-provider, processing,
and error states explicit and discoverable in the paired web and mobile review
fixtures.

**Behavior:** Reviewers can search Storybook for each named review scenario and
inspect the equivalent web and mobile UI state without changing the populated
review database.

**Scope:** Reuse the existing Storybook fixture system and real UI components.
Add only missing fixture behavior, explicit scenario names/tags, and a human
review matrix. Do not add alternate review users, production-only branches, or
a second fixture framework.

**Docs:** [Issue #2202](https://github.com/Asherlc/dofek/issues/2202),
[web Storybook](../../../packages/web/README.md),
[mobile Storybook](../../../packages/mobile/README.md).

---

## Current Evidence

- `scripts/seed-dev-db.ts` intentionally creates one populated reviewer
  account; mutating it into an empty or request-error account would break the
  normal review login.
- `ProcessingStatusWidget.stories.tsx` already models processing, partial, and
  API-error states on both platforms.
- `ActivitySourceDecisionCard.stories.tsx` already models multiple conflicting
  sources on both platforms.
- Empty and provider state examples exist, but scenario names are inconsistent
  and a clearly stale provider fixture is absent.

## Test Strategy

- Unit: add focused render assertions only where a missing scenario requires
  new behavior; do not test static Storybook metadata.
- Storybook: build both web and mobile Storybooks so Component Story Format,
  typed args, and runtime fixture imports are validated.
- UI/mobile/web parity: every audit scenario must have a named web story and a
  named mobile story.

## File Structure

- Modify: paired web/mobile Storybook files for query state, processing status,
  source decisions, dashboard partial/empty data, and provider freshness.
- Modify: colocated component tests only when the fixture exposes previously
  untested render behavior.
- Create: `docs/review-fixture-scenarios.md` - paired scenario lookup matrix.
- Modify: `docs/README.md` - link the active review-fixture reference.

## Tasks

### Task 1: Add Failing Behavior Tests

**Files:**

- Modify the focused provider-card tests if stale-provider presentation needs
  new visible behavior.
- Modify the focused dashboard tests if the explicit empty/partial fixtures
  expose missing render coverage.

- [ ] Write failing assertions for the missing visible state.
- [ ] Run the focused Vitest command.
- [ ] Confirm failure is caused by the missing behavior, not fixture setup.

### Task 2: Add Paired Review Stories

**Files:**

- Modify the smallest existing paired story files that render each real
  component.

- [ ] Add explicit `Empty data` stories.
- [ ] Add explicit `Partial data` stories.
- [ ] Add explicit `Conflicting sources` stories.
- [ ] Add explicit `Stale provider` stories.
- [ ] Add explicit `Processing` stories.
- [ ] Add explicit `Error` stories.
- [ ] Tag each story with `review-scenario` plus its specific scenario tag.
- [ ] Re-run focused tests and confirm they pass.

### Task 3: Document the Review Matrix

**Files:**

- Create: `docs/review-fixture-scenarios.md`
- Modify: `docs/README.md`

- [ ] List each scenario and its paired web/mobile Storybook location.
- [ ] Explain why transient scenarios live in Storybook while `pnpm seed`
  remains the realistic populated full-stack fixture.
- [ ] Link the source story files as evidence.

### Task 4: Final Verification

- [ ] Run `pnpm lint`.
- [ ] Run `pnpm tsc --noEmit`.
- [ ] Run `pnpm --dir packages/server tsc --noEmit`.
- [ ] Run `pnpm --dir packages/web tsc --noEmit`.
- [ ] Run the relevant web and mobile unit tests.
- [ ] Run `pnpm storybook:web:build`.
- [ ] Run `pnpm storybook:mobile:build`.
- [ ] Commit and push after each meaningful passing chunk.
