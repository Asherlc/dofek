# Pulsar release scope and remaining work

Last reconciled: November 5, 2026 UTC; PRs #3226, #3228, #3229 and #3230 merged; draft [#3231](https://github.com/Asherlc/dofek/pull/3231) is in progress.
Deferred development source remains on `dull-baboon`.

This is the current continuation index for the Pulsar project. It separates
the next release milestone from the work still required afterward. The dated
plans below retain detailed tests and interfaces; their task checkboxes alone
are not a current completion report. Update this index when a checkpoint passes
or the release scope changes. A local fixture pass is not production approval.

## Approved release split

**Pending scope decision:** The user requested minimal changes and a small
transport-neutral application boundary, so changing brokers does not change
jobs such as `sync-processing-operation`. A proposal awaits approval to defer
the analytics journal and placements to R2 and retain R1's raw sink, durable
replay checkpoints, archive, erasure and storage gates. This would supersede
the capped-journal choice below; it has **not** been approved. Preserve the
unfinished journal work and do not assemble either alternative as settled.
Legacy version-0 rows need explicit replay qualification: the
[current production sink](../src/metric-stream/clickhouse-sink.ts) assigns
ingestion times, so storage-engine replacement alone is insufficient evidence
that replay preserves the winning row.

The user approved a transport-first milestone on November 5. Its scope is:

- Replace sensor transport with Pulsar, the official Consumer and the existing
  grouped sink; retire the Kafka transport at the verified cutover.
- Keep PeerDB as canonical CDC. Make no new causal CDC completion claim.
- Keep new sensor archives in the existing erasable JSONL format, with the
  archive consumer moved to Pulsar.
- Keep physical storage limits, resource qualification and account-erasure
  gates binding, including bounded identifier capture for large accounts.
- Keep all four production holds until a separate restoration decision.
- Keep safe journal retirement in R2, as the user confirmed on November 5.
  R1 retains the grouped sink and physically capped journal, alerts at 70%
  with projected time remaining, and stops intake if the cap fills. Exact
  allocations and runway must pass the host-budget gate before deployment.

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

The next focused PR, [#3228](https://github.com/Asherlc/dofek/pull/3228), moved
the three existing publisher interfaces into a transport-neutral module and
updates direct imports. It changes no Kafka behavior or schema. Lint, all three
type checks, 23,698 unit/mobile tests, independent review and all 126 CI checks
passed. It merged as [`b5a29c6c0`](https://github.com/Asherlc/dofek/commit/b5a29c6c01819b2587a1ef9a351271f66a189d37).
This is preparatory work, not a working Pulsar sensor path.

[#3229](https://github.com/Asherlc/dofek/pull/3229) prepares native archive-key
recognition in the existing eraser, with no new dependencies or writer activation.
Its final 62 focused unit cases, two real S3 erasure cases, types, lint,
23,729 unit/mobile tests and required CI passed. Review fixes reject decoded
topic line terminators. It merged as
[`5a16593ba`](https://github.com/Asherlc/dofek/commit/5a16593ba574f547ec20907494fb1a4f67469397).
The native sender now has 18 focused tests and migrated production callers in
the foundation workspace. It remains uncommitted and cannot ship until Consumer,
archive, shutdown and deployment wiring form a complete runtime slice.

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
| Sink | The Foundation path uses official streaming `exec()` and consumes the full response under the query owner. Its complete 19-case real Postgres/ClickHouse suite passes, including groups of 1 and 500, replay, controls, receipts and frontiers. Two additional real-broker cases pass: pre-ACK failure followed by exact ID/byte redelivery without another raw version, and ordered delete/replacement. Source review found no critical or important issue. See checkpoint [ebcf7d1b1](https://github.com/Asherlc/dofek/commit/ebcf7d1b1) and its [qualification limits](https://github.com/Asherlc/dofek/blob/pulsar-foundation/docs/pulsar-foundation-qualification.md#november-5-real-broker-to-native-sink-composition). Current-path throughput, sustained memory and production recovery remain open; the earlier DULL figure of 984.3 samples/s does not qualify them. Nothing was deployed. |
| Bounded sensor SQL | Original, pathological and four-times-background cases exercised the 128 MiB query allowance. Deduplication reached approximately 120 MB with 320 held parts; production overlap remains a risk. See [resource tests](../src/db/deduped-sensor-read-model.integration.test.ts). |
| Scalar executor | Owner, page recovery, account guards, generation checks, publication revisions and visible memory failure are implemented. Deduplication and activity execution are not activated. See [executor tests](../src/analytics/bounded-analytics.integration.test.ts). |
| CDC source boundary | Transaction accounting and typed decoding cover seven source tables plus projected parent ownership context. Snapshot, complete parent-delete cascade and temporal boundary evidence are retained. No owned CDC writes or cross-topic application frontier exist. See [fixtures](../src/analytics/test-fixtures/README.md). |
| Earlier development validation | Commit `841064140`: 66 focused cases, the real ClickHouse temporal round-trip case, TypeScript and source formatting/spelling checks pass. Full unit tier: 24,782 passed, 19 existing skips. |
| Native archive parser and eraser | Key parsing merged in PR #3229. Bounded, exact-byte streaming merged in [PR #3230](https://github.com/Asherlc/dofek/pull/3230) as [`2752451fb`](https://github.com/Asherlc/dofek/commit/2752451fb4a7404e5d887d32341595a42a673dcd), with all nine required CI checks passing. Its 54 focused cases and six real-S3 cases cover framing, byte bounds, buffer ownership, EOF and ETag safety. Source is merged; automatic deployment remains paused. See [archive layout](metric-stream-redpanda-r2-runbook.md#prepared-pulsar-native-key-variant). |
| Lifecycle | The authorized stable-endpoint run passed alert, mixed-ledger offload, expiry, A removal, evacuation, exact B reads before/after deliberate broker and replacement restarts, old-source retirement and cleanup. This qualifies the local model only. See the [successful result](pulsar-qualification.md#november-5-stable-endpoint-lifecycle-passes). |

## First milestone: unfinished release gates

| Work | Current state | Next concrete evidence / completion rule |
| --- | --- | --- |
| Full transport lifecycle | Local stable-endpoint model passed | Carry its tested sequence into erasure integration. Production Swarm addressing, realistic evacuation duration and whole-host limits remain separate checks; do not repeat the completed local qualification. |
| Physical storage boundary | Narrow kernel proof and [maintenance/preflight runbook](analytics-storage-runbook.md) exist; production boundary not enabled | Finish the [storage preflight and isolation gate](superpowers/plans/2026-11-03-bounded-analytics.md#task-8-physical-storage-preflight-resource-isolation-and-aggregate-qualification), including outage/fill behavior. Host inspection and the final writer startup barrier are distinct open gates. Review exact installed-tool commands, allocations and recovery before maintenance approval. Logical backlog quotas and alerts do not replace this gate. |
| Production Pulsar deployment | No Pulsar services in the production stack | Add reviewed pinned broker, bookie, metadata and offload configuration through the [deployment task](superpowers/plans/2026-11-03-single-server-pulsar.md#task-6-production-configuration-resource-enforcement-and-recovery-evidence). Verify required secret names, stable addressing, actual caps, matched restore and failure behavior. No production deployment is authorized by this document. |
| Native sender and runtime wiring | Reviewed source checkpoint [01fafeb89](https://github.com/Asherlc/dofek/commit/01fafeb89) is pushed on Foundation: sender, Consumer, grouped sink, native state and marker schema; not merged or deployed | Finish [producer task 2](superpowers/plans/2026-11-03-single-server-pulsar.md#task-2-native-producer-and-durable-transport-positions) and [consumer task 3](superpowers/plans/2026-11-03-single-server-pulsar.md#task-3-bounded-consumer-and-processing-evidence). Qualify real broker replay across an interrupted acknowledgement, controls and byte bounds. One canonical sensor transport at cutover. Complete archive intake, erasure and physical boundaries in the release unit; keep its PR unmerged until the reviewed cutover is ready. |
| JSONL archive consumer | Existing writer consumes Kafka | Move its transport intake onto the official Pulsar Consumer while preserving payload bytes, erasure reachability and archive acknowledgement semantics. Legacy keys remain unchanged; new objects use the explicit native key variant described below. Verify restart and failed-upload behavior. The gzip JSONL payload format stays unchanged. |
| Erasure integration | Writer handoff and reservation reuse qualified in [a4631e92c](https://github.com/Asherlc/dofek/commit/a4631e92c); receipt replay remains a release blocker | Five real database cases and 80 focused cases cover known-terminal handoff, durable reservations and guard failures. Preserve unknown-state Q7 blocking. Finish structural receipt redaction and incomplete scope-delete preparation attempts; replay must not restore erased identifiers or lose another account's effects. Complete [transport erasure task 4](superpowers/plans/2026-11-03-single-server-pulsar.md#task-4-erasure-and-physical-retention-proofs), including native publication fencing and archive drain before R2 rewrites, day-29 inventory and restore handling. Failed-delete orphan cleanup remains a documented residual risk. Safe journal retirement stays in R2. |
| Large-account identifier capture | Replacement source passed local 400,000/800,000 sensor-row cases with every erasure query capped at 128 MiB; not deployed | Carry the coherent paged capture, bounded snapshot, typed ownership checks, native physical proof and caller migration into the release. Complete release integration under [analytics task 7](superpowers/plans/2026-11-03-bounded-analytics.md#task-7-erasure-ownership-and-writer-barriers-for-all-new-state). The tests qualify their finite fixtures, not production erasure duration or the whole-host workload. |
| Retained-PeerDB host fit and cutover | Earlier paper fit is conditional; no combined soak or production addressing qualification | Reconcile the host budget with PeerDB retained, archive intake and required storage reserve. Exercise real addressing/restarts, R2 outage, stopped consumption, bounded disk/RSS and the website workload. Then prepare the sealed cutover/rollback procedure. Keep the unread tail and all four holds until their explicit gates and restoration decision. |

Pulsar's [retention/expiry](https://pulsar.apache.org/docs/5.0.x/cookbooks-retention-expiry/)
and [tiered storage](https://pulsar.apache.org/docs/5.0.x/tiered-storage-overview/)
are inputs to these tests, not substitutes for measured physical deletion.
The fixture's static endpoint models stability; actual production service
addressing must be tested with [Swarm service discovery](https://docs.docker.com/engine/swarm/networking/#configure-service-discovery).

The native sink's finite four-control check measured about 1.40 seconds and
134 ClickHouse calls, excluding setup, assertion reads and the replacement row.
Each control has its own receipt and frontier step; its scope is scalar.
The whole-host soak must measure the 350-control burst and a realistic large
provider deletion, including effect pages. Record total drain time and the delay
to live messages queued behind it. This small fixture is not that qualification;
see the [native sink integration cases](../src/metric-stream/clickhouse-sink.integration.test.ts).

Hold restoration also requires either safe journal retirement or a measured capacity
proof for the entire history/provider drain with margin. R1 journal exhaustion
stops acknowledgments and intake; alerting must show time until full. This
capacity gate supplements the separate restoration consent.

The bounded-erasure implementation has local source qualification; production
release integration remains unfinished. Its canonical
contract uses direct account predicates, typed indirect domains and request-owned
pages; unknown ClickHouse schemas and unmatched staging tables fail closed.
The [real-engine tests](../src/account-erasure/clickhouse-erasure.integration.test.ts)
cover 400,000 and 800,000 sensor rows with the same small parent graph, fixed
captured identity counts and 378-byte snapshots, enforcing 128 MiB per query.
The complete erasure integration run passed 213 tests across 22 files; the two
executor/erasure race cases passed separately after correcting fixture schema
isolation. The unit/mobile regression passed 24,814 tests. These are local
results, not production rollout or deadline measurements.
Physical-proof pages survive destructive mutations. A November 5 read-only
production count found zero erasure requests or retained snapshots. The planned
schema transition therefore uses a locked, atomic empty-state precondition rather
than a speculative legacy converter. If that precondition changes, rollout stops
for a recovery decision. Old request producers and workers must remain quiesced
through the transition; a table lock alone does not fence them after commit.

The String bridge domain is `group_id`. A November 5 read-only aggregate over
all retained managed physical String columns found only
`analytics.activity_duplicate_groups`: 8,692 rows, maximum key length 36 bytes.
The bounded implementation admits exact-byte keys up to 4 KiB and rejects
larger keys explicitly before payload capture. This keeps each keyset cursor
within one parameter. The closure and immutable physical proofs are covered by
the local erasure tests; production activation and the host budget remain gates.

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

The merged first-release parser slice recognizes the native key grammar
without decoding its endpoint bytes. The existing eraser discards the parsed
return and determines ownership from strict event payloads and retained
identifiers, with an ETag guard before rewriting. Opaque endpoints are upload
provenance only; this slice makes no position-ordering, partition-consistency or
replay-validity claim. Native decoding and its dependency remain with the actual
writer/replay consumers; the stricter development checkpoint is retained.

The current storage inputs and their limits are recorded in the
[runway table](analytics-storage-runbook.md#initial-journal-runway-inputs).
They do not establish a production allocation or sustained ingestion runway.
A post-merge fixture reduced the active-data estimate to about 0.98 GB/day
combined at the observed average, or 2.13 GB/day at the higher observed rate.
The user chose to keep safe retirement in R2. R1 retains the current grouped
sink, with an explicitly accepted stop if its journal cap fills. Alert at 70%
and report projected time to full; warning time depends on the qualified cap
and measured rate. Native sink assembly can proceed under this scope. Exact
capacity, deployment and restoration gates remain binding; production holds
are unchanged.
Source placement is permanent structural growth, not journal backlog. Its
bounded keyset bootstrap remains required before global identity lookup can
cover existing raw data. It remains an R1 activation gate: the current
[delete preparation](../src/metric-stream/source-effects.ts) scans matching raw
IDs and fails closed if any lacks a placement. This dependency is required for
raw deletion itself, even while analytics is held; deferring the effect bootstrap
to R2 does not remove it. A November 5 metadata-only observation counted
189,609,383 active physical raw rows in 30 parts, with no source-placement
parts returned. This is not a distinct-ID count or bootstrap-size proof; see
the [measurement record](pulsar-qualification.md#november-5-journal-sizing-and-mutation-metadata-observations).
Physical erasure metadata now passes 47 real Postgres tests, but its native
proof and caller integration remain unfinished. The selected cleanup order is
durable physical completion, removal and verified absence of native mutation
metadata, then the cleanup cursor advance. See the
[engine observation](pulsar-qualification.md#november-5-journal-sizing-and-mutation-metadata-observations).
Initial native regressions now exercise completed-mutation cleanup and retained
inactive bytes when logical residue is already zero. These focused passes do
not qualify the full path: crash recovery, schema drift, projection lineage,
remaining consumers and the 400,000-row/scaling resource gates remain open.
See the [physical proof implementation](../src/account-erasure/clickhouse-physical-erasure.ts)
and [real-engine cases](../src/account-erasure/clickhouse-erasure.integration.test.ts).
This development checkpoint is still uncommitted; the linked files name the
migration destination, not a released implementation. The final native subset
also covers historical lookup by exact table UUID across a prior rename.
Remaining caller work reuses bounded exact-byte archive line parsing and a
cohesive PeerDB mirrored-row proof, while retaining its real slot/WAL gate.
The [oversized-record procedure](account-erasure-runbook.md#prepared-bounded-archive-records)
documents the 900,000-byte line limit, sampled real-data evidence and the
unqualified legacy-data risk. Full erasure and scaling suites still gate the
single coherent erasure commit.

The native sender and process-cleanup slice passes 270 focused tests and type
checks. The actual final server image also loaded the official native module
on Linux ARM64 as UID 1000, with networking disabled. This closes module
packaging only, not sender/Consumer behavior or whole-host resource gates.
See the [shipping-image result](pulsar-qualification.md#november-5-arm-server-image-native-module-check).

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
| Safe journal retirement — R2 | Explicitly deferred by the user on November 5; not implemented | Complete the [retirement to-do list](#r2-safe-journal-retirement-to-do) before reclaiming recovery proofs. R1 retains them behind its physical cap. |
| Bounded activity effects | Sensor SQL and structural journal foundations exist | [Analytics task 4](superpowers/plans/2026-11-03-bounded-analytics.md#task-4-bounded-activity-impact-and-durable-downstream-effects): complete prior/current associations, paged fan-out, deletion and activity-only CDC edits. |
| Deduplication/activity executor and activation | Scalar checkpoint exists; remaining stages and full closure do not | [Tasks 5–6](superpowers/plans/2026-11-03-bounded-analytics.md#task-5-serialized-executor-query-ownership-and-output-before-cursor-recovery): stage recovery, query ownership, causal coverage and truthful job/cache completion. Bootstrap effects over existing raw data before activation. Retire unowned dbt subprocess writers as required by the final ownership model. |
| Owned CDC | Pure transaction gate and eight-context decoder exist; no raw writes | [Owned CDC assessment](owned-cdc-assessment.md) and [CDC coverage task](superpowers/plans/2026-11-03-bounded-analytics.md#task-6-causal-sensorcdc-coverage-and-truthful-jobcache-completion). First establish bounded cross-topic commit-prefix application; a complete transaction alone is insufficient. Then implement revision-scoped parent ownership, CDC effects, atomic transaction integration and all 18 destinations. Unknown ownership/schema/incarnation blocks. PeerDB retirement is deferred. |
| CDC destination generation | UInt128 within one lineage adopted on paper; six current integer mappings narrow the source domain | Build real new-generation destinations and an executable canonical catalog comparison, including Int64 priorities/offsets and enforced temporal domains. Finish fenced snapshot-to-stream bootstrap and atomic generation exchange. Never mix or rank lineages. [Type checkpoint](pulsar-qualification.md#november-5-parent-ownership-and-destination-domain-checkpoint). |
| Long-term account archives | Layout approved; no routing or deletion qualification | Implement and qualify account-topic routing, concurrent erasure, offloaded-object inventory and physical cleanup for both converted and ongoing sensor archives. Shared CDC transport is not a long-term personal archive. |
| Full legacy conversion | Streaming byte-preserving reader exists; complete metadata census reached EOF | [Transport task 5](superpowers/plans/2026-11-03-single-server-pulsar.md#task-5-convert-all-existing-r2-archives-into-native-pulsar-storage): sender, transfer ledger, account routing, changed-object recovery, completion and read verification. Preserve every source occurrence and original bytes. Ownerless personal controls are blocked unless canonical ownership is established. Markers provide provenance, not new completion. |
| Archive capacity and replay | 399,547 objects / 56,803,150,041 compressed listed bytes inventoried; no full conversion rate proof | Measure producer compression, hot ledger/offload bandwidth and bounded memory/disk on representative objects. Do not extrapolate one gzip ratio to the full archive. Only the verified unread history tail is a known raw-ingestion candidate; other archives' ClickHouse coverage remains unknown. Replaying old version-zero rows with fresh ingestion times can change winners. |
| Final restoration and retirement | No production Pulsar cutover or provider restoration | [Final integration](superpowers/plans/2026-11-03-bounded-analytics.md#task-9-bootstrap-migration-integration-and-final-restoration-gates) and [transport task 7](superpowers/plans/2026-11-03-single-server-pulsar.md#task-7-sealed-cutover-complete-archive-conversion-and-incident-recovery). Reconcile all source/transfer boundaries, restore holds only by explicit decision, verify original provider checkpoints and retire obsolete paths only after verified replacement. |

### R2 safe journal retirement to-do

Status: **required, deferred to R2, not implemented**. The user confirmed this
release boundary on November 5. Start from the current
[covered-replay coordinator](../src/analytics/analytics-delivery.ts),
[stream state](../src/analytics/analytics-work-store.ts) and
[journal/receipt protocol](../src/analytics/effect-journal.ts).

- [ ] Persist a monotonic retirement certificate per stream. Advance it only
  when the processed frontier covers the range and no pending group, retained
  completed descriptor or owner intent still requires its proofs.
- [ ] Make replay recognize certified retired ranges while preserving full
  receipt verification above the certificate. Unknown owner state, epochs or
  recovery evidence must block safely.
- [ ] Implement bounded physical cleanup under the existing serialized owner.
  Persist eligibility before deleting anything; make cleanup resumable after
  a crash. A time window alone is not proof of eligibility.
- [ ] Require downstream coverage when analytics is active. Bootstrap effects
  from all required raw data, including R1 intake, before analytics activation.
- [ ] Qualify crashes around certificate persistence, cleanup and
  acknowledgment; pending/completed descriptor protection; replay after
  cleanup; account erasure across retained and retired ranges; and actual
  space reclamation within the storage budget.

This retires ingestion bookkeeping, not canonical sensor data. Preserve raw
ClickHouse data, R2 archives and permanent source-placement indexes according
to their own lifecycle policies. Keep physical caps and alerts after retirement
ships. Restoring the production holds still needs its capacity proof and
separate approval; see the [storage contract](analytics-storage-runbook.md#first-release-cap-scope-and-journal-retention).

## Continuation rules and immediate next step

Production remains on its existing transport and PeerDB until a reviewed
cutover. Analytics refresh, Ride with GPS and Strava queues remain paused; the
history ClickHouse sink remains at zero. Preserve original provider jobs and
checkpoints, the unread local tail and every original R2 archive. The approved
[expiry policy](account-erasure-runbook.md#approved-broker-expiry-policy-for-the-pulsar-migration)
permits unread backlog expiry for the deletion deadline only with an alert,
operator incident and incomplete sync status; it does not authorize arbitrary
loss or false reconstruction claims.

Immediate next step: complete native sender/Consumer/archive runtime composition
and bounded erasure proof integration in parallel. Open each release unit only
when it has its production callers and prerequisites, then monitor its required
checks and review. The assembled transport-switch PR must stay unmerged until
the maintenance window is complete, physical quotas pass their preflight, the
host budget is approved and the cutover runbook is reviewed. Merge and deployment
are the cutover action: the next deployment of that source switches the transport,
so a paused workflow is not a substitute for release readiness. The local lifecycle run is terminal and
passed; do not duplicate it. Local terminal sessions and private artifact paths are in the
workspace progress ledger; checked-in evidence is linked from the qualification
record. Use [the testing guide](testing.md) and preserve the approved local
resource overlays when running engine tests.

Merging the archive prerequisite does not activate production Pulsar. The
sender, Consumer, sink, archive writer, storage/deployment qualification and
controlled cutover still have to form the release unit. When integrating the
prepared paged erasure code, build on the
[merged byte reader](https://github.com/Asherlc/dofek/blob/2752451fb4a7404e5d887d32341595a42a673dcd/src/metric-stream/archive-lines.ts)
and [eraser](https://github.com/Asherlc/dofek/blob/2752451fb4a7404e5d887d32341595a42a673dcd/src/account-erasure/archive-erasure.ts).
Preserve final-line termination, CRLF blank-line handling, copied source
fragments and the awaited scan pipeline; replacing those files from an older
development snapshot would regress the merged fixes.

At each milestone, update the relevant row with its commit, verification and
remaining limit. Keep deferred items open until their stated proof exists.
This index replaces repeated handoff reports; it does not replace the detailed
plans, source fixtures or operational runbooks.
