# Independent release gates

Status: proposal for review; implementation is not approved.

## Goal and safety boundary

Shorten **PR opened → required validation → merge → deployment**, preserving
the existing safety requirements for every affected system. Measure that whole
path, not just the time between merge and a deployment job starting.

The mechanism is to remove unrelated work from each critical path, parallelize
independent work, and avoid duplicate builds where artifact identity can be
preserved. Do not lower coverage/mutation thresholds, move required checks to
nightly runs, suppress failures, or count skipped required work as passing.
This is a proposal to preserve our safety controls, not a claim that CI can
prove an absence of bugs.

DORA identifies independent testing and deployment as capabilities supporting
continuous delivery; that supports separating release units, without requiring
new services or repositories ([DORA](https://dora.dev/capabilities/loosely-coupled-teams/)).

## Current evidence

- `.github/workflows/ci.yml` calls one large `test.yml` and aggregates mobile,
  web, Zepp, OTA-service builds, and tests under `CI Gate`.
- `test.yml` combines security, repository policy, database integration,
  web E2E, mobile/Swift, coverage, and mutation gates. Its lint job starts
  ClickHouse and runs database regressions before root lint.
- `deploy-web.yml` starts only after the entire CI workflow completes
  successfully. The signed iOS archive starts alongside the server rollout;
  TestFlight upload and OTA publication require that rollout to succeed.
- `deploy-ios.yml` explicitly requires the archive source to equal the
  deployed server source. `deploy-ota.yml` receives the server source too.
- `deploy-web-environment.yml` runs Terraform before every server rollout.
- Main CI runs share one workflow concurrency group. Moving deployments into
  that workflow without changing this would serialize unrelated main runs.
- `scripts/detect-ci-changes.ts` already follows workspace dependency edges.
  Mobile depends on `dofek-server` for its typed API integration, so a server
  change can legitimately select mobile checks. Dependency selection alone
  does not distinguish a typecheck requirement from a publication requirement.
- `vitest.config.ts` groups server, web, shared packages, and tooling under
  `unit`; filtering only the `mobile` project would miss shared domain tests.
- Native release detection already compares against the last successful
  TestFlight receipt. Preserve this recovery behavior.

## Approaches

1. **One orchestrator with independent job dependencies — recommended.** Keep
   `CI` as the PR/main entry point and reuse narrowly scoped workflows. Deploy
   from the relevant successful branch of the job graph. This avoids a second
   cross-workflow dispatcher or status-polling layer.
2. **Separate top-level workflows per release unit.** Also valid, but requires
   duplicated trigger/change selection and more care around required status
   names, artifact handoff, and coordinated changes. No extra latency benefit
   over an equivalent job graph.
3. **Keep whole-CI release triggering and optimize individual jobs.** Useful
   later, but leaves unrelated failures and slow jobs on the release path.

The user requested a concrete design following the independent-gates proposal.
The detailed choices below are recommendations awaiting approval.

## Release units and gate ownership

Keep server, web assets, worker, analytics worker, schema migrations, and the
Swarm configuration in their existing coordinated deployment unit. Do not split
web and worker rollouts. Mobile has separate OTA and native publication gates.
Conditional Terraform execution is a later optimization; the first cut keeps
its existing server prerequisite. The OTA hosting service is infrastructure/server work;
publishing a mobile JavaScript update is a separate operation.

Each existing job must have an explicit owner before rewiring. The initial
mapping is:

| Gate | Required work | Excluded dependencies |
| --- | --- | --- |
| Repository safety | Secret scan, dependency security/audit, licenses, action pinning, workflow/schema lint, workspace integrity | Application builds, databases, native compilation |
| Server/web | Relevant lint and policies, typechecks, unit/coverage/mutation checks, real database/FIT/CDC/Pulsar integration, web build/size and E2E, image build/scan, migration checks | Mobile/Swift builds and tests, Zepp build, unrelated ML work |
| Mobile JavaScript | Mobile lint/policies, mobile typecheck, mobile tests, shared domain tests/coverage/mutation as applicable, Expo dependency validation, Metro export | Server integration, web E2E, Terraform, server rollout |
| Native mobile | Mobile JavaScript gate plus existing native archive/build validation, bridge tests, watchOS build/tests, podspec lint, Swift lint/Periphery/tests/coverage/mutation as applicable | Server integration and rollout, web E2E |
| Infrastructure | Relevant YAML/Docker/Terraform/DNS validation, image checks, local infrastructure validation required by policy | Mobile app builds and tests |
| Other packages | Existing Zepp, ML, library release and associated checks when affected | Unrelated app releases |

Repository-wide security checks remain shared initially; this deliberately
retains their existing protection. Do not invent a scoped security scanner.
Split database-dependent root lint into its existing database-free commands
and server-owned SQL/regression work. Audit every root policy command so mobile
telemetry, route, story/parity, and import-boundary checks retain their owners.
Cross-client policies may select both lanes.

Package test ownership uses existing Vitest projects and explicit package/file
filters. Select complete affected package suites and their consumers, not just
changed test files. Preserve aggregate coverage accounting and thresholds;
partition only where equivalent accounting is verified. Until a combined
check is safely partitioned, retain it as a shared prerequisite and label the
remaining coupling. Do not claim that stage fully decouples the lanes.

pnpm already supports dependency/dependent selection; use that capability
where applicable rather than building another graph engine
([pnpm filtering](https://pnpm.io/filtering)).

## Job graph and events

`ci.yml` continues to run on every PR and main push. Change detection always
runs. Each selected lane starts concurrently after detection. A main deployment
depends directly on repository safety, its lane checks, and its exact build
artifact. It never depends on `CI Gate` or the completion of another lane.

Extract the mixed `test.yml` into reusable workflows by gate ownership; merely
adding outputs to that mixed workflow would still leave callers waiting for
its completion. Keep existing setup composite actions. Do not create an
all-purpose workflow generator, release controller, or status polling script.

Keep the existing required PR status name `CI Gate`. It always runs and
aggregates all selected checks/builds, so merges still require all relevant
systems to be safe. It does not aggregate deployment results. After merge,
each system may deploy as soon as its own gates pass, even if another selected
system subsequently fails. That is the intended independent-release behavior.

Read-only inspection of main branch protection also found these required
contexts: `SAST Scan`, `CodeQL Analysis (javascript-typescript)`,
`Test / Lint & Static Analysis`, `Test / Security & Dependencies`,
`Test / Unit & Integration Tests`, `Test / E2E Tests (Web)`,
`Test / Mutation Testing`, and `Build Mobile / Mobile Build Gate`.
Preserve every required context and its existing GitHub App source, not just
`CI Gate`. Keep security workflows intact. Where extraction changes a nested
job name, retain a small reporting job under its existing workflow/job display
names, forwarding explicit selected results without rerunning tests. These
compatibility reports may wait for all PR checks; release jobs must not depend
on them. Reinspect active rulesets before implementation and do not change
repository settings to accommodate the refactor.

A lane gate checks expected jobs explicitly: every selected prerequisite must
be `success`; `failure`, `cancelled`, or an unexpected `skipped` blocks it.
An unselected lane reports that it is not applicable. Detection failure blocks
every release and fails the PR gate. Matrix checks must account for every
selected worker. Use `always()` for reporting gates and success/result
predicates for deployment; a failed ancestor must not disappear behind a skip.
GitHub documents both dependency skip propagation and the required-check
pitfalls of workflow-level path filters
([job dependencies](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds),
[required checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)).

Retire the automatic whole-CI `workflow_run` trigger in `deploy-web.yml` when
the new main job graph takes ownership. Preserve manual release entry points,
rewired to the same target gates. Never leave two automatic publishers active.
Manual dispatch resolves any supplied image tag to its immutable image and
source revision before validation, then invokes the same selected checks for
that revision. Manual `ios` and `ota` targets do not deploy the server as an
implicit side effect; `all` remains an explicitly coordinated server-first
operation. A manual path must not bypass target checks or use current-main
results to authorize a different image/source. Preserve separate explicit
operator rollback behavior and its database migration restrictions.

## Selection, revisions, and recovery

- PRs: classify the full PR diff, including renames and deletions. Validate the
  candidate merge revision consistently across jobs, rather than mixing the PR
  head and candidate merge. GitHub's normal PR checkout tests the merge result
  ([PR revision semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)).
- Main: checks and builds use the exact pushed SHA. Do not reuse a PR result
  or binary merely because its head looks similar; the merged source and
  production configuration may differ. PR caches can accelerate main builds.
- Changes to shared packages select consumers; root lockfile, workspace,
  toolchain/test configuration, and central gate logic select conservatively.
  Extend the existing detector for workflow/config inputs before moving gates.
- A compile-time dependency can require mobile typechecking without requiring
  TestFlight publication. Preserve conservative checking of server API types;
  do not extract a new API package as part of this change.
- Native publication keeps the existing successful-upload baseline and intent
  receipts. OTA keeps exact published UUID/runtime/asset verification and its
  unchanged-content behavior. A failed publication must not advance a baseline.
- Do not use only the last push's file diff to forget an unpublished release.
  A later unrelated push need not release the failed lane: rerunning the failed
  lane remains supported; a subsequent selected lane validates its full current
  source and includes outstanding changes. Native detection uses its receipt.
- No automatic current-main equality check may discard the only eligible
  affected release just because a later docs-only commit arrived. Select the
  candidate SHA explicitly and retain per-target deployment provenance.
- Automatic promotion may never roll a target backward when builds finish
  out of order. Inside its publication lock, first reconcile the live release
  and any unresolved publication attempt, then compare the candidate using
  Git ancestry. A last-successful receipt alone is insufficient: publication
  can become live before verification, source-map upload, or receipt recording
  fails. Record the intended source in a GitHub deployment before production
  mutation, reusing existing target records/intents where present. A failed
  workflow is not proof that nothing changed. Unknown live state or an
  unresolved attempt blocks further promotion until reconciliation; never
  authorize an older candidate against a stale success baseline. An older
  candidate is superseded, a repeated verified successful candidate is a no-op,
  and an ambiguous non-ancestor relation fails. Keep this to GitHub deployment
  records and existing live identity/receipt checks, without a separate release
  state service. Explicit operator rollback retains migration safeguards.

## API and Expo compatibility

Replace server/mobile SHA equality with artifact/source equality within each
release: mobile checks, archive, embedded bundle, source maps, build number,
and upload receipt must refer to the selected mobile revision. Server image,
source, assets, and migration provenance retain their existing checks.

Independent releases require compatibility in both directions: current mobile
must keep working after a server update, and a new mobile release must work
against the currently deployed API. Static tRPC types from the same checkout
do not prove either cross-version property.

The initial policy is **server-first additive changes**: add compatible server
behavior, verify it is deployed, then merge clients which require it. Web and
mobile client changes can still share their parity PR. A combined PR can
release independently only if its client remains functional against the old
server; review and targeted regression tests must establish that. Otherwise
split the backend preparation from client activation. Do not remove or rename
behavior used by supported installed clients. This follows Microsoft's API
compatibility guidance, adapted to this repository rather than introducing a
new version negotiation service
([API compatibility](https://learn.microsoft.com/en-us/azure/architecture/microservices/design/api-design#api-versioning)).

This is a release policy, not an automated proof of API compatibility. Approval
of independent publication includes approval of this sequencing rule. A team
unwilling to enforce it should retain server-first mobile publication until
it has a concrete automated compatibility mechanism; dropping the dependency
without either protection does not meet the safety goal.

Retain the configured Expo `fingerprint` runtime policy and manifest/signature/
asset checks. Expo runtime versions match JavaScript updates to native code;
they do not establish API compatibility. Native changes require a compatible
binary; OTA must never be treated as a substitute for that binary. Expo's
runtime/deployment guidance supports these constraints; its EAS hosted rollout
commands are not a reason to replace our existing self-hosted publisher
([runtime versions](https://docs.expo.dev/eas-update/runtime-versions/),
[deployment](https://docs.expo.dev/eas-update/deployment/)).

## Builds, permissions, and concurrency

Build server images while the relevant tests run, then deploy the tested
revision's immutable image after both complete. Signed iOS archives may build
in parallel with main mobile checks; upload waits for every mobile prerequisite.
An unsigned validation archive and a signed release archive currently duplicate
compilation. Consolidate them only after preserving bridge/watch/podspec and
all other validation; this optimization is a separate acceptance step, not a
prerequisite to independent gates. OTA may skip native compilation only after
native-input classification is proven and no existing required validation is
lost. Do not count this optional optimization in the initial speedup claim.

No production publication runs on a PR. Keep signing and publication secrets
out of untrusted fork jobs, use read-only permissions for validation, and grant
OIDC/deployment/package writes only to jobs that need them. Never execute PR
code under `pull_request_target` to obtain secrets
([GitHub security guidance](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target),
[least privilege](https://docs.github.com/en/actions/reference/security/secure-use)).

Cancel superseded PR validations. Main validation/builds run concurrently;
remove the shared whole-main concurrency bottleneck. Keep separate publication
locks for server production, native iOS, and OTA. Active production mutation
must not be canceled by a newer run. GitHub concurrency does not establish
source-commit ordering, so the ancestry check above remains necessary; a
replaced pending deployment is handled by later candidates containing its
changes or by an explicit rerun
([GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)).

Preserve Terraform as an existing server prerequisite in the first cut.
Conditionally skipping it is a follow-up only after deployed Terraform
revision/output provenance can identify unapplied changes safely; a per-push
path filter alone is insufficient. Infrastructure changes still obey the
repository's local plan/apply and stack validation requirements.

## Acceptance and task order

1. Record baseline PR-to-ready, merge-to-deployed, queue, and per-job durations
   from representative mobile-only, server-only, and shared changes. Use
   GitHub timestamps/deployment records; do not add a telemetry service.
2. Inventory every existing required check, its source/test coverage, and its
   new owner. Partition reusable checks and establish lane gates without
   activating new automatic publishers. Any unpartitioned shared gate is an
   explicit remaining dependency; no required check vanishes.
3. Verify selection with executable detector tests, including shared consumers,
   lockfiles/configuration, renamed/deleted inputs, and failed-release recovery.
   Validate YAML with actionlint/schema tools and diff review; do not add unit
   tests that merely assert YAML text, per repository test policy.
4. Verify event/permission handling, exact revisions/artifacts, unexpected
   skips, failure/cancellation propagation, matrix failures, and stale release
   ordering. Use validation runs on this branch without production mutation.
5. In one cutover, replace the whole-CI automatic trigger with gated main
   jobs; change mobile source validation and manual target paths consistently.
   Preserve receipt recovery, migration checks, native runtime compatibility,
   and current required PR status names. Do not modify repository settings.
6. Observe real selected releases. Mobile-only publication must work without a
   server build/rollout; backend integration failure must not block a validated
   independent mobile release; mobile failure must not block server deployment.
   Failures in applicable security/shared-domain checks must still block both.
7. Compare the full PR-to-deployed distributions with baseline and inspect
   failure evidence. Optimize duplicate archives or Terraform only if those
   remain material bottlenecks and their own safety criteria are met.

Required scenarios also include a docs-only PR with a reporting gate, a shared
package failure blocking every consumer, a missing build artifact blocking
publication, a failed native upload followed by a later non-native change,
and a newer successful release followed by a slower older build. Published OTA
identity and TestFlight upload receipts must remain recoverable without
reuploading a previously successful build. Also verify a newer publication
that becomes live but fails finalization, followed by an older candidate:
reconciliation must prevent rollback and duplicate publication. Local/CI checks required by the
repository apply to the eventual executable changes; this document alone
requires link inspection and diff review.

## Deliberate limits and review notes

This does not remove merge review, create microservices, add a contract registry,
change Expo runtime policy, weaken security/coverage/mutation gates, or promise
a numerical speedup before measurement. Repository-wide security and genuinely
shared dependency checks still couple the systems where warranted.

Useful existing foundations are reusable workflows, dependency selection,
artifact IDs, and TestFlight receipts. The main investigation findings are
the mixed test workflow, database-dependent lint, broad main concurrency,
and type-only versus publication dependencies. On implementation, update the
deployment runbook with: "Each target releases after its own applicable gates;
new client API dependencies require a verified additive server deployment
before client activation." Keep a check-ownership map in the testing guide.
Both documentation updates are part of the proposed implementation scope.

Independent builder review identified the live-before-finalization ordering
case; the recovery rule and acceptance scenario above resolve it. A separate
self-review checked scope, source links, existing required status contexts,
and the distinction between API, type, and native runtime compatibility.
