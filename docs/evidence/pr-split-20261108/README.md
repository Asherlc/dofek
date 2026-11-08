# Independent fix extraction — 2026-11-08

This is a record of the split from [superseded draft PR 3231](https://github.com/Asherlc/dofek/pull/3231), frozen at [`ed26f38b89888e0b06c37efa6d1b7d10305d7c94`](https://github.com/Asherlc/dofek/tree/ed26f38b89888e0b06c37efa6d1b7d10305d7c94). The base is `2752451fb4a7404e5d887d32341595a42a673dcd`.

[Inventory](inventory.tsv) assigns a disposition to every one of the 728 changed paths; [summary](summary.json) counts those dispositions. A path disposition is not a claim that its entire diff was imported. Selected production hunks preserve main's Redpanda names, wire parsers, v1 batch markers, fences and acknowledgement order.

## Extracted here

- Scoped deletion resolves complete versions using immutable `(id,user_id,provider_id,recorded_at)` membership, then applies all latest mutable scope predicates. This retains full-row `argMax` semantics while allowing existing primary-key pruning. See [ClickHouse tuple IN](https://clickhouse.com/docs/sql-reference/operators/in) and [argMax](https://clickhouse.com/docs/sql-reference/aggregate-functions/reference/argmax).
- New publication always derives the existing deterministic sample ID. Caller-provided IDs are rejected; historical wire IDs remain accepted. `MetricStreamInsert.id` is removed, and consumer fixtures use derived IDs.
- Docker metadata emits `latest` only for the default branch, using the stock [metadata action enable expression](https://github.com/docker/metadata-action#latest-tag).
- Curated [history recovery](../history-clickhouse-recovery-20261108/README.md), deletion-scope audit, and identity qualification evidence are copied unchanged. Their dates and source revisions identify historical observations, not new audits or current rollout approval. The source incident chronology remains available in the frozen commit; only the completed history recovery entry is added to the current baseline.

## Other dispositions

[Kafka PR 3233](https://github.com/Asherlc/dofek/pull/3233) owns broker deployment, R2/Terraform and broker readiness/environment hunks. [Erasure PR 3234](https://github.com/Asherlc/dofek/pull/3234) owns account erasure, required analytics work/ownership schema and writer dependencies, catalog evidence and privacy integration. Sibling ownership records responsibility; it does not assert their current heads have completed extraction.

Native transport renaming, marker v2, publisher factory and acknowledgement redesign are deferred rather than imported. Existing main clients already use KafkaJS. Pulsar tooling and its binary mirror prerequisite are retired experiments. Compose/CI broker replacement, coverage exemptions, dependency changes and broad active-doc rewrites tied to those experiments are not required by this fix. Diagnostic-only test instrumentation and timing snapshots are retained at the frozen source. No fourth implementation effort is created by these dispositions.

All omitted historical experiments remain individually listed in the inventory and recoverable from the immutable tree. This avoids copying old operational instructions into active runbooks. No production operation, image build, migration replay, historical identity scan or archive-body read was performed for this extraction.

## Verification checkpoints

The handoff recorded RED: the old query read 77,824 rows against a required bound below 32,768, and ingress tests caught accepted caller IDs. After the minimal source hunks, the 68 ingress/sink unit tests and 21 consumer unit tests passed; 40 writer/producer/route unit tests also passed. Root TypeScript checking and Biome passed. All 20 sink integration tests passed on ClickHouse 26.10.2.103. All 20 tests also passed on exact ClickHouse 26.6.1.1193 (verified using `SELECT version()`), with retries disabled on both engines. Tests use isolated current-schema fixtures, not historical production backfills.

## Retrospective

The pre-existing failing regression and explicit sibling ownership kept the runtime diff small. Separating historical receipts from current instructions required the most review. For the next split, record path and hunk ownership before implementation and retain one immutable source revision. Suggested documentation improvement: add that sentence to the PR splitting guidance. Reuse `integration-tests-ready` and `verification-before-completion`; no custom validator or new skill is needed.

## Review follow-up

The [Sourcery review](https://github.com/Asherlc/dofek/pull/3235#pullrequestreview-5818332363) identified unconditional `latest` entries in the ML and deploy workflows; those now use the same default-branch guard. The identity integration scenarios are separated from the lifecycle suite to keep both below 1,000 lines.

The immutable tuple is an explicit precondition, backed by the frozen [incoming identity audit](../metric-stream-history-identity-audit-20261107/summary.json) and [retained deletion-candidate audit](../metric-stream-deletion-scope-audit-20261108/summary.json). Arbitrary historical movement between user/provider/time tuples is outside that contract. Wire parsers retain IDs for replay; they do not establish that such movement is supported. Mutable activity/channel/external ID corrections remain covered by executable regressions.

For a same-revision batch, deletion means the latest row matches any supplied scope. Every latest row satisfying a scope also satisfies that scope's candidate predicate, so losing the candidate-scope index does not introduce an extra deletion under the immutable identity contract. Retaining a historical candidate association would not change that set.

Activity-only candidate discovery can still scan broadly. This change removes the second global version scan; it does not promise bounded reads for all supported scopes. Requiring user IDs would break the existing activity-only contract, and adding a new stored access path without workload evidence would exceed the approved minimal fix. The code now states this limitation beside candidate discovery. No timeout, optimizer tuning, migration or scope restriction was added.
