# Provider protocol fix round1/5

**DONE_WITH_CONCERNS — Important finding implemented; ready for re-review.**
Source fix `55ed6754d8339858f17fb68472323c98f04a23be` is committed and pushed.
The independent protocol review starts at `e96f6068b`; the full review package
through this fix also includes separately scoped owner hardening `b86fe246c`,
its report `10a2ca901`, and root documentation `24f155695`. Owner review is
independently approved; its changes are not part of this provider access fix.
Root handled the Minor job-documentation finding. No root human docs were staged.

## Important finding and chosen access path

Read `task-2-provider-protocol-review.md` in full. Its Important finding is the
reverse ACK query: filtering `deletion_event_id`/`previous_command_id` with
`FINAL` and `LIMIT 1` on an event-ID-ordered table scans unrelated retained
history when no conflict exists. The fresh builder and forward migration had
no useful access path for that predicate.

The native assessment in `provider-ack-access-assessment.md` ruled out a
projection-only fix on the installed engine. Actual **26.10.2.103** read all
**65536 rows / 8of8 granules** before and after fully materializing an
operation/predecessor projection; both query-log records report
`projections=[]`. The first disposable probe rejected adding a projection with
the default `deduplicate_merge_projection_mode=throw`; root then authorized
`rebuild` on only that uniquely owned test table. Both probes cleaned their
fixtures. No global/service/optimizer/cap changes were made. This matches the
[official projection/FINAL limitation](https://github.com/ClickHouse/clickhouse-docs/blob/main/docs/data-modeling/projections/2_materialized-views-versus-projections.md).

Root approved a focused contract tightening for this **wholly unreleased**
event type: a command UUID is now a deterministic slot for its deletion root and
predecessor. The constructor derives UUIDv5 using the standard DNS namespace
and name `dofek.provider-generation-command.v1:` followed by canonical JSON
`[lowercaseDeletionEventId,lowercasePreviousCommandIdOrNull]`. UUIDv5's namespace,
name hashing and version bits follow [RFC9562](https://www.rfc-editor.org/rfc/rfc9562.html#name-uuid-version-5).
It reuses the existing node crypto/UUID formatting code; no dependency was added.
The existing metric-row hash inputs and emitted IDs are unchanged and their
fixed historical-ID tests pass.

There is exactly one root slot and one successor slot for any predecessor. A
strict wire validator rejects arbitrary IDs, including hand-crafted handler
inputs. Command-body changes still share that same slot, so the existing
event-ID `FINAL` point lookup validates the full immutable SHA-256 command hash
and exact receipt or rejects the conflict. The hash still includes owner,
provider, generation, source IDs, terminal state and predecessor. Predecessor
identity, exact receipt, physical stream and earlier-position checks remain.
The global pending owner still covers commit-before-ACK gaps.

The reverse global scan is removed. No second ACK store, projection, skipping
index, optimizer force, schema/key change or forward migration is needed: the
required operation/predecessor identity now maps to the canonical table's
existing event-ID primary key in both fresh and upgraded schemas. Legacy NULL
ACK rows and scope event IDs retain their semantics. No aliases, adoption or
compatibility layer accepts arbitrary command IDs from the unreleased draft.
Existing job pending/checkpoint and operator-redrive rules remain in force.

## RED→GREEN and exact checks

All logs are in this plan workspace. Engine runs use the existing private runner
with `--retry 0 --bail 1`, one worker, under root's local query-log candidate.
No lifecycle, production, retry, deadline or resource-limit changes occurred.

| Command / log | Result |
| --- | --- |
| `rtk proxy pnpm exec vitest run --project unit src/metric-stream/events.test.ts -t 'derives fixed UUIDv5\|rejects hand-crafted' --retry 0` → `provider-fix1-slot-unit-red2.log` | **2 RED**, 34 skipped: constructor required supplied ID; codec accepted an arbitrary replacement ID. Initial red log also retains a test fixture that accidentally reused its predecessor ID, corrected before this decisive run. |
| `rtk proxy pnpm tsx .superpowers/sdd/2026-11-03-bounded-analytics/run-database-tests.ts src/metric-stream/provider-generation-deletion.integration.test.ts -t commandACKLookup --retry 0 --bail 1` → `provider-fix1-access-red.log` | **RED1**, 14 skipped: actual lookup read65536 rows, exceeding16384. This is unrelated-history evidence, not an SQL-text assertion. |
| Same command after fix → `provider-fix1-access-green.log` | **GREEN1**, 14 skipped, 4.65s / 113 observed HTTP. All12 captured owned ACK queries have one QueryFinish; actual reads8192–8194 each. Exact `FINAL` plans use an event-ID PrimaryKey condition instead of `Condition:true`. |
| Same runner/file, filter `^(?!.*structural1001)` → `provider-fix1-engine-green.log` | **19 GREEN, 1 excluded original1001**, 41.22s / 3123 observed HTTP, no resource fatal. |
| `rtk proxy pnpm exec vitest run --project unit src/metric-stream/events.test.ts src/metric-stream/redpanda-producer.test.ts src/jobs/process-provider-data-deletion-job.test.ts src/jobs/provider-data-deletion-dependencies.test.ts src/jobs/queues.test.ts src/jobs/worker-queues.test.ts src/account-erasure/archive-erasure.test.ts --retry 0` → `provider-fix1-units-green.log` | **207/207 GREEN**, 7 files, 4.03s. |
| `rtk proxy pnpm typecheck` → `provider-fix1-typecheck-final.log` | Passed. Initial typecheck retained five constructor callers that still supplied removed commandId input; all were adapted. |
| `rtk proxy pnpm exec biome check <all9changedTypeScriptfiles>` → `provider-fix1-biome-final.log` | Passed, no fixes. Initial format run rejected two temporary test console calls, which were removed; retained earlier logs contain the actual read-row/plan evidence. |
| `rtk proxy git diff --check` | Passed before source commit. |

The 65k regression seeds actual unrelated legacy rows, runs real canonical fence
and terminal deliveries, records their required owner query IDs, flushes query
logs, requires the exact nonempty QueryFinish ID set and bounds every lookup's
actual `read_rows`. It also explains every distinct ACK lookup shape with
`FINAL`, asserting a useful primary-key condition. The16384 bound permits normal
8192-row sparse-index granules; it does not claim one physical row per lookup or
a whole-host throughput budget. Primary-key/granule and part cost still belongs
in resource qualification.

The expanded engine cases preserve fork safety: a hand-crafted distinct ID
claiming the same predecessor fails before raw mutation, typed ACK and delivery
receipt; the untouched old row stays live. Conflicting same-slot page and
terminal bodies also fail before touching another source, retaining the first
ACK position and exact receipt. Root slots reject changed owner, provider and
generation, without installing another fence. Existing predecessor gaps,
new-generation/moved-source preservation, userless cancellation, raw/ACK gap
replay, terminal residual checks and forward legacy ACK migration also pass.

The original1001 case is **not byte-identical** because constructor call sites
now derive IDs. Its workload remains **1001 live sources,1000+1 commands,
20-effect pages and the existing30s deadline**. It was not retried. The recorded
30-second failure remains OPEN until the separately reviewed registration work
and approved rerun; neither the19-case suite nor41-effect case substitutes for
that qualification.

## Self-review and remaining gates

- Command identity depends only on root/predecessor; including mutable page
  fields in the UUID would reintroduce forks, so fixed-vector unit checks and
  same-slot conflict engine checks protect that distinction. Expected UUIDs were
  independently calculated with Python's standard `uuid.uuid5`, not the source
  helper. UUID casing is normalized only for slot derivation.
- Canonical validation runs on the handler's acknowledgement/predecessor path
  as well as the external codec. Removing the guard admits hand-crafted forks;
  removing immutable hash/identity checks admits conflicting same-slot bodies.
  Neither check can replace the other.
- Malformed page-boundary test fixtures derive a valid predecessor slot first,
  so invalid slot identity does not mask source-count, uniqueness or terminal
  shape validation.
- No blanket recovery shortcut or public boolean was added. Same-command replay
  preserves the first ACK and replacement rows. Full Task2 remains unaccepted:
  native adapter/subscription/ACK proof, protected-index bootstrap/erasure and
  metadata writer barriers, remaining legacy/physical-erasure coverage,
  1001-effect performance and host/resource qualification stay mandatory.
- The owner registration optimization and broader throughput assessment remain
  separate work. This fix only removes the defective global control-history
  lookup; it does not claim to resolve the measured35 ClickHouse calls per row.

Retrospective: the finite native projection probe prevented shipping an access
path that `FINAL` would ignore. Deterministic slots reused the existing canonical
store while retaining exact body and receipt checks. The next review checklist
should require query predicates, physical access paths and actual read-row
evidence together; use receiving-code-review, TDD and integration-tests-ready
for the next similar change.
