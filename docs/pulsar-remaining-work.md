# Pulsar release scope and remaining work

Last reconciled: November 5, 2026 UTC, through source checkpoint `81b5fb84f`.

This is the current continuation index for the Pulsar project. It separates
the next release milestone from the work still required afterward. The dated
plans below retain detailed tests and interfaces; their task checkboxes alone
are not a current completion report. Update this index when a checkpoint passes
or the release scope changes. A local fixture pass is not production approval.

## Approved release split

The user approved a transport-first milestone on November 5. Its scope is:

- Replace sensor transport with Pulsar, the official Consumer and the existing
  grouped sink; retire the Kafka transport at the verified cutover.
- Keep PeerDB as canonical CDC. Make no new causal CDC completion claim.
- Keep new sensor archives in the existing erasable JSONL format, with the
  archive consumer moved to Pulsar.
- Keep physical storage limits, resource qualification and account-erasure
  gates binding, including bounded identifier capture for large accounts.
- Keep all four production holds until a separate restoration decision.

This milestone is **not completion of the full project**. Bounded analytics,
owned CDC, the new CDC generation and complete legacy archive conversion remain
tracked below. Account-specific long-term sensor archives remain the approved
target; using JSONL for the first milestone does not cancel that decision.

Detailed source requirements:
[transport plan](superpowers/plans/2026-11-03-single-server-pulsar.md),
[bounded analytics plan](superpowers/plans/2026-11-03-bounded-analytics.md),
[qualification evidence](pulsar-qualification.md),
[account-erasure runbook](account-erasure-runbook.md).

### Release assembly and continuation

The development branch contains deferred and partly wired analytics/CDC work.
It is not the first-release artifact. The proposed assembly path is a dedicated
release branch from `main`, carrying only the first-release transport, grouped
sink/journal, erasure, archive, deployment and storage changes. Deferred work
remains on `dull-baboon`. The user explicitly approved the separate
`pulsar-foundation` branch and workspace for the first infrastructure/test PR.
It contains the isolated topology, offload correction and native evacuation CI,
without application pipeline changes. The first PR, [#3226](https://github.com/Asherlc/dofek/pull/3226), merged on
November 5 after all current checks and review passed, as
[`8328b28d4`](https://github.com/Asherlc/dofek/commit/8328b28d4d47ea3fd765f1b1cd4df77d9c20c0bf).
Its Expo compatibility prerequisite [#3227](https://github.com/Asherlc/dofek/pull/3227)
also merged. The approved foundation workspace is being brought forward with
normal merges from main for subsequent focused PRs; deferred source remains
on `dull-baboon`.

The next focused PR, [#3228](https://github.com/Asherlc/dofek/pull/3228), moves
the three existing publisher interfaces into a transport-neutral module and
updates direct imports. It changes no Kafka behavior or schema. Lint, all three
type checks, focused tests and independent review passed; full tests and required
CI remain pending. This is preparatory work, not a working Pulsar sensor path.

The user also authorized monitoring each focused PR, correcting failures,
merging after required checks and review pass, and continuing through subsequent
work until the whole project is finished. Keep this index current across that
cycle. Production maintenance and restoring the holds remain separate gates.
The user approved pausing automatic Deploy Web: its API state was verified as
`disabled_manually`, with no deployment in flight. Re-enabling it is an explicit
cutover/restoration step: the current [full-stack replica check](../.github/workflows/deploy-web-stack.yml)
requires the history sink at one replica, conflicting with its zero-replica hold.
The [deployment trigger](../.github/workflows/deploy-web.yml) remains disabled
while focused PRs merge.

The assembly audit must show that every included new table has a production
writer and erasure policy, every export has a production consumer, and no
deferred migration or runtime path is activated. Do not hide deferred work
behind feature flags or compatibility bridges. Verify Kafka retirement and
the absence of dual sensor writers before production cutover. These are open
assembly gates, not completed review findings.

## Verified checkpoint

| Area | Evidence and limit |
| --- | --- |
| Retained history | All 53,283,854 retained records in 534 objects were independently verified in R2. The consumed prefix was trimmed using stock record deletion. About 33 GB was free at the last observation. The 18,836,612-record unread tail also remains local. Original R2 archives are preserved. See the [manual offload record](pulsar-qualification.md#november-4-manual-offload-verified-method-bulk-copy-in-progress). |
| Sink | One local group-of-500 run reached 984.3 samples/s with complete row, receipt, frontier and acknowledgement accounting. This is not a combined production throughput result. See the [analytics checkpoint](../src/analytics/README.md). |
| Bounded sensor SQL | Original, pathological and four-times-background cases exercised the 128 MiB query allowance. Deduplication reached approximately 120 MB with 320 held parts; production overlap remains a risk. See [resource tests](../src/db/deduped-sensor-read-model.integration.test.ts). |
| Scalar executor | Owner, page recovery, account guards, generation checks, publication revisions and visible memory failure are implemented. Deduplication and activity execution are not activated. See [executor tests](../src/analytics/bounded-analytics.integration.test.ts). |
| CDC source boundary | Transaction accounting and typed decoding cover seven source tables plus projected parent ownership context. Snapshot, complete parent-delete cascade and temporal boundary evidence are retained. No owned CDC writes or cross-topic application frontier exist. See [fixtures](../src/analytics/test-fixtures/README.md). |
| Latest code validation | Commit `841064140`: 66 focused cases, the real ClickHouse temporal round-trip case, TypeScript and source formatting/spelling checks pass. Full unit tier: 24,782 passed, 19 existing skips. |
| Native archive parser and eraser | Legacy/native keys, malformed-ID rejection and exact surviving bytes pass unit and real S3 tests. Source checkpoint `81b5fb84f` is pushed; production activation remains gated. See [archive layout](metric-stream-redpanda-r2-runbook.md#prepared-pulsar-native-key-variant). |
| Lifecycle | The authorized stable-endpoint run passed alert, mixed-ledger offload, expiry, A removal, evacuation, exact B reads before/after deliberate broker and replacement restarts, old-source retirement and cleanup. This qualifies the local model only. See the [successful result](pulsar-qualification.md#november-5-stable-endpoint-lifecycle-passes). |

## First milestone: unfinished release gates

| Work | Current state | Next concrete evidence / completion rule |
| --- | --- | --- |
| Full transport lifecycle | Local stable-endpoint model passed | Carry its tested sequence into erasure integration. Production Swarm addressing, realistic evacuation duration and whole-host limits remain separate checks; do not repeat the completed local qualification. |
| Physical storage boundary | Narrow kernel proof and [maintenance/preflight runbook](analytics-storage-runbook.md) exist; production boundary not enabled | Finish the [storage preflight and isolation gate](superpowers/plans/2026-11-03-bounded-analytics.md#task-8-physical-storage-preflight-resource-isolation-and-aggregate-qualification), including outage/fill behavior. Host inspection and the final writer startup barrier are distinct open gates. Review exact installed-tool commands, allocations and recovery before maintenance approval. Logical backlog quotas and alerts do not replace this gate. |
| Production Pulsar deployment | No Pulsar services in the production stack | Add reviewed pinned broker, bookie, metadata and offload configuration through the [deployment task](superpowers/plans/2026-11-03-single-server-pulsar.md#task-6-production-configuration-resource-enforcement-and-recovery-evidence). Verify required secret names, stable addressing, actual caps, matched restore and failure behavior. No production deployment is authorized by this document. |
| Native sender and runtime wiring | Position codec, envelope types, Consumer and grouped sink exist; sender/runtime cutover incomplete | Finish [producer task 2](superpowers/plans/2026-11-03-single-server-pulsar.md#task-2-native-producer-and-durable-transport-positions) and [consumer task 3](superpowers/plans/2026-11-03-single-server-pulsar.md#task-3-bounded-consumer-and-processing-evidence). Exercise send/acceptance/receipt/ack crashes, control commands and byte bounds. One canonical sensor transport at cutover. Audit the accumulated branch changes against first-release entrypoints so deferred analytics/CDC paths cannot be activated accidentally; do not deploy this development branch as-is. |
| JSONL archive consumer | Existing writer consumes Kafka | Move its transport intake onto the official Pulsar Consumer while preserving payload bytes, erasure reachability and archive acknowledgement semantics. Legacy keys remain unchanged; new objects use the explicit native key variant described below. Verify restart and failed-upload behavior. The gzip JSONL payload format stays unchanged. |
| Erasure integration | New coordination tables classified; full production integration unfinished | Complete [transport erasure task 4](superpowers/plans/2026-11-03-single-server-pulsar.md#task-4-erasure-and-physical-retention-proofs), including day-29 inventory, restore handling and explicit incidents for unattributed ledgers. Failed-delete orphan cleanup remains a documented residual risk, not an automatic-delete permission. |
| Large-account identifier capture | A 400,000-ID fixture exceeded 128 MiB in the existing single aggregation | Source audit also found whole identifier sets retained in Node, remote snapshots and verification parameters. Paging only the initial SELECT is insufficient. Classify direct ownership predicates and dependency-ordered parent predicates first; retain a durable paged inventory only for families that genuinely require it. Qualify the complete path under [analytics task 7](superpowers/plans/2026-11-03-bounded-analytics.md#task-7-erasure-ownership-and-writer-barriers-for-all-new-state). The fixture does not prove failure at production's different ceiling; it also does not qualify large-account erasure. |
| Retained-PeerDB host fit and cutover | Earlier paper fit is conditional; no combined soak or production addressing qualification | Reconcile the host budget with PeerDB retained, archive intake and required storage reserve. Exercise real addressing/restarts, R2 outage, stopped consumption, bounded disk/RSS and the website workload. Then prepare the sealed cutover/rollback procedure. Keep the unread tail and all four holds until their explicit gates and restoration decision. |

Pulsar's [retention/expiry](https://pulsar.apache.org/docs/5.0.x/cookbooks-retention-expiry/)
and [tiered storage](https://pulsar.apache.org/docs/5.0.x/tiered-storage-overview/)
are inputs to these tests, not substitutes for measured physical deletion.
The fixture's static endpoint models stability; actual production service
addressing must be tested with [Swarm service discovery](https://docs.docker.com/engine/swarm/networking/#configure-service-discovery).

Hold restoration also requires either safe journal retirement or a measured capacity
proof for the entire history/provider drain with margin. R1 journal exhaustion
stops acknowledgments and intake; alerting must show time until full. This
capacity gate supplements the separate restoration consent.

The bounded-erasure implementation is in progress, not qualified. Its canonical
contract uses direct account predicates, typed indirect domains and request-owned
pages; unknown ClickHouse schemas and unmatched staging tables fail closed.
Physical-proof pages must survive destructive mutations. A November 5 read-only
production count found zero erasure requests or retained snapshots. The planned
schema transition therefore uses a locked, atomic empty-state precondition rather
than a speculative legacy converter. If that precondition changes, rollout stops
for a recovery decision. Old request producers and workers must remain quiesced
through the transition; a table lock alone does not fence them after commit.

### Native archive format and deployment order

Legacy gzip JSONL objects and their keys remain unchanged. New Pulsar objects
will use an explicit native key variant under the existing erasure prefix,
retaining original event bytes and native-position provenance. The shared
parser and eraser must support both variants in production before or together
with the first native object; writer activation must never precede erasure
support. Unknown key forms fail closed. Parser and eraser source are qualified
at [checkpoint 81b5fb84f](https://github.com/Asherlc/dofek/commit/81b5fb84f):
109 focused cases, a real S3 erasure case and 24,826 unit tests passed. The
writer, release assembly and production activation are not done. See
the [current archive parser](../src/metric-stream/r2-replay.ts) and
[archive erasure](../src/account-erasure/archive-erasure.ts).

The approved Node Consumer remains the intake strategy. Queue, group-count and
byte bounds are required settings, with RSS measured at activation. Create-only
uploads must verify identical existing content before acknowledging. A crash
may produce overlapping objects when group boundaries change; this is an
at-least-once archive, not an exactly-once claim. Avoid duplicating partition
identity in the key unless the parser checks agreement. Ownership, native drain
evidence and erasure races remain release gates.

## Deferred work that remains required

| Work | Existing implementation / evidence | Resume point |
| --- | --- | --- |
| Journal retirement | No safe retirement boundary exists in the current covered-replay protocol | Add a durable retirement certificate and downstream-coverage proof before deleting journal/manifests/receipts. R1 retains them on a physically capped disk with visible backpressure. No age-only TTL or partition purge. R2 bootstrap must cover raw rows ingested during R1 too; see [cap scope](analytics-storage-runbook.md#first-release-cap-scope-and-journal-retention). |
| Bounded activity effects | Sensor SQL and structural journal foundations exist | [Analytics task 4](superpowers/plans/2026-11-03-bounded-analytics.md#task-4-bounded-activity-impact-and-durable-downstream-effects): complete prior/current associations, paged fan-out, deletion and activity-only CDC edits. |
| Deduplication/activity executor and activation | Scalar checkpoint exists; remaining stages and full closure do not | [Tasks 5–6](superpowers/plans/2026-11-03-bounded-analytics.md#task-5-serialized-executor-query-ownership-and-output-before-cursor-recovery): stage recovery, query ownership, causal coverage and truthful job/cache completion. Bootstrap effects over existing raw data before activation. Retire unowned dbt subprocess writers as required by the final ownership model. |
| Owned CDC | Pure transaction gate and eight-context decoder exist; no raw writes | [Owned CDC assessment](owned-cdc-assessment.md) and [CDC coverage task](superpowers/plans/2026-11-03-bounded-analytics.md#task-6-causal-sensorcdc-coverage-and-truthful-jobcache-completion). First establish bounded cross-topic commit-prefix application; a complete transaction alone is insufficient. Then implement revision-scoped parent ownership, CDC effects, atomic transaction integration and all 18 destinations. Unknown ownership/schema/incarnation blocks. PeerDB retirement is deferred. |
| CDC destination generation | UInt128 within one lineage adopted on paper; six current integer mappings narrow the source domain | Build real new-generation destinations and an executable canonical catalog comparison, including Int64 priorities/offsets and enforced temporal domains. Finish fenced snapshot-to-stream bootstrap and atomic generation exchange. Never mix or rank lineages. [Type checkpoint](pulsar-qualification.md#november-5-parent-ownership-and-destination-domain-checkpoint). |
| Long-term account archives | Layout approved; no routing or deletion qualification | Implement and qualify account-topic routing, concurrent erasure, offloaded-object inventory and physical cleanup for both converted and ongoing sensor archives. Shared CDC transport is not a long-term personal archive. |
| Full legacy conversion | Streaming byte-preserving reader exists; complete metadata census reached EOF | [Transport task 5](superpowers/plans/2026-11-03-single-server-pulsar.md#task-5-convert-all-existing-r2-archives-into-native-pulsar-storage): sender, transfer ledger, account routing, changed-object recovery, completion and read verification. Preserve every source occurrence and original bytes. Ownerless personal controls are blocked unless canonical ownership is established. Markers provide provenance, not new completion. |
| Archive capacity and replay | 399,547 objects / 56,803,150,041 compressed listed bytes inventoried; no full conversion rate proof | Measure producer compression, hot ledger/offload bandwidth and bounded memory/disk on representative objects. Do not extrapolate one gzip ratio to the full archive. Only the verified unread history tail is a known raw-ingestion candidate; other archives' ClickHouse coverage remains unknown. Replaying old version-zero rows with fresh ingestion times can change winners. |
| Final restoration and retirement | No production Pulsar cutover or provider restoration | [Final integration](superpowers/plans/2026-11-03-bounded-analytics.md#task-9-bootstrap-migration-integration-and-final-restoration-gates) and [transport task 7](superpowers/plans/2026-11-03-single-server-pulsar.md#task-7-sealed-cutover-complete-archive-conversion-and-incident-recovery). Reconcile all source/transfer boundaries, restore holds only by explicit decision, verify original provider checkpoints and retire obsolete paths only after verified replacement. |

## Continuation rules and immediate next step

Production remains on its existing transport and PeerDB until a reviewed
cutover. Analytics refresh, Ride with GPS and Strava queues remain paused; the
history ClickHouse sink remains at zero. Preserve original provider jobs and
checkpoints, the unread local tail and every original R2 archive. The approved
[expiry policy](account-erasure-runbook.md#approved-broker-expiry-policy-for-the-pulsar-migration)
permits unread backlog expiry for the deletion deadline only with an alert,
operator incident and incomplete sync status; it does not authorize arbitrary
loss or false reconstruction claims.

Immediate next step: complete checks and review on the isolated
`pulsar-foundation` PR, merge when its required gates pass, then take the next
unfinished first-release gate above. The local lifecycle run is terminal and
passed; do not duplicate it. Local terminal sessions and private artifact paths are in the
workspace progress ledger; checked-in evidence is linked from the qualification
record. Use [the testing guide](testing.md) and preserve the approved local
resource overlays when running engine tests.

At each milestone, update the relevant row with its commit, verification and
remaining limit. Keep deferred items open until their stated proof exists.
This index replaces repeated handoff reports; it does not replace the detailed
plans, source fixtures or operational runbooks.
