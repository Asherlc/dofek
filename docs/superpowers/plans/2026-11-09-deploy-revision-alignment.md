# Deployment revision alignment implementation plan

> **For agentic workers:** Use superpowers:executing-plans for this approved fix.

**Goal:** Run automatic production deployment logic, configuration, and image from the same successful release commit.

**Approved design:** Keep the existing successful-main release selector. Create or reuse a lightweight `deploy-<full-SHA>` Git tag pointing to the selected commit; reject an existing tag pointing elsewhere, and never update or delete release tags. Dispatch the existing `deploy.yml` through that tag with its matching image tag and `all` target. Wait using stock `gh run watch --exit-status`; the child owns production concurrency, Terraform, migrations, health gates, and mobile publication. Manual Deploy Web requests retain their current server-only path. The existing Deploy workflow is the release executor; no new release framework or dependency is needed. The user approved release tags and handoff-job `contents: write` after the live bare-SHA dispatch returned HTTP 422.

**Alternatives:** Checking out newer configuration would mix it with older application code; skipping the checksum would remove a prerequisite without fixing the mismatch. The user approved dispatching the existing workflow at the successful release ref.

**Tech stack:** GitHub Actions, GitHub CLI, TypeScript/Vitest executable workflow tests.

**Primary sources:** [Reusable workflows use the caller's commit](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows#calling-a-reusable-workflow); [workflow dispatch can be triggered using GITHUB_TOKEN](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow); [CLI dispatch request and run details](https://github.com/cli/cli/blob/trunk/pkg/cmd/workflow/run/run.go); [stock run watcher](https://cli.github.com/manual/gh_run_watch).

GitHub supports creating lightweight tags using its [Git reference API](https://docs.github.com/en/rest/git/refs#create-a-reference); dispatch requires a branch/tag [ref](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).

## Constraints and review focus

- Stay on the current isolated branch; preserve all deployment safety gates.
- Parent handoffs must serialize separately from child production releases to avoid deadlock.
- Failed dispatches and failed child releases must fail the parent.
- Use the release tag verified against the selected full SHA rather than current default-branch head.
- Keep automatic native-change detection rather than forcing signed uploads solely because the handoff uses dispatch.
- Do not add retries, compatibility fallbacks, secrets, or dependencies.

## Task 1: Dispatch and verify the selected release

**Files:** `.github/workflows/deploy-web.yml`, `.github/workflows/deploy-web.test.ts`, `.github/workflows/deploy-ios.yml`, deployment runbook and incident baseline.

- [x] Add executable workflow tests for exact selected-ref dispatch, child watch/failure propagation, dispatch rejection, and missing run identity; observe failures before implementation.
- [x] Cover tag creation, rerun reuse, mismatched existing tags, and failed tag lookup/creation; verify real tag dispatch with the plan-only Terraform workflow.
- [x] Add an automatic handoff job using stock dispatch/run watch. Keep the manual job; remove automatic mobile calls from the parent because the child owns them.
- [x] Distinguish bot dispatches in the existing iOS detection step so automatic native checks keep their existing policy; test the executed shell for automatic and manual contexts.
- [x] Run focused unit tests, actionlint, Biome, typecheck, and diff checks. Review the entire diff independently.
- [x] Record the confirmed failure and validation limits in the incident baseline, and update deployment guidance with official citations.
- [ ] Commit and push the branch automatically; request normal PR/CI review without bypassing production gates. Verify the corrected workflow when it is available on an approved deployment ref.

## Execution notes

- Initial evidence: run 42687120147 executed workflows at `646ae3ea8ca235d2668d9b3d617465c9348cd909` against checkout/image `c35c32bedba7096395d568e6c09cc86fd02f79b0`. The checksum manifest first appears in `6a5beb704405a8616943dd610404c2ee859db99b`.
- First fatal line: `deploy/kafka/plugin-sha256.txt: No such file or directory`; host directory validation passed before the local checksum input redirection failed.
- Review checkpoints: inspect RED evidence, GREEN evidence, full diff, and actual CI/release conclusions separately.
- Local source-policy lint passed; SQL lint is blocked by Docker VM disk exhaustion. No gate was bypassed. Full unit/mobile suite and remote CI remain separate readiness checks.
- Live tag-based Terraform plan [42690480352](https://github.com/Asherlc/dofek/actions/runs/42690480352) succeeded at the selected commit; this validates dispatch and plan prerequisites, not an application rollout.
