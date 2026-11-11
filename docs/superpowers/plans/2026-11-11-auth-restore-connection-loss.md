# Auth restore connection loss implementation plan

> **For agentic workers:** Use superpowers:executing-plans for this single task, with TDD and a final independent review.

**Goal:** Keep the approved auth restore connection-loss outcome observable without creating exception issues.

**Approved design:** Recognize only `fetch failed: The network connection was lost.` from `auth-state-restore`, using the existing shared handled-failure classifier and mobile operational log/count pipeline. Keep session behavior unchanged. The user approved this scope and requested implementation. Existing offline restore/retry behavior shipped in [PR #3086](https://github.com/Asherlc/dofek/pull/3086). Apple's [connection-loss guidance](https://developer.apple.com/library/archive/qa/qa1941/_index.html) does not identify this incident's physical cause.

**Architecture / stack:** Extend `classifyHandledFailure(error, source?)` with source-scoped `connection_lost`; mobile passes its existing source. Other callers retain existing behavior. TypeScript and Vitest; no dependencies or new runtime abstractions.

## Constraints and review focus

- Keep storage, authorization, parsing/schema failures and cyclic/unknown causes reportable, even under a copied transport wrapper.
- Do not broaden other sources, native error messages, or generic network strings.
- Verify retained correlated logs, breadcrumbs and `handled_failure` counts through mobile telemetry.
- Verify saved-session preservation and token-only retry with this exact error through existing auth tests. Device recovery remains separately pending.
- Do not switch branches, deploy, auto-merge or resolve Sentry without release/recovery evidence.

## Task 1: Source-scoped operational reporting

- [x] Finish the interrupted frozen-lockfile install serially; do not initialize databases or indexes for this code change.
- [x] Extend `packages/telemetry/src/handled-failure.test.ts` with the exact message/source, wrapper and unexpected-cause cases. Extend existing tables in `packages/mobile/lib/telemetry.test.ts` and auth restore tests rather than splitting tests or exceeding 1,000 lines per file.
- [x] Run the focused unit/mobile tests with one worker; observe the new classifier/reporting regressions fail before implementation.
- [x] Add optional source context and the exact cause-aware classification in `packages/telemetry/src/handled-failure.ts`; pass source from `packages/mobile/lib/telemetry.ts`.
- [x] Run focused tests green, review the diff, and update `docs/sentry.md` and the incident baseline with scope and validation limits.
- [ ] Run full lint, the Docker-free unit/mobile tier with one worker, and root/server/web/mobile typechecks. Prepare only workspace ClickHouse if required by lint, using the Compose wrapper.
- [ ] Obtain independent whole-diff review; correct findings, rerun affected checks, commit and push automatically. Open a PR through the existing GitHub workflow; keep release/device evidence explicit.

## Working review checkpoints

Plan self-review: one task, no shared interfaces between tasks. The optional source argument has a concrete mobile caller; existing web callers remain unchanged because this is an iOS auth-source policy. Source gating and leaf-cause traversal are reviewed separately from session recovery. No additional retry, fallback or timeout is needed.

Pre-push checkpoint: 2 expected failing tests before implementation; 107 focused tests pass afterward. Full lint, all five relevant typechecks, source spelling and independent review passed. Full Docker-free tests continue while PR CI runs, following the existing ship workflow; their final results belong in the PR and execution ledger. Production release and physical-device recovery remain separately pending.
