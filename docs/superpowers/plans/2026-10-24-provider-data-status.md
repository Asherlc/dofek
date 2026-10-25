# Provider data status implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development and TDD.

**Goal:** Show the latest evidenced provider sync outcome on web and mobile, and a neutral status when no outcome has been recorded.

**Approved direction:** The user approved correcting the summary on both platforms. Connection and authorization remain separate from sync outcomes. Reconnecting alone does not prove successful delivery.

**Architecture:** Reuse the existing `sync.providers` recent logs and processing snapshot through a shared presentation helper in `packages/providers-meta`. Preserve newer processing progress and failure detail. Keep pipeline readiness semantics and persisted data unchanged. Reuse the existing status card with an explicit neutral presentation tone.

**Constraints:** No dependencies, schema changes, fabricated processing events, production mutations, or branch changes. A successful sync can contain zero records. Use recorded successful sync time for “Last received”; failed attempts must not be represented as received data.

**Review focus:** Empty history; newer failures overriding older success; newer active processing overriding older failed logs; equal timestamps preferring failure; degraded/unknown outcomes; push-only providers with no successful receipt; query errors staying visible.

### Task 1: Correct shared presentation and both clients

- [x] Write failing shared behavior tests for empty, failed, degraded, successful, unknown, stale and newer processing outcomes, including timestamp ties.
- [x] Add failing web/mobile render tests reproducing the empty-history green banner and failed-log contradiction, plus correct receipt timestamps.
- [x] Run targeted unit/mobile tests and confirm failures reflect the bug.
- [x] Implement a shared provider-status presentation selector and wire provider detail pages and existing processing widgets to it. Extend status-card presentation with a neutral tone without changing pipeline status types.
- [x] Run targeted tests, formatting and typechecks. Review the diff for parity and errors remaining visible.
- [x] Review specification compliance and code quality independently; fix confirmed findings and prepare the verified change for commit and push.

### Task 2: Record Garmin reconnect investigation

- [x] Read current production OAuth/delivery evidence and portal settings when available; do not mutate production.
- [x] Append confirmed evidence, unresolved gaps and next steps to `docs/production-incident-baseline.md`, citing source code and authoritative references.
- [x] Verify the final diff and record production state separately from the code fix, including a short retrospective.

## Working notes

- Investigation confirmed `ProcessingRepository.status()` defaults missing operation state to `ready`, which the always-visible widget labels as completed sync. Existing sync logs are an independent source of outcome evidence.
- Preflight: Task 2 is read-only and documentation-only; Task 1 owns all product/test edits. No shared mutation interfaces.
- Approach approval is already recorded in this session; proceed without another approval gate.
- Additional user request: verify Paseo teardown removes Docker networks. Existing `paseo.json` already invokes `scripts/workspace-archive.ts`, merged October 19 in `e61284ec3` / PR #3008. The script removes the owning default, E2E and PeerDB stacks through Compose. All 11 archive/project-identity tests passed; no redundant hook or prune added. Paseo documents the lifecycle in its [worktree guide](https://paseo.sh/docs/worktrees#setup-and-teardown).
- Focused validation: 208 tests across shared presentation, web/mobile widgets and provider detail pages passed with retries disabled. Independent review resolved mixed-dataset progress, dismissed-outcome ordering, post-reconnect actions and superseded-operation regressions. Root, server, web, mobile and provider-metadata TypeScript checks passed. Browser DOM checks confirmed neutral and failure copy and border tones; screenshot capture was unavailable.
- Final validation: `pnpm test run --retry=0 --maxWorkers=4` passed 20,511 tests in 1,324 files (19 tests and two files skipped). Full `pnpm lint` passed, including analytics SQL lint. The unchanged ClickHouse startup command succeeded after the approved unused-network cleanup; no production behavior, retry or timeout policy was changed.
- Hosted mutation follow-up: 28 additional behavioral cases bring the focused suite to 236 passing tests. Simplified three redundant expressions after checking producer invariants; the original CI mutation ranges pass locally at 100% (124 killed, no survivors or uncovered mutants), with unchanged policy. Independent review approved this follow-up. The [incident baseline](../../production-incident-baseline.md#2026-10-24--provider-summary-mutation-coverage-failed-after-functional-tests-passed) records the first hosted failure and validation boundary.
