# Metric-stream sink graceful shutdown

> **For agentic workers:** Use superpowers:subagent-driven-development to execute this plan with explicit review checkpoints.

**Goal:** Drain an active sink batch before disconnecting publication dependencies on SIGTERM/SIGINT.

**Architecture:** Use the existing KafkaJS consumer stop/disconnect APIs and process signal events in the sink lifecycle. Preserve the shared ownership guard. Give all three inherited sink services the existing 30-minute worker shutdown grace; retain the 35-minute deployment quiescence deadline.

**Tech Stack:** TypeScript, KafkaJS, Vitest, Docker Swarm.

**Spec:** User approved graceful sink shutdown and a regression test, with production read-only. The confirmed forced-kill evidence is recorded in [the incident baseline](../../production-incident-baseline.md#2026-11-12--analytics-ownership-recurrence-during-release-unresolved).

## Global Constraints

- Keep production read-only: no recovery, owner clearance, service mutations, Terraform apply, deployment, or Sentry status changes.
- Stay on the existing branch/worktree; do not recursively delegate.
- Use stock KafkaJS lifecycle methods, no new dependencies, coordinator, CLI, retry, or timeout extension beyond the approved shutdown grace.
- Preserve publication ownership and Kafka offset semantics. Do not change analytics-query-owner.ts.
- Write failing behavior tests before implementation. Do not add static configuration tests.
- Errors must be reported to Sentry and propagated. Preserve the original startup/work error if cleanup also fails; report cleanup failures too.
- Lead owns commit/push after review and pre-push checks. Worker must not commit or push.

## Review Focus

- Shutdown during an active owned write must await batch completion and ownership release before database/ClickHouse teardown.
- Repeated signals must initiate shutdown once and keep handlers installed during draining.
- A signal during startup must be retained and serviced once startup settles.
- Startup and cleanup failures must remain visible, and signal listeners must be removed after completion.
- Quarantine producer and readiness server must close so the process can exit naturally.

### Task 1: Drain and close the sink using KafkaJS

**Files:** Move process entrypoints from `src/metric-stream/clickhouse-sink.ts` into `clickhouse-sink-runtime.ts` with colocated runtime tests to respect the repository's file-size limit. Update the canonical caller in `src/index.ts` and its CLI mock. Modify `src/metric-stream/redpanda-consumer.ts`, `src/metric-stream/redpanda-quarantine.ts`, their colocated unit tests, `deploy/stack.yml`, and shutdown guidance in `deploy/README.md`. Adapt the publication integration helper's startup notification to the long-lived runtime. Retain the existing incident note; append validation after checks.

**Interfaces:** Keep the public sink entrypoint signatures. The concrete consumer factory must expose required stop/disconnect methods backed by KafkaJS; it may use an intersection on its return type to leave the narrower batch-runner interface intact. The concrete quarantine writer needs a disconnect method backed by its producer. Do not make lifecycle dependencies optional merely for tests.

- [x] Write the shutdown regression before implementation in `clickhouse-sink.test.ts`, then move it with the runtime into `clickhouse-sink-runtime.test.ts`. Exercise the actual sink callback with deferred owned publication, deliver SIGTERM/SIGINT, verify dependencies remain available until the callback releases ownership, then verify shutdown closes connections and removes signal handlers. Cover repeated signals, shutdown during startup, and surfaced failures.
- [x] Run `pnpm exec vitest run --project unit src/metric-stream/clickhouse-sink.test.ts` and capture the expected missing-shutdown failure before changing implementation.
- [x] Implement signal handling in the existing sink lifecycle. Register before consumer startup; await a shutdown request after KafkaJS run starts (run resolves after startup). On shutdown mark readiness unavailable, await consumer.stop(), then disconnect consumer/quarantine and close database/ClickHouse. Close the readiness server when the entrypoint finishes. Cleanup must not race active owned work. Avoid creating a generic lifecycle framework.
- [x] Expose stock lifecycle methods in the existing consumer/quarantine adapters; add focused tests that verify the required adapter behavior. Update existing sink tests to retain a live lifecycle until explicit shutdown rather than invoking callbacks after a closed runner returns.
- [x] Add `stop_grace_period: 30m` to the anchored sink definition so both inherited sinks receive it. Document why the old task must be drained before first rollout, why hard-kill recovery remains separately gated, and cite [KafkaJS](https://kafka.js.org/docs/consuming) and [Docker](https://docs.docker.com/reference/compose-file/services/#stop_grace_period).
- [x] Run the focused sink/consumer/quarantine unit suites. Expected: all pass; record exact command/count and RED/GREEN evidence in the worker report.
- [x] Lead review checkpoint: inspect actual diff, failure semantics and test evidence; obtain independent review before completion. The review-required regression now waits for owned insert entry before signaling, asserts ownership release precedes every teardown, and detects removal of the stop await. Scoped re-review accepted the correction.
- [x] Lead validation: full lint, root/server/web/mobile typechecks, 229 selected unit tests, and the real publication integration test passed. Stock Docker schema tooling rendered all three sinks with `30m0s`; production Terraform apply is excluded by the user's read-only instruction. No Terraform resources changed.
- Lead commit/push checkpoint: after passing checks and review, commit the complete fix and push this branch automatically. Do not merge or deploy. Record the unresolved production recovery boundary in the final report; git history records publication of this change.
