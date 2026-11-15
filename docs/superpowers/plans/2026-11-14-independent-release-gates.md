# Independent Release Gates Implementation Plan

**Goal:** Shorten PR opened → validated → merged → deployed while preserving
all applicable checks and making every transition navigable in GitHub.

**Architecture:** Keep `ci.yml` as the orchestrator. Extract checks into
independent reusable workflows and let each main-branch publisher depend on
its own checks and immutable artifact. Preserve required PR status names and
use native job graphs, summaries, artifacts, and deployment records for tracing.

**Tech stack:** GitHub Actions, existing composite actions, pnpm, TypeScript,
Vitest/Istanbul, Stryker, Swift checks, GitHub deployment APIs, Docker Swarm.

**Spec:** [Approved design](../specs/2026-11-14-independent-release-gates-design.md).
Read it together with this plan. Follow the task order, review each deliverable,
and commit/push each meaningful verified chunk on the current branch.

## Global constraints

- Existing workspace/branch: `decouple-ios-deploy-from-server-ci`; no branch
  switching, new worktrees, or rebase is authorized.
- Preserve every existing required check context and GitHub App source. Never
  modify repository settings or introduce deployment approvals.
- No coverage/mutation threshold reductions, nightly substitutes, hidden skips,
  new suppressions, retries, or bypass paths. Database behavior stays real-engine.
- Native runtime policy stays `fingerprint`; preserve manifest, signature,
  asset, image/source, migration, and TestFlight receipt verification.
- Server/web/worker remain one Swarm release. Terraform stays on the initial
  server release path. Duplicate native archive optimization is deferred.
- Use existing tools and workflows. No dashboard, controller service, custom
  dispatcher, contract registry, or general-purpose workflow generator.
- Prefix shell commands with `rtk`; use pnpm and noninteractive tests. Follow
  development/test policies and local READMEs before executable changes.
- New client API requirements need a verified additive server deployment before
  client activation; same-checkout types do not establish API compatibility.

## Review focus

- A source rename/deletion or shared dependency selects every consumer, not
  just the directory containing the changed file (Task 2).
- A selected job/matrix worker that skips, fails, or is canceled must block its
  target; empty or missing selection cannot mean success (Tasks 3 and 5).
- An older slow build cannot replace a newer live release, including when the
  newer release failed verification/finalization (Task 4).
- PR, merge, manual-image, and rerun revisions cannot be confused; artifacts
  and authorization must refer to the selected immutable source (Tasks 4–5).
- GitHub must show partial success and unresolved publication accurately,
  with direct navigation between actual producer/publisher runs (Tasks 6–7).

## File boundaries and interfaces

Existing files remain authoritative for setup, platform builds, verification,
and domain tests. New YAML files below contain extracted existing jobs, not
new application infrastructure.

| File | Responsibility |
| --- | --- |
| `scripts/detect-ci-changes.ts` and its colocated test | Conservative affected-area selection using the existing dependency graph |
| `.github/workflows/detect-changes.yml` | Selection outputs and consistent checked revision |
| `.github/workflows/check-repository.yml` | Database-free repository safety/policy jobs |
| `.github/workflows/check-shared.yml` | Shared pure-domain test/coverage/mutation jobs |
| `.github/workflows/check-server.yml` | Server/web, real engines, image scan, migrations, and applicable infrastructure checks |
| `.github/workflows/check-mobile.yml` | Mobile/Swift checks and mobile policy jobs |
| `.github/workflows/test.yml` | Existing required `Test / …` reporting contexts using explicit extracted results |
| `.github/workflows/ci.yml` | Selection, parallel checks/builds, PR aggregate, independent main release dependencies, final summary |
| Existing build/deploy workflows | Exact-source artifact handoff and target-specific publication |
| Existing deployment/verification scripts | Target provenance, ordering, and intent finalization |
| `.github/actions/append-dispatcher-run-summary/action.yml` | Existing backward run link; reuse rather than add a dispatcher |
| `docs/testing.md`, `deploy/README.md`, `scripts/README.md` | Check ownership, operator recovery, and GitHub navigation |

Every extracted check workflow receives explicit `commit_sha` and applicable
boolean selections. Every job checks out `commit_sha`; PR selection uses its
full diff, validation uses the candidate merge SHA, and main uses the pushed
SHA. Check workflow result is authoritative; outputs must not let a caller
proceed before all owned prerequisites finish. Reporting workflows receive
result strings (`success`, `failure`, `cancelled`, `skipped`) and expected
selection booleans; they do not invoke checks a second time.

## Task 1: Establish ownership, required contexts, and baseline

**Files:** Modify `docs/testing.md` and `deploy/README.md`; read all current
workflows, `vitest.config.ts`, `vitest.config.mutation.ts`, `stryker*.json`, and
the root `package.json`. Save raw baseline reports outside the repository.

**Produces:** An exhaustive existing-job → owner map; source/test/coverage
ownership; exact protected contexts; representative run URLs and timings.

- [ ] Read the approved design and local policies. Inspect main CI, protection,
  active rulesets, and deployment environments with read-only `gh` commands.
- [ ] Map every job currently in `test.yml`, every root lint subcommand, and
  every native build check to repository/shared/server/mobile/other ownership.
  Assign all job IDs, including quality/security aggregates, coverage,
  mutation discovery/merge, native FIT, CDC/Pulsar, ML, and Zepp. Mark genuinely
  shared commands explicitly; none may disappear during extraction.
- [ ] Record these protected contexts: `CI Gate`, `SAST Scan`,
  `CodeQL Analysis (javascript-typescript)`, `Test / Lint & Static Analysis`,
  `Test / Security & Dependencies`, `Test / Unit & Integration Tests`,
  `Test / E2E Tests (Web)`, `Test / Mutation Testing`, and
  `Build Mobile / Mobile Build Gate`. Preserve any additionally discovered rule.
- [ ] Save `gh run view <id> --json jobs,createdAt,updatedAt,url,headSha` for
  representative mobile, server, and shared PR/main runs. Pair merged PR and
  deployment timestamps; separate human review time, queue time, validation,
  and rollout. Record baseline limitations rather than inventing precision.
- [ ] Diff-review the map against the original jobs/commands and commit/push
  the runbook additions. No runtime behavior changes in this task.

## Task 2: Make selection and source handling safe for lane extraction

**Files:** Modify `scripts/detect-ci-changes.ts`,
`scripts/detect-ci-changes.test.ts`, `.github/workflows/detect-changes.yml`,
and extracted workflow callers as introduced by Task 3.

**Consumes/produces:** Preserve the existing boolean outputs (`mobile`, `web`,
`docker_server`, `docker_ota`, `terraform`, `zepp`, and remaining outputs).
Server release selection is `docker_server || web || terraform || docker_ota`;
mobile validation/publication selection initially remains conservative
`mobile`. Native archive selection additionally uses the existing
`requiresTestFlightUpload(repository, commitSha, force)` receipt baseline.
Do not build a second runtime import graph just to avoid an unchanged OTA.

- [ ] Extend existing CLI behavior tests with these concrete assertions:
  mobile code selects mobile and not server; shared IMU selects both; server
  API changes can select mobile typechecks; docs select no app build; each
  extracted check workflow, test config, setup action, and root toolchain input
  selects its owners conservatively; critical orchestration changes select all.
- [ ] Add temporary-Git fixture tests proving `--diff-range` includes both
  deleted and renamed inputs, a multi-commit push, and shared consumer changes.
  Missing inputs or an invalid diff must fail rather than produce false values.
- [ ] Run `rtk pnpm exec vitest run --project unit scripts/detect-ci-changes.test.ts`
  and observe the new cases fail before changing executable selection logic.
- [ ] Extend existing classification patterns/graph traversal minimally. Add an
  optional `commit_sha` workflow input defaulting to the event revision; use
  the candidate merge SHA for PR validation and the pushed SHA for main.
  Keep full-PR versus full-push change ranges distinct from source checkout.
- [ ] Rerun the focused tests, review actual detector outputs for the scenario
  matrix, and commit/push. No new publishers activate.

## Task 3: Extract checks and preserve the complete quality baseline

**Files:** Create the four `check-*.yml` workflows listed above; modify
`test.yml`, `ci.yml`, `vitest.config.ts`, `vitest.config.mutation.ts`,
`stryker.ci.config.json`, root lint scripts, and `docs/testing.md` as needed.

**Produces:** Independently awaitable repository/shared/server/mobile checks;
the same protected PR contexts; documented scoped test and coverage accounting.

- [ ] Move existing jobs without first changing their commands, thresholds,
  pinned actions, timeouts, diagnostics, or artifact retention. Server owns
  ClickHouse lint/regressions, integration, native FIT, CDC/Pulsar, migration,
  web E2E, and image scan. Mobile owns Swift/Periphery, mobile tests/policies,
  native mutation discovery/workers/completeness, and client checks. Keep
  repository security/audit/license checks shared initially.
- [ ] Separate root database-free lint from server SQL/regression work using
  existing subcommands. Preserve telemetry, route, import-boundary, story,
  and cross-platform parity policies under explicit owners.
- [ ] Enumerate the current test suites before filtering, using Vitest's list
  output. Define source-owned shared/server/web/tooling selections in the
  existing configs; preserve full suites of selected packages and consumers.
  Run the shared pure-domain selection for mobile and server consumers. Never
  use only changed test files as the functional baseline.
- [ ] Keep current coverage floors exactly: lines/statements `93.5`, functions
  `94.5`, branches `89`, changed-line coverage `80`. Verify scoped source
  ownership and complete shard inputs with existing Istanbul/nyc tooling.
  Keep the existing merged report whenever its source owners run. A package
  partition that cannot meet equivalent protection remains explicitly shared
  until tests/accounting are corrected; do not claim full isolation meanwhile.
- [ ] Preserve existing Stryker thresholds and changed-line mutation selection;
  partition by source ownership without omitting shared-domain mutations.
  Preserve Swift campaign completeness. Integration tests stay outside mutation
  collection. Do not broaden or weaken current thresholds or exclusions.
- [ ] Keep `test.yml` as small reporting jobs with the original display names.
  Reports fail for any selected prerequisite that is not successful. `CI Gate`
  also explicitly needs successful detection and every selected lane/build.
  Expected unselected jobs may report not applicable; missing selected matrix
  output or failed discovery is never an empty successful campaign.
- [ ] Use actionlint/schema validation and review for YAML; no YAML-substring
  unit tests. Exercise real Actions validation runs without enabling deploys
  to prove selected failures/cancellations/skips propagate, unrelated lanes
  finish independently, and every required status still reports.
- [ ] Review the exhaustive Task 1 map, suite enumeration, coverage artifacts,
  mutation reports, and protected contexts before commit/push and advancement.

## Task 4: Enforce forward-only, recoverable target publication

**Files:** Modify `scripts/testflight-deployment.ts` and its test;
`.github/workflows/deploy-ios.yml`, `deploy-ota.yml`, `deploy-web-stack.yml`;
existing image/OTA verification scripts and their colocated tests if their
interfaces need target identity. Update `scripts/README.md` and deploy runbook.

**Interfaces:** Preserve the production TestFlight functions and CLI commands:
`requiresTestFlightUpload`, `prepareTestFlightUpload`, `recordTestFlightUpload`.
Server/OTA publication use GitHub deployment records and `gh`/`git` directly
inside their existing publisher workflows; do not add a release controller or
generic CLI. Their identity is source SHA plus image digest or OTA UUID/runtime.

- [ ] Add failing TestFlight behavior tests: an older candidate after a newer
  successful upload is superseded; a non-ancestor fails; unresolved upload
  intent blocks promotion; repeat finalization preserves the original receipt.
  Run the colocated test and observe red before changing the implementation.
- [ ] Under each existing per-target publication lock, read target records and
  unresolved attempts, verify live identity, and compare source ancestry using
  `git merge-base --is-ancestor`. Successful same-source/identity is a no-op;
  older source is superseded; non-ancestor/unknown state fails. Record intended
  source and publisher run/attempt before mutation, then finalize that same
  deployment only after verification. Preserve unresolved state on failure.
- [ ] Preserve full history pagination and authoritative latest status. For
  server, keep immutable image/source/migration guards. For OTA, preserve
  `verify-published-ota.ts` signature/assets/unchanged-content behavior. Native
  upload success remains distinct from Apple's later processing availability.
- [ ] Test publication recovery without touching production: a newer release
  becomes live, finalization fails, then an older candidate arrives. Verify the
  publication path blocks pending reconciliation and cannot double-publish or
  roll backward. Exercise the actual executable workflow steps with controlled
  GitHub CLI/live-verifier fixtures; inspect produced records and exit codes,
  rather than asserting declarative YAML strings. Require real target evidence
  for operator reconciliation; no success inferred from workflow completion.
- [ ] Run TestFlight and any modified verifier/image tests noninteractively;
  review cancellation and upload-success/receipt-failure paths. Document exact
  reconciliation and explicit rollback procedures, then commit/push.

## Task 5: Wire independent main releases and consistent manual entry points

**Files:** Modify `ci.yml`, `deploy-web.yml`, `deploy.yml`,
`deploy-web-environment.yml`, `build-docker.yml`, `build-ios-release.yml`,
`deploy-ios.yml`, `deploy-ota.yml`, and `build-mobile.yml` only where needed.

**Consumes:** Task 2 selections/source, Task 3 check results, Task 4 target locks
and provenance. **Produces:** Main server, OTA, and native publication jobs
whose dependencies do not include unrelated lanes or reporting aggregates.

- [ ] Return `commit_sha` and immutable image reference from the server build;
  preserve signed archive `commit_sha`, `artifact_id`, and `build_number` outputs.
  Every consumer validates its exact source/artifact. Do not promote PR binaries
  as main binaries or use current-main validation for a manual image revision.
- [ ] Main server publication needs repository safety, shared/server checks,
  and its image. OTA needs repository safety, shared/mobile checks, and current
  runtime validation. Native upload also needs all native prerequisites plus
  the matching signed archive. Until native-only validation is safely split,
  both mobile publishers also await the existing `Build Mobile / Mobile Build
  Gate`; retain native checks for selected mobile changes and label that cost.
- [ ] Start main builds concurrently with checks; only publication waits for
  their completion. Keep PR cancellation; make main validation concurrency
  unique per run, with independent noncanceling server/native/OTA mutation locks.
  Keep each lock across intent, mutation, verification, and receipt completion.
- [ ] Remove the automatic whole-CI completion trigger in `deploy-web.yml` in
  the same cutover that enables the new main jobs. No dual automatic publisher.
  Preserve required PR result names; deployment jobs only run on authorized
  main push/manual events, never PR events or arbitrary workflow completion.
- [ ] Manual tags resolve to immutable source before running the same target
  checks. `ios`/`ota` do not implicitly deploy server; `all` explicitly runs the
  coordinated server-first sequence. A changed-source rerun starts at source
  selection, while receipt-only recovery finalizes the original upload.
- [ ] Replace server/mobile SHA equality with mobile checks/archive/source-map/
  receipt identity. Preserve server's own image/source validation. Require
  additive API sequencing from the design; do not add speculative feature flags.
- [ ] Validate merged source versus PR head, missing artifacts, no-native-change
  output, docs-only later commits, unrelated lane failure, and out-of-order main
  readiness. Keep full source/lockfile/config inputs for each relevant check.
- [ ] Review permissions and event predicates; do not expose signing/OIDC
  privileges to fork validation. Run the applicable pre-push commands listed
  in Task 7, then commit/push; Task 7 later completes the whole-change audit.

## Task 6: Make the path navigable in GitHub

**Files:** Modify existing publisher/build summaries, `ci.yml`,
`append-dispatcher-run-summary/action.yml` only if needed, and `deploy/README.md`.

**Produces:** Native graph, direct producer/publisher/artifact/deployment links,
and truthful per-target outcomes. Link reporting never authorizes a release.

- [ ] Name lane jobs consistently and keep real `needs` edges visible. Summaries
  link PR, source commit, exact check/build/publisher runs and attempts, archive
  artifact or image digest or OTA identity, and target deployment record.
- [ ] Reuse dispatcher backlinks. Any actual cross-run handoff must also expose
  the exact downstream URL from the initiating side; workflow-list links alone
  do not qualify. PR/main remain separate revisions linked through the PR and
  merged commit. Do not add a custom cross-workflow graph or PR comment bot.
- [ ] Use the Task 4 intent as the visible target deployment record; set exact
  publisher `log_url` and a meaningful destination URL where available. Do not
  create a competing success receipt or change environment protection settings.
- [ ] Add an always-running final summary distinguishing successful deployment,
  failure, blocked prerequisite, not applicable, unchanged, and superseded.
  Preserve partial success when another lane fails. Missing summaries after a
  cancellation do not replace authoritative deployment state and logs.
- [ ] Self-review sample summaries and job graph against the design's UI walk;
  commit/push this chunk with focused schema/diff checks. No whole application
  suite rerun is needed solely for later prose/link changes.

## Task 7: Validate, review, cut over, and measure

**Files:** Actual changed executable files; `docs/testing.md`,
`deploy/README.md`, `scripts/README.md`; implementation PR evidence.

- [ ] For each behavior change, retain red/green test evidence. Run relevant
  focused unit/mobile/native tests, actionlint at the already pinned repository
  version, YAML lint, `rtk pnpm lint`, and
  `rtk pnpm --recursive --include-workspace-root --if-present typecheck`.
  Register any new runtime package entry points in `knip.json` if needed.
- [ ] Use the integration-test setup/runbook for any database behavior change
  and execute required real-engine integration tests. No local Cypress run is
  required unless E2E tests change. Dockerfile/entrypoint changes are outside
  this plan; if needed, obtain scope approval and fulfill container validation.
- [ ] Validate failure/skip/cancellation/empty matrix and publication recovery
  scenarios through executable steps and Actions runs without production writes.
  A workflow refactor needs real Actions evidence; passing actionlint alone is
  insufficient. Never rerun a flaky failure as its fix.
- [ ] Perform independent whole-change review when available/authorized, plus
  scope/spec and minimum-code review. Resolve material findings and confirm
  required CI checks. No deployment readiness claim while checks are failing.
- [ ] Open/update the implementation PR with ownership changes, validation
  evidence, deferred coupling, and source links. After the authorized merge and
  automatic cutover, walk actual GitHub PR → checks → merged main graph →
  build/artifact → target deployment → publisher logs. Record direct URLs for
  mobile-only, server-only, shared, partial failure, and superseded examples.
- [ ] Observe that applicable shared/security failure blocks consumers,
  unrelated mobile/server failure does not block the other release, and
  live-before-finalization failure prevents stale promotion. Reuse previous
  successful checks for unchanged code; do not manufacture live failures solely
  to obtain a screenshot.
- [ ] Compare baseline versus the full PR-to-deployed path, reporting queue,
  validation, rollout, and human-review time separately. Use existing run and
  deployment data, not new telemetry machinery. Report residual coupling and
  unexecuted scenarios plainly; archive findings in the testing/deploy runbook.

## Plan review

The design's scope maps to Tasks 1–3 (selection and preserved checks), Tasks
4–5 (safe independent releases and manual paths), Task 6 (GitHub navigation),
and Task 7 (verification and measured outcomes). Deliberately shared coverage
or security checks remain visible until safe partitioning; there is no promise
of complete isolation before that evidence exists. No runtime changes have
been made by writing this plan.

Execution recommendation: sequential work in the existing workspace, with a
bounded implementer per task and lead review before proceeding. The central
workflow, source handling, and recovery interfaces overlap; concurrent edits
would add coordination without shortening validation. Use the configured
cost-aware implementation routing and report architectural uncertainty rather
than quietly changing this approved design.
