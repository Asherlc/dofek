# Deploy-owned Kafka topic policy

The quarantine startup fix merged in
[#3237](https://github.com/Asherlc/dofek/pull/3237). The production broker
audit on November 12 observed tiered storage enabled on all six metric-stream
topics and successful copy/delete activity in its bounded log sample. The
audit preceded the selected local-retention policy below; it observed
local settings `-2`, which inherit total retention. This document describes the
canonical policy reconciliation in the existing deployment workflow. It replaces the
[earlier manual correction proposal](https://github.com/Asherlc/dofek/blob/d4e7a34e49f4e91f57a7b76dbb2735a944b4e224/deploy/kafka/quarantine-config-correction.md);
no SSH-only repair is required by the intended release path.

## Canonical policy and owner

[`topic-policy.json`](topic-policy.json) is the infrastructure definition for the
three existing source topics and their three quarantine topics:

| Setting | Source | Quarantine |
| --- | --- | --- |
| cleanup.policy | delete | delete |
| retention.ms | 604800000 (seven days) | 604800000 (seven days) |
| retention.bytes | -1 (no byte cap) | 1073741824 (1 GiB) |
| local.retention.bytes | 1073741824 (1 GiB) | 268435456 (256 MiB) |
| local.retention.ms | 86400000 (one day) | 86400000 (one day) |
| segment.ms | 3600000 (one hour) | 3600000 (one hour) |
| segment.bytes | 134217728 (128 MiB) | 134217728 (128 MiB) |
| remote.storage.enable | true | true |

The table shows the selected policy in [`topic-policy.json`](topic-policy.json),
not a claim that its new explicit local limits are live. The audit observed
`local.retention.bytes=-2` and `local.retention.ms=-2`; total limits were source
4 GiB and quarantine 1 GiB. The [tiered-storage audit](retention-policy.md)
records this observation and qualification. Kafka tiering uses separate local
and total retention controls; byte limits are retention targets rather than
hard disk caps. See [Kafka tiered storage](https://kafka.apache.org/44/operations/tiered-storage/)
and [topic configuration](https://kafka.apache.org/44/configuration/topic-configs/).
The application separately enforces its existing exact quarantine safety
requirements; it does not rewrite operator settings during startup.

The workflow takes topic names from the existing rendered sink environments.
It retains the existing missing-topic and broker-route checks and rejects
aliased routes before mutation. It does not create replacement topics, reset
offsets, rewrite routing or change the archive namespace.

## Normal deployment sequence

The existing [web-stack workflow](../../.github/workflows/deploy-web-stack.yml):

1. Verifies Kafka and existing topic routes through the normal preflight.
2. Applies its normal quiesce overlays and waits for old processing tasks to
   exit before migrations. The requested image contains the fixed quarantine
   writer. Existing image/source, migration and CDC gates stay in place.
3. Before restoring consumers, applies the selected policy to all six topics
   using the pinned Kafka operator container outside the broker cgroup.
   `kafka-configs.sh --alter --add-config` performs incremental SET operations;
   unspecified overrides are preserved. This is the stock
   [Kafka 4.4 implementation](https://github.com/apache/kafka/blob/4.4.0/tools/src/main/java/org/apache/kafka/tools/ConfigCommand.java#L558-L564),
   not legacy full replacement or an application startup repair.
4. Uses the existing KafkaJS Admin API in the requested application image to
   read back all six exact topic resources. Every selected key must have the
   declared value and explicit topic-config source. Missing, duplicate,
   mismatched or errored evidence fails the release before consumer restoration.
5. Restores the requested consumers through the existing stack rollout and
   stability checks, then performs the same policy readback again. This catches
   startup code that clears overrides after reconciliation. A mismatch fails
   the release; there is no warning-and-continue or automatic repair loop.

The JSON policy is the single deployment input for mutation and verification.
There is no new operator CLI, service, credential, Infisical key or persistent
tracking store. The generated six-topic input is temporary runner data.

The active tiered-storage deployment uses this same workflow and policy
definition. Do not reapply the historical phase-1 remote=false policy. The
[tiered-backend and erasure-verifier](tiered-cutover-packet.md) safeguards and
the canonical release workflow remain required.

## Qualification and limits

- Executable workflow tests cover all six route/role updates, the requested
  verifier image, failure propagation, both readback calls, and rejection of
  aliased routes before any update. Existing rollout tests remain in the same
  suite; the existing Docker double was extracted into a test helper to keep
  the test file below the repository's 1,000-line limit.
- The [native Kafka receipt](../../docs/evidence/kafka-topic-policy-20261109/native.json)
  records stock incremental convergence on six synthetic topics, matching
  readback, fixed-writer connect/reconnect, unchanged topic IDs and offsets,
  and preservation of an unrelated compression override.
- Actual readback rejects both an
  [incorrect value](../../docs/evidence/kafka-topic-policy-20261109/value-drift.log)
  and an [inherited default](../../docs/evidence/kafka-topic-policy-20261109/default-source.log)
  whose value happens to match. Reconciliation repairs selected-key drift.
- The native CLI ran in an isolated Docker fixture. The identical verifier
  logic ran on host Node 26/KafkaJS 2.2.4 with only the broker endpoint changed to
  the fixture address. Local Docker had only 872 MiB free, insufficient to pull
  the application image safely; this is not a claim of fresh packaged-image
  qualification. Production remains unchanged.
- The original runtime fix separately passed 66 units, nine native Kafka
  integrations, three typechecks and full lint, and its
  [primary mutation report](../../docs/evidence/kafka-quarantine-config-fix-20261109/stryker.txt)
  records all 69 counted mutants killed. Those results are provenance, not a
  substitute for this workflow's tests and current-head CI.

## Concrete release proposal

Before applying the selected new local limits, review the exact source/image
through the existing normal web-release workflow. Do not deploy an image built
from a different source revision: the stock resolver requires matching source
and immutable image identity. Historical release receipts describe earlier
state; use the canonical policy readbacks to establish the effective limits.

Before production approval, inspect fresh topic identity/config, service and
reserve metadata against the selected policy and review the actual delta. The
normal release then performs the reconciliation and readbacks above; there is
no separate manual topic-update step. Keep the existing 20 GiB reserve,
stop/preserve/forward recovery boundary, original Redpanda/aborted Kafka data,
retained-RP erasure-completion hold and independent archive/backup checks.

This documentation does not authorize deployment, topic writes, OCI apply,
credential edits, offset resets or old-data retirement. No new Terraform
resources or applies are introduced.
