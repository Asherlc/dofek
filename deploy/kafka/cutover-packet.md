# Broker-only cutover qualification packet

Status: **withdrawn hot-log alternative; blocked for merge and activation**.
Kafka WITH tiered storage is the user's required objective. Commands and release
assumptions below are retained review artifacts, not a tiered cutover packet.
The current tree is hot-log-only and the worker guard rejects remote storage;
passing checks do not qualify that tree for the required migration. See the
[tiered proof boundary](qualification.md#tiered-storage-required-quiescence-review).
The user has since [accepted the specific late-upload residual](tiered-fencing-proposal.md#accepted-exception-and-intended-stock-path).
The custom fencing plugin is not selected; stock tiered runtime/configuration and
ordinary deletion verification still need qualification. This acceptance does
not make the hot-log commands below suitable for activation.
Capacity/policy, merge sequencing and retirement gates below must close before final mutation
commands and a maintenance window are approved. Do not reuse the aborted combined
release packet. See [the aborted attempt](https://github.com/Asherlc/dofek/blob/ed26f38b8/docs/evidence/kafka-cutover-attempt-20261108/README.md).

## Pinned application contract

Read-only Swarm inspection on November 8, 2026 confirmed these service images:

| Services | Immutable image |
|---|---|
| web, worker, legacy and live ClickHouse sinks | `ghcr.io/asherlc/dofek@sha256:b5676e5616082a09184397f0ea328b28e9d1320c4124cbafaf4f0578899e2d84` |
| history ClickHouse sink | `ghcr.io/asherlc/dofek@sha256:d8ca75d14b4da18057f3cf43d34889adf3d65c4927caccee69a8cee34e8120a1` |
| all three R2 archives | `docker.redpanda.com/redpandadata/connect:4.99.0@sha256:0e1fb0a8c14d8752e3bb56a317ebe0867bdb61873fe2bb3cfcb64f9139589989` |

The old application and Connect use `REDPANDA_BROKERS`. The repaired history
image already requires `KAFKA_BROKERS`; preserve that service's existing key.
Actual-image protocol checks and their limits are recorded in
[qualification.md](qualification.md).

Refresh this observation immediately before proposing maintenance. Capture
service task templates privately, including replicas, environment, Swarm config
IDs, network IDs and image digests; do not publish environment values. Docker
documents [service inspection](https://docs.docker.com/reference/cli/docker/service/inspect/).
No application image, migration journal, ClickHouse version or PeerDB mirror
change belongs in the broker operation except the separately approved narrow
worker safety image. Keep web, both older sinks, the repaired history sink and
Connect individually pinned; do not roll them onto the new worker image.

## Canonical candidate specification

The normal deployment uses `deploy/stack.yml` plus `deploy/stack.oracle.yml`;
there is no hot-log overlay or mode flag to omit on a later release. A schema
render of those two files verified the following effective bindings:

| Service | Effective candidate |
|---|---|
| Kafka image | `apache/kafka:4.4.0@sha256:833b867a9585a141da455dc2b57431c65cbccb27f11c91f694444cca9f777e0f` |
| Remote storage | `KAFKA_REMOTE_LOG_STORAGE_SYSTEM_ENABLE=false`; no plugin mount or credentials |
| Broker data | `/mnt/dofek-data/kafka-hot-log/data` → `/var/lib/kafka/data` |
| Worker data view | Same host source → `/var/lib/dofek/kafka-data:ro` |
| Retired Redpanda hold | Original `/mnt/dofek-data/redpanda` → `/var/lib/dofek/retired-broker-data:ro` |
| Worker image | `ghcr.io/asherlc/dofek@sha256:a498aaa503db452480fdd43a71cc8799aa2564eea30a070e0296a08effc48620` (review candidate only) |
| ClickHouse | Unchanged `26.6.1.1193-alpine` |

The [review build](https://github.com/Asherlc/dofek/actions/runs/42506782417)
succeeded for source `cd9c4eb28d186a2fab9af2ac2e91864c32f38477`.
Registry inspection matched that OCI revision and the digest above; its executable
platform is Linux/arm64. The [image runtime receipt](worker-image-proof.json)
records the packaged production retention phase rejecting logical-only expiry,
preserving six topic generations across restart, accepting native removal, and
rejecting a retained Redpanda entry. It used the production Node flags and telemetry
preloads with read-only storage mounts. Unrelated retention gates were test
stand-ins: this is not a complete queue-driven worker boot or production rollout.

The fresh hot-log path avoids reusing the stopped tiered broker's configuration
and generation. Leave `/mnt/dofek-data/kafka/data` and any existing plugins
untouched. The [aborted-attempt receipt](https://github.com/Asherlc/dofek/blob/ed26f38b8/docs/evidence/kafka-cutover-attempt-20261108/README.md)
records no application writes and zero latest offsets on all six new Kafka
topics before stop. Exclusion of that old tree from an account-data hold relies
on that specific no-application-write record, not on offset absence as a physical
deletion proof. Any contrary or unknown application-write history blocks the
proposal until that storage is included in the hold; do not scan historical bodies.
Already-managed R2/Terraform/Infisical resources remain declared and untouched.

## New-worker source review

The image will include both this branch's narrow guard and the already-merged
main baseline `2752451fb4a7404e5d887d32341595a42a673dcd`, rather than a literal
binary patch to deployed `f02798b72a144d137a0bd06ca111ad23f0c2c800`.
Use ordinary read-only source comparisons against the review image's source SHA,
not the changing review branch head:

```sh
git diff --name-only f02798b72a144d137a0bd06ca111ad23f0c2c800 cd9c4eb28d186a2fab9af2ac2e91864c32f38477
git diff f02798b72a144d137a0bd06ca111ad23f0c2c800 cd9c4eb28d186a2fab9af2ac2e91864c32f38477 -- src/jobs src/account-erasure src/metric-stream src/processing src/providers src/db
git diff f02798b72a144d137a0bd06ca111ad23f0c2c800 cd9c4eb28d186a2fab9af2ac2e91864c32f38477 -- drizzle/meta/_journal.json src/db/clickhouse-migrations/registry.ts
```

The worker entrypoint runs `src/db/run-migrate.ts`, then `src/jobs/worker.ts`.
The migration journals match the deployed source; that proves no new tracked
migrations in this candidate, not blanket application compatibility.

Worker-reachable baseline changes include the bounded archive reader in
`src/account-erasure/archive-erasure.ts`, `src/metric-stream/archive-lines.ts` and
the imported `src/metric-stream/r2-replay.ts` parser. FIT jobs, provider persisters,
`src/db/metric-stream-writer.ts`, `src/metric-stream/write-metric-stream.ts` and
`src/processing/metric-stream-processing-publisher.ts` switch type imports to
`src/metric-stream/publisher.ts`; producer interface declarations moved out of
`redpanda-producer.ts` without changing that producer's executable methods.
The selected provider paths are Apple Health `db-insertion.ts`/`import.ts`, Fitbit
`persisters.ts`, Polar `sync-service.ts`, `sync-run.ts` and Wahoo
`activity-persister.ts`. Server/mobile entrypoints, tests, development fixtures
and historical documentation are not additional production worker commands.
Review the source diff and the bounded archive-reader evidence already recorded
in [the baseline qualification](../../docs/pulsar-foundation-qualification.md);
do not repeat historical archive downloads or identity scans.

The [successful CI run](https://github.com/Asherlc/dofek/actions/runs/42508916991)
qualifies review head `5dd8ad9c758f478ff894f33c41a956b058513c5c` (94 successful jobs,
eight skipped). Its later changes are tests, documentation and an environment
input type annotation; the pinned image still has the source revision above.
Keep those identities distinct when reviewing the artifact.

## Merge and release sequencing

Green CI does not establish safe merge timing. The repository's
[Deploy Web trigger](../../.github/workflows/deploy-web.yml) follows successful
main CI. Its [production pipeline](../../.github/workflows/deploy-web-environment.yml)
runs Terraform before the [stack preflight](../../.github/workflows/deploy-web-stack.yml)
requires an already active Kafka broker and rejects active Redpanda. Merging while
Redpanda remains active would start that pipeline and then block application
deployment after the infrastructure stage. Approve the merge/cutover sequence
before merging; do not disable workflows or assume a green branch is inert.

The new worker is a Kafka-specific release. It requires the native Kafka mount
and generation metadata, so it is not qualified to replace the current Redpanda
worker in advance. Finish old-generation erasure requests on the old worker,
then stop it with the other writers during the approved pause. Bind the new
worker image, both read-only mounts and all three source-topic settings together
before resuming it on Kafka. Keep web and every sink/archive separately pinned.
The worker entrypoint runs the existing migration launcher; matching journals
do not authorize a migration operation in this broker-only release. Its exact
launch command belongs in the separately reviewed mutation packet.

Combining the account-erasure hardening PR also requires an explicit merge of
the six structural checkpoint fields (`topic`, `partition`, `low`, `offset`,
`clusterId`, `topicId`) into that branch's request-store scrub projection. A
wholesale scrub/runtime replacement can discard the captured generation.
Kafka owns the guard; the other PR must not add a duplicate implementation.
The [scrub regression](../../src/db/account-erasure.integration.test.ts) and
[runtime wiring tests](../../src/jobs/account-erasure-runtime.test.ts) describe
the required integration contract. Sequencing that combination remains open.

### Recommended order for approval

This is a proposal, not authorization to perform the steps. It uses the existing
Swarm/Kafka tools and leaves automation unchanged.

1. **Offline:** accept the explicit six topic names and source byte-policy
   proposal, complete measured capacity/headroom review, and approve the retained
   Redpanda hold/retirement boundary. Preserve the aborted Kafka tree and its
   recorded no-application-write exclusion; unknown contrary history blocks that
   exclusion. Resolve the erasure scrub projection only if combining that PR;
   the standalone Kafka worker does not require importing its broader redesign.
2. **Before production approval:** freeze the broker-only mutation packet to
   the Kafka digest, worker digest, each existing application/Connect digest,
   host paths, six group/topic assignments and exact service task templates.
   Refresh metadata and the old-generation request preflight. Approval must
   identify the ingress pause, old-consumer drain, worker launch, first-write
   boundary, observation interval and recovery authority. No secret values or
   historical archive bodies belong in the packet.
3. **Production approval required:** perform that broker-only operator cutover
   while this PR remains open, using the pinned review artifacts and stock tools,
   following the ordered boundaries below. Keep the repaired history image and
   all other existing images individually pinned; only the narrow worker changes.
   No full-stack workflow, Terraform apply or old-data retirement is part of this
   cutover. Before the first Kafka write, reversal requires the stated empty-write
   proof; afterward preserve both logs and use separately reviewed forward recovery.
4. **Separate release qualification and approval required:** qualify the normal
   application release that will follow merge. The [base stack](../stack.yml)
   shares `APP_IMAGE` across web, worker and all ClickHouse sinks, and the
   [normal deployment](../../.github/workflows/deploy-web-stack.yml) verifies that
   shared release. It cannot preserve the broker packet's separate history image
   pin. The later release must contain the qualified history repair, reconcile
   any combined erasure scrub fields, and review its Terraform/app/schema effects
   as that release's own scope. Broker protocol checks are insufficient for this.
5. **Merge approval required:** merge only when Kafka is already active and that
   subsequent automatic application release is qualified and authorized. Observe
   the existing main-CI → Terraform → stack deployment path. Do not disable its
   trigger, add a bypass flag, or treat merge as an inert source-only action.

Q2 approved **broker-only cutover before merge, then a separately qualified
normal application release** as the planning order (user answer: “Y”). The
[operator proposal](operator-proposal.md) records the stock command shapes and
remaining execution preconditions. That decision does not authorize production
steps, accept the byte-policy change,
establish capacity, or authorize old-data deletion. Until those concrete gates
are closed, the PR remains ready for review rather than ready to merge.

## Stop gates

1. **Qualified worker and configuration:** require the new worker image, matching
   read-only mounts and the canonical hot-log broker. The guard is wired into
   final retention and rejects remote storage; it is not a tiered-storage verifier.
   Existing requests without native generation checkpoints must finish on the
   old source before cutover. Do not fabricate UUIDs or reinterpret old offsets.
2. **Retired broker bytes:** stopping Redpanda also stops its retention work.
   Retaining its tree for rollback does not establish physical erasure. The new
   worker blocks final completion while any entry remains in the original root.
   Preserve that root in place; agree the hold and separately authorized retirement
   boundary before pausing production. Do not move or delete the old tree under
   cutover approval.
3. **Archive identity:** the retained Connect config writes keys containing
   topic, partition, UTC date/hour and first/last offsets. New-cluster offsets
   can repeat. Select explicit distinct topic names for all three routes, or
   prove another existing configuration prevents collisions. No implicit topic
   generation or application transport-epoch migration is authorized.
4. **Current-image qualification:** producer, sink and archive paths must pass
   against stock Kafka with the existing `REDPANDA_BROKERS` contract. A local
   protocol-only test does not qualify R2 tiered retention or a full service boot.

## Capacity and proposed topic policy

Read-only metadata on November 8 reported `/mnt/dofek-data` size
157,396,975,616 B, used 109,727,657,984 B and available 39,599,476,736 B
(about 36.9 GiB). This snapshot includes retained old trees. It is not a measured
ingest peak or a reservation against database growth.

| Route | Observed Redpanda byte retention | Time retention | Earlier unselected source-cap illustration |
|---|---:|---:|---:|
| Legacy | 40 GiB | 7 days | 1 GiB |
| Live | Unlimited by bytes | 7 days | 1 GiB |
| History | Unlimited by bytes | 7 days | 1 GiB |

Quarantine uses the existing 1 GiB/seven-day policy. The earlier six-cap
illustration sums to 6 GiB before segment overshoot, indexes, metadata and delayed cleanup.
**The earlier source byte limits illustrate a change to the current replay policy;
they are not selected.** The user accepts shortening retention to fit disk in
planning, with durability taking priority over speed. Exact limits still need
explicit policy acceptance and measured burst/headroom review; current free space
does not prove a safe outage window. The existing JSONL archive is retained, but
the [canonical runbook](../../docs/metric-stream-redpanda-r2-runbook.md#replay)
says bounded replay is not shipped; recovery outside broker retention is not
demonstrated. See the [window/durability assessment](replay-capacity-options.md)
for 6/24/72-hour comparison targets, evidence gaps and the proposed aggregate
observation. None is yet a measured feasible window. No topic policy has been
changed. Kafka documents [retention](https://kafka.apache.org/44/configuration/topic-configs/).

Proposed fresh namespace (generated for this review, not yet applied):

| Route | Kafka source topic |
|---|---|
| Legacy | `metric-stream-kafka-76012b6a-8894-4834-93b1-2260f79ff7d3` |
| Live | `metric-stream-live-kafka-76012b6a-8894-4834-93b1-2260f79ff7d3` |
| History | `metric-stream-history-kafka-76012b6a-8894-4834-93b1-2260f79ff7d3` |

Each source gets its existing `.quarantine.v1` suffix, one partition and RF1.
These names are distinct from the old v1/v2 namespaces; preserve all six existing
consumer group names and each actual image's broker-variable contract. The archive
key continues to include the source topic and offsets, so do not substitute an
old topic name on the fresh cluster. Approval must bind these names explicitly.

## Ordered review and execution boundaries

After all stop gates are resolved, fill in exact topic assignments, image
references, operator commands and expected outputs in this packet. Use stock
[Swarm service updates](https://docs.docker.com/reference/cli/docker/service/update/)
and [Kafka topic tools](https://kafka.apache.org/44/operations/basic-kafka-operations/),
not a new deployment CLI or the full-stack application workflow.

1. Verify working instrumentation and capture the current service/image snapshot,
   source topic partition counts and high watermarks. Capture committed offsets
   for the three ClickHouse sink groups and three matching R2 archive groups.
   Use the existing legacy/live/history service-to-topic contract, not inferred
   defaults. Record all six groups individually.
2. Prepare the isolated hot-log Kafka service with its fresh dedicated data
   directory and canonical remote-storage-disabled specification. No RSM plugin,
   plugin directory or broker R2 credentials are part of this candidate. Preserve
   existing managed R2 resources and the old Kafka/Redpanda trees. Keep every
   application endpoint pointed at Redpanda. Verify Kafka API readiness with an
   external JVM and create the explicitly reviewed source/quarantine topics.
   Record topic IDs, partition counts, RF and full retention configuration.
3. Pause ingress and all writers using the reviewed service task templates.
   Drain in-flight work; capture final old-cluster high watermarks. Require each
   of the six consumer groups to reach its own source boundary and prove archive
   writes succeeded. A single zero-lag observation is not an archive identity
   audit; do not repeat completed historical body scans.
4. Stop the six old consumers and Redpanda, preserving their exact task templates
   and data tree. Verify actual tasks have stopped, not just desired replicas.
   Do not prune the stack or run application/schema migrations.
5. Apply the reviewed endpoint/topic changes to the existing image of each
   consumer service. Bind the narrow worker release and matching read-only mounts
   while it remains stopped. Start and verify all six consumer routes on Kafka. Keep writers
   paused until readiness, topic identity, group assignment and archive output
   boundaries match the approved packet.
6. Record the **first Kafka application write** as a distinct recovery boundary.
   Resume the existing web image and the separately reviewed new worker image
   with their reviewed endpoint/topic settings; do not replace other images.
   Verify all six consumers, persisted archive objects, application readiness,
   Kafka/R2 errors and resource limits under the bounded agreed observation.

## Recovery

Before the first Kafka application write, reversal may restore the captured
old service templates and Redpanda endpoints only after proving the new-cluster
application offsets remain empty. Restore the original replica counts and verify
all six original routes before reopening ingress. Do not infer reversal safety
from a failed deployment step alone.

After the first Kafka application write, stop writers and preserve both logs.
Use a separately reviewed forward-recovery plan. Do not flip back, reset offsets,
manually acknowledge messages, replay archives or delete either data tree.

Document exact symptoms, first fatal log line, user impact, recovery boundary,
mitigation and remaining risks in the production incident baseline if any
activation step fails. The [Swarm task-state reference](https://docs.docker.com/engine/swarm/how-swarm-mode-works/swarm-task-states/)
explains why desired replica counts alone are insufficient evidence.
