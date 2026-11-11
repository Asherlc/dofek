# Auth restore connection loss implementation plan

> Execute each task in order: reproduce the failure with a focused check, make the minimum correction, rerun that check, complete the required validation, and obtain independent diff review before shipping.

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
- [x] Run full lint, the Docker-free unit/mobile tier with one worker, and root/server/web/mobile typechecks. Prepare only workspace ClickHouse if required by lint, using the Compose wrapper.
- [x] Obtain independent whole-diff review; correct findings, rerun affected checks, commit and push automatically. Open a PR through the existing GitHub workflow; keep release/device evidence explicit.

## Working review checkpoints

Plan self-review: one task, no shared interfaces between tasks. The optional source argument has a concrete mobile caller; existing web callers remain unchanged because this is an iOS auth-source policy. Source gating and leaf-cause traversal are reviewed separately from session recovery. No additional retry, fallback or timeout is needed.

Pre-push checkpoint: 2 expected failing tests before implementation; 107 focused tests pass afterward. Full lint, all five relevant typechecks, source spelling and independent review passed. Full Docker-free tests continue while PR CI runs, following the existing ship workflow; their final results belong in the PR and execution ledger. Production release and physical-device recovery remain separately pending.

## Task 2: Approved Expo patch alignment

CI's `pnpm expo install --check` rejected Expo 58.0.23 and 15 companion packages before bundling. The user approved aligning the flagged packages to the SDK-recommended stable patches in this PR; see [Expo's validation contract](https://docs.expo.dev/more/expo-cli/#version-validation).

- [x] Finish the existing local full test run before changing dependencies; notify the resource coordinator when it ends.
- [x] Update the 16 flagged package pins and required SDK lockfile resolutions using registry-confirmed stable versions and `pnpm add --save-exact`; preserve the existing Apple and XML parser patches on their new package versions.
- [x] Verify `pnpm expo install --check`, required lint/typechecks and focused regressions. Defer new broad/native validation until resource coordination permits it.
- [x] Review and publish the narrow SDK diff separately; fix the two valid documentation review comments without changing historical incident evidence.
- [ ] Finish the cleared mobile-only tier and matching-head CI. Preserve release/device acceptance boundaries.

Scoped checkpoint: frozen installation, Expo compatibility, full lint, five typechecks, 107 focused tests, the existing Foundation-only diagnostic fixture, real XML parsing smoke and canonical source spelling passed. Independent review found no SDK blockers. Narrow common commit: `18638288204e1910f8002a9d15c976c2bea6e38d`. The cleared mobile-only tier subsequently passed 2,147 tests across 209 files in 237.40 seconds; PR CI remains pending. No additional native build or production publication is authorized by this checkpoint.
