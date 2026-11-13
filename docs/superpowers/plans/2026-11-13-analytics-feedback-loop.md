# Analytics feedback loop implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Catch canonical analytics regressions on the production engine before waiting for the full CI matrix.

**Architecture:** Reuse the existing workspace Compose configuration and the early ClickHouse-backed `lint` job. Add focused Vitest steps before its broad lint command; retain every existing full CI and merge gate. No new runner, workflow, framework, service or selector is needed.

**Tech Stack:** Existing Docker Compose, GitHub Actions, pnpm/Vitest and uv/dbt.

**Spec:** The user approved the proposed two-item design with “do it”: use production's exact ClickHouse image locally and run focused existing database/projection-order checks early. Reusing the existing early job is the minimum implementation of that accepted direction. A later shared incident-log conflict requires refreshing [PR #3305](https://github.com/Asherlc/dofek/pull/3305), so both approved changes share that required validation cycle.

## Global Constraints

- Keep the current branch/worktree; no branch switch/rebase. Lead owns same-branch main integration, automatic pushes, PRs and releases; workers never recursively delegate. Preserve all upstream changes and the reviewed feedback patch during integration.
- Local ClickHouse must use `clickhouse/clickhouse-server:26.6.1.1193-alpine@sha256:1904267fde1d8b794c9e5fda1b5a4bffd9b2e5b3d1057d5911161257125956f3`, matching current CI and production's release. This explicit approved parity requirement controls the local version choice.
- Never start the older image against existing 26.9 data, delete named volumes, stop another workspace's services or mutate production. Native qualification uses a fresh current-workspace Compose suffix through existing scripts.
- No runtime SQL, tests, dependencies, new variables/secrets, production image, resource caps, timeouts, retries, ignores or coverage/mutation gates change. No dedicated tests for declarative config; use schema tooling and real existing suites.
- Keep `lint` job id/name, its current 15-minute timeout and all existing steps/dependencies/gates. Its existing ClickHouse service, Node/pnpm and uv setup satisfy the focused suites; do not add a FIT decoder dependency.

## Review Focus

- Image parity includes the full release and existing CI digest, without changing production or opening old data with an older server.
- Focused checks actually execute before broad lint, including the real dbt first-build path; they are not silently skipped by change detection.
- Each new command propagates failure with no retry override above zero; full CI remains required.
- The existing lint job's timeout is unchanged; measure focused duration and retain the previous roughly 4m38s total lint receipt as headroom context, not a guarantee.
- Preserve head43b880bfe qualification receipts; the combined refreshed head must pass every full CI gate anew before merge.

### Task 1: Align the engine and expose focused regressions early

**Files:** Modify `docker-compose.yml`, `.github/workflows/test.yml`, `docs/testing.md` only. Lead owns this plan and incident/progress receipts.

- [ ] Replace only local Compose's ClickHouse image with the exact pinned image above; preserve configuration/resources/volumes.
- [ ] In the existing `lint` job, after Setup uv and BEFORE Run lint policies, add three named steps using the existing job's ClickHouse service. Each uses step-level `CLICKHOUSE_URL: http://default:${{ github.run_id }}@127.0.0.1:8123` when needed. Preserve the old lint environment as well.
  - `pnpm exec vitest run --project unit src/db/clickhouse-migrations/0067_repair_local_time_column_order.test.ts --retry=0`
  - `pnpm exec vitest run --project integration src/db/deduped-activities-read-model.integration.test.ts --retry=0`
  - `pnpm exec vitest run --project integration src/db/activity-payload-dbt-microbatch.integration.test.ts -t "does not append payload-free tombstones across an unchanged production dependency slice" --retry=0`
- [ ] Document version parity, the early focused commands and unchanged full merge gates. Explain using a fresh `--project-suffix` when an existing local volume belongs to a newer engine, preserving old data. Cite [ClickHouse version tags](https://clickhouse.com/docs/get-started/setup/self-managed/docker#versions) and [GitHub step ordering](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idsteps).
- [ ] Worker runs actionlint, workflow-download policy, Compose schema rendering (no environment output), diff check and relevant Markdown validation. No Docker starts/native tests/Git/production actions by worker; report architecture uncertainty before changing approach.
- [ ] Lead reviews the actual diff, then creates fresh suffix `analytics-feedback` using `pnpm compose:env -- --project-suffix analytics-feedback --write` and starts ONLY its ClickHouse through `pnpm compose -- --project-suffix analytics-feedback up -d --wait clickhouse`. Existing named volumes stay intact. Source the generated environment and run the three exact focused commands sequentially with retry0, capturing results/timing and engine version.
- [ ] One combined task/spec/quality/follow-up diff review after validation; source findings return to the worker. Current PR #3305 CI/release remains independently tracked.
- [ ] Include the reviewed feedback changes in PR #3305's required same-branch main refresh, preserving both incident entries. Automatically push new commits. Require the new early steps and all unchanged full CI gates at that combined head before merge; verify the canonical release separately.
