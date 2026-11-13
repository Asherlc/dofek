# Migration quiescence task snapshot implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Avoid a task-list/inspection race while retaining the release's strict processing shutdown gate.

**Architecture:** Read current task states in one stock Docker CLI task snapshot instead of enumerating IDs and separately inspecting objects that can disappear. Preserve desired-replica and service-update validation, known terminal states, the existing poll cadence and deadline, and hard failure on unavailable or malformed evidence.

**Tech Stack:** TypeScript, existing Zod and Vitest, Docker CLI.

**Spec:** The operator explicitly approved replacing the two-command task check with one snapshot, preserving zero-replica and terminal-state checks, adding a regression and shipping after CI. These binding requirements are reproduced below; no separate design document is needed for this two-file correction.

## Global constraints

- Local Docker remains stopped. No local native test, new dependency, HTTP server, branch switch, rebase, timeout increase, retry, owner mutation or gate bypass.
- Only the lead handles Git commits/pushes, CI, PRs and production release. New commits are automatically pushed.
- Runtime implementation belongs in `scripts/wait-migration-quiescence.ts`; unit tests stay in its existing colocated test file. No new abstraction, runner or workflow.
- Stock [`docker service ps` formatting](https://docs.docker.com/reference/cli/docker/service/ps/) exposes task ID and current state. Use `--no-trunc --format '{{json .}}'` without a desired-state filter: a running task whose desired state is shutdown/remove must still block.
- Preserve `waitForMigrationQuiescence(stackName, deploymentMode): Promise<void>`, rolling/maintenance membership, zero desired replicas, update-state failures, 35-minute deadline, 5-second cadence and deadline-bounded Docker calls.
- Preserve the known terminal set: shutdown, complete, failed, rejected, remove. All other known states wait. Unknown/malformed states, malformed JSON or Docker errors fail loudly.
- Parse Docker's JSON Lines snapshot with existing Zod. `CurrentState` includes the human elapsed suffix; validate its first state word against the existing full task-state enum, case normalized. Do not infer stopped state from DesiredState.
- Each modified TypeScript file stays below 1,000 lines. Lead owns incident documentation and preserved original evidence.

## Review focus

- A task running while desired state is Remove/Shutdown still blocks migration.
- A completed task disappears after a snapshot without breaking a later object inspection; there is no second task-object read.
- Empty task snapshots are valid only after existing service prerequisite checks pass.
- Malformed/unknown snapshot states or Docker command failure must never be treated as quiescence.
- Existing maintenance-web, paused/rollback service, timeout and draining-task checks retain behavior.

### Task 1: Consume a single native task-state snapshot

**Files:** Modify `scripts/wait-migration-quiescence.ts` and `scripts/wait-migration-quiescence.test.ts` only. Lead updates `docs/production-incident-baseline.md` separately.

**Interfaces:** Consume Docker JSON Lines rows with ID and CurrentState. Produce the unchanged public async quiescence function and its existing waiting diagnostics.

- [ ] Add a public-interface regression with realistic formatted snapshot rows: a running task with desired Remove blocks, then disappears from a later snapshot and permits completion. Configure any separate task inspection to fail with the observed `task … not found` error. Run it against original source and retain the RED assertion.
- [ ] Replace ID-list + task-inspection calls with one formatted snapshot call per service. Validate every row and derive known task state from CurrentState; retain strict service prerequisites and all timing.
- [ ] Adapt existing mocks to snapshot rows. Preserve all active safety assertions; replace the obsolete two-read missing-object test with malformed/missing-field/unknown-state and command-error failures that exercise the new evidence path. Do not add a test merely asserting code removal.
- [ ] Run the full focused unit suite, root TypeScript, changed-file Biome, configured spelling check and `git diff --check`, without Docker. Save explicit exit codes and concise RED/GREEN evidence in the worker report.
- [ ] Lead reviews actual diff/evidence, obtains independent spec/quality review of the complete small follow-up, commits and automatically pushes, opens a PR, waits for mandatory CI at the final commit, merges and verifies the canonical release. Existing attempt-2 recovery of the batching release continues independently; do not overlap manual deployments.

## Incident evidence and acceptance

[Release attempt 1](https://github.com/Asherlc/dofek/actions/runs/43458032214/attempts/1)
failed at 16:14:46 UTC in `pnpm tsx scripts/wait-migration-quiescence.ts` with
`Error response from daemon: task emq6x21tzcbfbq44pnchei164 not found`.
The same task appeared in preceding wait output. Source line 85 then inspected
the separately listed ID; Docker returned an empty array and exit 1 after task
removal. All processing replicas reached zero, and the owner was quiescent with
terminal query/no backend at 16:16:54. The release failed before migrations.

The direct fix removes that list/inspection gap. A passing rerun of unchanged
code is operational recovery, not proof of the durable correction. Final
acceptance requires the regression, exact-head CI and canonical release; no
additional resilience knob is planned. Backlog catch-up remains separately
measured from fresh consumer commits and arrivals.
