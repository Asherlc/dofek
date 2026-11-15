# Task 5 — Independent release publishers

## Scope and result

Wired the main CI and manual release entry points so each publisher waits for its own successful checks and exact-source artifacts. Removed the old `workflow_run` production publisher from `deploy-web.yml`; main server publication now comes from `ci.yml`, while `deploy-web.yml` remains a manual wrapper around `deploy.yml`.

PR #3348 remains open and draft. No production publisher, manual release, failure injection, repository setting, secret value, or credential was accessed. The implementation is pushed, but the PR CI workflow still fails before creating jobs; its GitHub log and job API return no records, so readiness is unresolved.

## Exact workflow interfaces

- `ci.yml` resolves one full `commit_sha` for every main run and passes it to affected build/check workflows. The main server publisher requires repository checks, shared/server checks when selected, the exact server image digest and source SHA, and the OTA image build when that source changes OTA runtime code. It performs one web+worker Swarm deployment using the same immutable image reference.
- Main OTA and iOS publishers run independently of the server deployment. OTA waits for repository/shared/mobile checks and the mobile build lane. iOS waits for repository/shared/mobile checks plus a signed archive whose full SHA and artifact match the resolved mobile source. Mobile releases no longer compare against a server SHA.
- `build-docker.yml` validates its checkout against the requested full SHA, uses that SHA for the Docker tag/build/Sentry metadata, explicitly writes `org.opencontainers.image.revision`, and returns `repository@digest` with its source SHA.
- `deploy.yml` resolves a manual `image_tag` to its immutable digest and full OCI revision before selected-source repository/shared/server checks. Historical mutation selection uses the selected source's first parent. `check-shared.yml` and `check-server.yml` use current `.release-tools` planning/config controls while candidate package source, tests, dependencies, and lockfile remain selected-source-owned.
- Manual `ios` and `ota` run no server stack/infra publisher. `all` starts checks and archive work concurrently but gates iOS/OTA publication on successful server publication. The web stack keeps its noncanceling target lock through its deployment and receipt finalization.
- Historical-source acceptance was exercised against `9bf106225`: the same shared-unit command ran 199 test files / 3,819 tests with 97.24% lines, 93.33% branches, 98.56% functions, and 98.10% statements; package source resolved from the candidate snapshot. A deliberately failing test added only to that candidate made the shared-unit command fail. Shared Stryker used the current planner/config with candidate tests/dependencies and completed at 84.08%, above the existing 75% floor.

## Source, permissions, and cutover

The private OTA image builder now shares its selected-source checkout, source guard, and build steps through `.github/actions/build-private-ota/action.yml`. PR validation invokes the composite action directly with `packages: read` and `publish: false`. Main/manual publication invokes `build-private-ota.yml` with `packages: write`; the workflow job is main-only. The runtime image tag uses the validated selected SHA. This avoids a reusable-workflow permission escalation from a read-only PR caller.

Changed release callers pass named secrets required by each child workflow instead of inheriting every repository secret. Build, signing, OIDC, and publication permissions remain scoped to their specific jobs; the signed iOS archive and publishers are main-only. The manual resolver checks the full source SHA and matching `SENTRY_RELEASE`/OCI revision, then downstream checks and publication use the immutable image reference.

The old `workflow_run` server/mobile publisher was removed in the same change that added main CI publishers. A review of the existing manual image-tag entry and Swarm release workflow found no separate explicit GitHub rollback input/workflow to remove. The existing operator/Swarm rollback behavior and documented migration limits were left intact; a code rollback remains a forward revert commit through normal CI.

## Red/green evidence

- Red: `.github/workflows/deploy-ios.test.ts` initially rejected an iOS archive when the selected mobile SHA differed from the server SHA (`/tmp/opencode/task5/deploy-ios-red.json`). Green: the archive/source comparison now uses the selected mobile SHA.
- Red: the manual image resolver had no source-only immutable resolution path (`/tmp/opencode/task5/resolve-image-red.json`). Green: resolver fixtures verify tag-to-digest resolution, exact OCI/Sentry source identity, and the downstream immutable reference.
- Red: `.github/workflows/build-private-ota.test.ts` failed before the selected-source checkout guard existed (`/tmp/opencode/task5/private-ota-red.json`). Green: its shell guard runs against a temporary Git fixture for matching and mismatching full SHAs, verifies the validated SHA is the runtime tag source, and checks the PR read-only / main publisher permission split.
- Green focused consumers: `pnpm exec vitest run ... --reporter=json --outputFile=/tmp/opencode/task5/focused-final-consumers.json` — 33 suites and 303 tests passed, including release, deploy, resolver, OTA, TestFlight, and mutation-source-selection consumers.
- Green all-package typecheck: `pnpm --recursive --include-workspace-root --if-present typecheck` (`/tmp/opencode/task5/typecheck-final3.log`).
- Green full lint: `pnpm lint` on a temporary Git snapshot containing the full Task 5 diff, with a temporary `.env.local` holding only the repository's local Compose ClickHouse endpoint (`/tmp/opencode/task5/lint-full-final4.log`). No workspace environment file was read or loaded. Lint reported existing broken `.kilocode/skills` symlinks and SQLFluff's configured large-file skips as warnings; the command completed successfully.
- Green workflow validation: Actionlint 1.7.12 on every changed workflow YAML, plus `git diff --check`.
- Historical acceptance logs and candidate-only failure fixtures were captured under `/tmp/opencode/task5/`; they did not alter workspace Git state.

## Commits and actual PR Actions

- `a12d45cbf3f9c764abc61f764dc737e6265ef80e` — independent source-pinned release wiring.
- `941fe6c4b1b5a453774a63564be6c8b5e597029d` — read-only PR OTA validation and explicit secret interfaces.

After the first push, CI run `43700412759` concluded `startup_failure` with no jobs; `gh run view --log` returned “log not found,” and the REST jobs endpoint reported zero jobs. After the permission/secrets correction, CI run `43701761919` still failed before job creation with zero job records and no downloadable log. Several called-workflow run records also showed zero jobs. No fatal step/command is available, so the remaining cause cannot be stated as proven. The permission-boundary correction follows GitHub's documented rule that nested reusable workflows may maintain or reduce caller permissions, not elevate them ([GitHub documentation](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows#nesting-reusable-workflows)).

On commit `941fe6c`, CodeQL, Semgrep, the mobile preview OTA check, GitGuardian, and Snyk passed. The new PR run's CI job graph did not start; therefore the release integration is locally verified but not CI-verified and the PR is not ready to merge. No reruns were used as a fix.

## Review, concerns, and retrospective

Self-review confirmed the task stays within existing release workflows, does not add a rollback state machine or publisher, pins build/deploy artifacts by source and digest, preserves target-specific release lanes, and keeps historical tests on candidate code. An independent reviewer was unavailable in this worker context.

The useful investigation pattern was to validate selected-source commands against a temporary historical snapshot and candidate-only failure fixture, then inspect actual PR workflow/job records through `gh`. A missing GitHub Actions startup log prevented root-cause proof despite two PR runs. For future CI debugging guidance, document that `startup_failure`/pre-job failures can yield neither a job ID nor downloadable logs, and require collecting the run API's referenced workflows plus the zero-job result before changing workflow code. The existing `gh-fix-ci` skill should add that branch for no-job runs. No further workflow change is justified without job-level evidence.
