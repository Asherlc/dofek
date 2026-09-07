# Human modifications to health records

Status: proposed design, grounded in source inspection. No runtime implementation,
migration, or executable proof is included in this document. The scenarios below
are acceptance criteria to prove with database-backed tests.

## Approved product direction

Dofek will have one shared system for human edits, deletion, restoration, and
modification history across user-visible health records. MCP, web, and mobile
will call the same domain services. Existing UI mutations, including Delete
Activity, migrate to this system; adding editing controls to every screen is a
subsequent UI project.

The integration scope includes all user-visible health-record domains: workouts
and their structured details, nutrition, supplements, sleep, body measurements,
journal, subjective observations, cycle/health events, medication doses, and
clinical records. Sensor telemetry and calculated aggregates are excluded from
direct editing. Human-created records use domain creation contracts where
meaningful; creation does not manufacture sensor streams, calculated metrics, or
provider-authored clinical documents.

Human changes are field-level. Unchanged fields follow the latest source data.
History is append-only, with separate restore, clear-override, and undo actions.
MCP uses activity, nutrition, and health write scopes. Existing tokens do not
silently gain permissions. Existing activity deletion state must migrate into
the new system, with `activity.deleted_at` removed at the completed cutover.

These decisions supersede the earlier food-only copy-on-write proposal. They do
not authorize transmitting corrections to external providers or changing
account-erasure semantics.

## Findings that shape the design

| Evidence in current code | Design consequence |
| --- | --- |
| [Apple Health import](../../../src/providers/apple-health/import.ts) deletes food rows in the imported range. [Nutrition insertion](../../../src/providers/apple-health/db-insertion.ts) recreates them with a deterministic external ID. | Source-row UUIDs cannot be the durable key for corrections. |
| [Activity deletion](../../../packages/server/src/repositories/activity-repository.ts) marks all currently matched source activities with `deleted_at`. | Preserve group deletion intent and source membership evidence, not merely the visible winner ID. |
| [Activity source model](../../../analytics/models/read_models/activity_source_records.sql) filters deletion before downstream analytics. | Both Postgres and ClickHouse must consume the new visibility decision. An API-only override is insufficient. |
| [Body measurement model](../../../analytics/models/read_models/body_measurement.sql) groups scalar samples into measurements; its representative ID is `min(id)`. | A measurement correction targets a stable observation identity, not that representative ID or a daily summary date. |
| [Supplement schema](../../../src/db/schema/nutrition.ts) versions definitions and constrains dose successor chains to the same occurrence and definition. | Effective schedule changes and corrections to a past occurrence have different semantics. |
| [Auto-supplements](../../../src/providers/auto-supplements.ts) generates roots and advances planned occurrences to unknown. | Human occurrence state must survive automation without rewriting its source history. |
| [Journal schema](../../../src/db/schema/events.ts) identifies imported answers by user, provider, date, and question. | Natural identity can be a tuple rather than an external ID. Editing the displayed date must not change that source identity. |
| [Activity router](../../../packages/server/src/routers/activity.ts) queues refresh after the deletion transaction. [Processing event store](../../../src/processing/processing-event-store.ts) already supports transactional outbox writes. | Reuse the processing outbox for durable modification-to-analytics delivery. |

Provider-owned records are unchanged by **human commands**. This does not mean
the existing ingestion system is an immutable archive: providers currently
upsert and replace source rows. This project preserves human history, not a
complete historical copy of every provider payload.

## Architecture choice

Use an append-only Postgres modification ledger, typed domain adapters, and
canonical SQL projections. Keep source facts and human assertions distinguishable
throughout serving and analytics.

The core coordinates identity, authorization, concurrency, history, idempotency,
and delivery. Each adapter owns allowed fields, units, source membership,
cross-field validation, creation, effective-time behavior, and downstream
dependencies. The database access remains in repositories; tRPC and MCP are
transport adapters. This follows the existing
[repository architecture](../../../packages/server/README.md).

```text
UI / MCP -> domain command service -> Postgres transaction
                                    | human change + targets + typed values
                                    | processing operation + outbox
                                    v
Source data + human assertions -> effective domain records
                                    | Postgres canonical queries
                                    | CDC -> existing dbt models
                                    v
                            derived metrics -> UI / MCP
```

Existing Postgres transactions and constraints fit this requirement; they allow
the modification and its processing obligation to commit together
([transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html),
[constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)).
KurrentDB is an established alternative with event streams and expected-revision
checks ([streams](https://docs.kurrent.io/server/v25.1/features/streams),
[concurrency](https://docs.kurrent.io/clients/node/v1.3/appending-events)). It would
introduce another persistence service and coordination with Postgres source and
domain writes. No requirement demonstrated here warrants adopting it; no new
event-store dependency is proposed.

JSON Patch is a useful reference for explicit operations
([RFC 6902](https://www.rfc-editor.org/info/rfc6902/)), but clients receive typed
`set` and `clear` fields, not unrestricted paths into database rows. JSON Merge
Patch uses null to remove members, which cannot express our distinct meanings
of explicit null and following the provider again
([RFC 7396](https://www.rfc-editor.org/info/rfc7396/)). No general patch engine is
needed for a finite, schema-validated set of fields.

## Identity and grouping

The durable key is `(user, domain, identity namespace, source key)`. The namespace
includes the provider/account identity when the ingestion contract distinguishes
accounts. Source keys use provider IDs when available; otherwise adapters use
the actual versioned natural-key contract from ingestion. A Dofek-created record
gets an application UUID at creation.

An edited timestamp, name, value, or date never replaces the original source key.
Source-row UUIDs are lookup aliases. Import replacement must not cascade-delete
the ledger. A schema migration that changes an identity algorithm must retain an
explicit identity mapping for existing corrections.

For Apple Health XML nutrition, the present key comprises record type, source
name, and original start/end timestamps. Reimporting that key with a different
row UUID must preserve the human decision. If upstream changes those key fields
and supplies no stable ID, it is a different identity under the current importer.
No generic ledger can prove equivalence from timing or names alone. Such cases
need provider evidence or explicit user reconciliation, never automatic fuzzy
transfer of a deletion.

A deduplication group is a query result, not a permanently frozen list of source
members. Store the exact source targets of each human command. At read time,
resolve their assertions against current group membership. A winner change must
not lose a correction, and a later group split must not leave unrelated records
permanently joined by a historical mapping.

For workouts, maintain the source matching graph independently of human display
and interval overrides. Resolve group-wide overrides after source matching and
before sensor-window selection or calculations. Tombstoned source identities
must remain available to matching so a later duplicate can inherit group
visibility. This requires changing the current early deletion filter; simply
renaming `deleted_at` is insufficient.

For example, deleting a current group containing A and B records targets A and
B only. If source C later joins that component, it inherits the component's
effective hidden state at read time; no C target is appended to the original
command, and C acquires no independent tombstone. If C subsequently separates
from all tombstoned members and has no deletion assertion of its own, that
inherited hiding ends. The current matching graph supplies this association;
the design does not require a separately persisted group-level assertion or a
permanent group identifier. Historical targets and effective group visibility
answer different questions and must remain distinguishable in provenance.

If two independently modified groups later join, compatible assertions combine.
Conflicting explicit values for the same field produce an explainable conflict;
provider priority and wall-clock timestamps do not silently choose a human winner.
The affected value and dependent calculations are unavailable until a new command
resolves the conflict over the current target set. Unaffected fields remain usable.

## Ledger responsibilities and invariants

The storage needs three core responsibilities, with names finalized during the
implementation plan:

1. **Record identity:** unique user/domain/source keys, with no duplicated mutable
   current record or revision counter. Identity entries are created on a human
   mutation or human creation, not as a write side effect of listing records.
2. **Human change:** immutable command ID, user, actor/client/channel provenance,
   command kind, schema version, recorded time, effective time where applicable,
   and typed changed values. Persist human input once, not full provider snapshots.
3. **Change targets:** exact identity set and predecessor change for each target.
   One multi-source command is atomic; ownership and predecessor chains have
   same-user constraints. Only one successor is allowed for a target/head pair,
   including the initial head.

The latest human head and effective overrides are query-derived. A rebuildable
ClickHouse projection is allowed; a second independently writable Postgres
current-state store is not. Order is established by the predecessor chain, not by
timestamps. Lock affected identities in a deterministic order and enforce
uniqueness so concurrent first edits cannot create two histories
([Postgres locking](https://www.postgresql.org/docs/current/explicit-locking.html),
[unique constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)).

Nutrient values are a typed exception to a generic JSON payload: they must stay
in the canonical food/supplement nutrient-row storage, not also in ledger JSON.
The nutrition implementation must extend those row ownership contracts to attach
human revision values, with exclusive source-or-revision ownership, nutrient
foreign keys, and one value per revision/nutrient. The ledger stores operation
metadata and references; scalar nutrient amounts have one owner. No food copy
with all provider nutrients is created. Final DDL must be reviewed alongside
the canonical nutrition-view tests before this integration is executable.

History records who made a human assertion and when. An MCP operation identifies
both the authorizing user and the authenticated client; client input cannot spoof
those fields. This is inspired by provenance's who/what/when distinction, without
claiming that the ledger is a FHIR server or a FHIR-conformant resource
([FHIR Provenance](https://hl7.org/fhir/R5/provenance.html)).

## Command semantics

All mutations include a user-scoped request ID. Commands targeting existing
records include an expected version obtained from a record read; creation uses
an explicit expected-absent precondition on its new identity. The version
describes human heads, source membership, and relevant
source field versions. It does not contain health data or credentials. Repeating
the same request ID and payload returns the committed result; reusing that ID
with a different payload is a conflict. Revision, targets, typed values, and
processing work commit atomically inside the existing account-erasure fence.

| Command | Meaning |
| --- | --- |
| `create` | Create a human-origin record through its domain contract, recording its initial author. |
| `update` | Set explicit validated values, including null where valid. Omitted fields retain their prior override state. |
| `clearOverrides` | Remove selected human assertions so those fields follow the latest eligible source values. |
| `delete` | Append a visibility tombstone. It does not mean skipped dose, provider absence, or physical erasure. |
| `restore` | Undo human deletion while retaining field overrides. Provider absence remains independent and may still prevent visibility. |
| `undo` | Append a compensating human change for a specific prior operation. Never delete history or overwrite intervening decisions. |
| `history` | Read paginated human operations, exact targets, and available provenance, including deleted targets. |

For non-head undo, reject when a later operation touched any affected field or
visibility state. A caller may reread and submit a deliberate new correction.
Clearing a field differs from setting it to the provider's present value: the
latter remains an override when that provider value changes again.

For Postgres sources, lock/recheck relevant source rows during validation. For
ClickHouse observations, validate against the observed source version and state
the version used in the result; there is no cross-database atomic compare-and-set.
A future source update changes untouched fields and triggers revalidation of the
effective record. Incompatible time bounds or other domain invariants surface a
conflict instead of emitting an invalid effective record. Do not describe an
observed ClickHouse version as a lock on concurrent ingestion.

## Domain policies

| Family | Identity and editable information | Resolution obligations |
| --- | --- | --- |
| Activity | Provider activity identity/group; name, notes, classification, perceived exertion, validated time context and bounds. | Preserve source membership; recalculate bounded sensor analytics and dependent load. Averages, distance derived from GPS, and expenditure estimates cannot be assigned directly. |
| Strength/climbing/finger loading | Parent source identity plus stable provider child identity; exercise, reps, load, grade, attempts, protocol facts. | Missing stable child IDs require an importer identity contract; ordinal-only addressing cannot survive arbitrary source reorder. Dependent summaries use corrected child facts. |
| Food/itemized nutrition | Provider item identity; food details, date/meal, serving facts, individual nutrient amounts. | Apply per-record corrections before contribution selection and aggregation. Keep source attribution and itemized grain. |
| Provider nutrition samples | Original sample/source identity; recorded nutrient amount and supported time metadata. | Source-supplied aggregate records may be corrected; Dofek-calculated daily totals cannot be overwritten. Do not turn one corrected aggregate into a new competing itemized source. |
| Supplement schedule/definition | Stable supplement ID plus definition/effective interval. | A future schedule change creates a new immutable definition through the domain service. It does not rewrite nutrients of historical dose occurrences. |
| Supplement dose | Supplement schedule ID and original occurrence date, with definition binding. | Human status applies above the provider event chain. Only effective `taken` contributes. Deletion suppresses the occurrence without meaning `skipped`. Moving an occurrence is a domain operation across both slots, not a date-field update that bypasses chain constraints. |
| Sleep | Stable provider session identity/group; bounds and provider-reported session facts. | Recompute stage intersections and affected recovery windows. Calculated duration/efficiency follow their inputs; inconsistent reported facts remain explicit. High-volume stage telemetry is outside the editor. |
| Body measurements | Stable provider observation and channel identities; measured values, units, supported timestamps. | Correct measurement inputs before reconciliation/trends. Never target `min(id)` from the assembled row or overwrite Trend Weight. Preserve original samples. |
| Journal and subjective observations | Natural source key or human record ID; answer/check-in/symptom/injury facts. | Preserve original identity when moving the display date. Recompute trends and behavioral analyses from effective facts. |
| Provider-reported daily observations | Provider/source/date/metric identity; independently reported measurements. | The adapter distinguishes provider-supplied observations from Dofek-calculated daily aggregates. Only the former can be corrected; dependent daily summaries and trends recompute. |
| Cycle and other health events | Stable source event identity; validated event facts and times. | Recompute grouping and phase evidence. Estimated phases are calculated outputs. Preserve provider history. |
| Medication doses | Stable provider dose identity; reported dose facts, status, time. | Label corrections as user assertions. Do not interpret record correction as a prescription change or send it to a provider. |
| Clinical/DEXA records | Provider document or scan identity, with typed observation children. | Allow typed corrections and annotations through domain schemas; retain the provider FHIR document/report unchanged. Derived values and provider attestations are not editable clinical facts. |

Health-record annotations already editable in the UI, such as life events and
injuries, use this service too. Account settings, provider configuration, reference
catalogs, and experimental analysis definitions are not provider health records.
Capability discovery enumerates registered families and editable fields; no client
can submit arbitrary table names, SQL columns, raw payloads, or JSON paths.

Deleting a supplement schedule stops future occurrence generation and hides it
from the active stack. It retains historical consumption. Deleting a specific
dose removes that occurrence's contribution. Erasing an entire schedule history
is a separately targeted multi-record command, not an implicit cascade.

## Concrete acceptance scenarios

All values and names here are synthetic. These are expected outcomes, not claims
that tests have run.

| Scenario | Required outcome |
| --- | --- |
| Import food sample with source key K and row A; delete it; XML reimport recreates K as row B. | B is hidden and excluded from nutrition totals; deletion history remains reachable through K. |
| Food has 500 kcal and 20 g protein. Human sets protein to 30 g. Provider later reports 520 kcal and 22 g protein. | Effective values are 520 kcal and 30 g protein, with source provenance per field. Clear protein override yields 22 g; setting protein to null does not fall back to 22 g. |
| Two 24-hour aggregate nutrient samples share a provider/source day. Human corrects only one. | Canonical totals use the corrected sample once, preserving aggregate grain and existing source-conflict rules. |
| Workout sources A and B dedupe; user deletes the displayed workout; B becomes the preferred provider later. | The workout remains hidden; changing the winner cannot restore it. |
| A+B are deleted; a late C joins the same source match group. | The group stays hidden. C is hidden by the current group decision, not silently appended to the old command. If later evidence splits C into a different workout, C can become visible with a source-resolution explanation. |
| A and B were edited independently, then become one workout with incompatible explicit names. | Report an override conflict. Preserve both histories and require a current-group correction to resolve that field. |
| Workout start changes from 08:00 to 08:10. | Effective time is immediate in record detail; refreshed streams/load use 08:10. Both old and new dependency windows are invalidated; stale metrics are marked pending, never relabeled as current. |
| Human deletes a workout, then its provider removes the underlying record. | Restore removes human deletion but reports source unavailable. It does not manufacture a replacement workout or restore erased source samples. |
| Supplement definition is 10 mg; yesterday's occurrence was taken. User schedules 20 mg starting tomorrow. | Yesterday still contributes 10 mg. Tomorrow binds the new definition. Retrospective correction requires its own explicit action. |
| Auto-supplements advances a planned occurrence after a human marked it taken. | Effective status remains taken; the raw automation history remains available. A deleted occurrence remains non-contributing even if automation runs again. |
| Body channels retain logical source keys but their sample UUIDs change on reimport. | The human correction survives and applies before measurement reconciliation. Underlying ClickHouse samples remain unchanged by the human operation. |
| UI and MCP both read head R, then update concurrently. | One commits; the other receives a conflict. Retrying a committed request after a lost response returns the same operation and creates no extra history. |
| Human changes protein, then changes meal. They undo the protein change. | Meal stays corrected. If protein was edited again in between, undo conflicts rather than erasing the later decision. |
| Database commit succeeds while Redis is unavailable. | Outbox retains the refresh obligation. Response distinguishes committed human revision from pending analytics. Reconciliation eventually publishes that revision or a visible processing failure. |
| dbt processes an old revision after a newer one. | Publication cannot replace a newer effective result. Revision acknowledgements are checked per dependency, not guessed from elapsed time or largest global event ID. |
| Another user supplies a record key, history cursor, or undo ID. | Reads and writes reject access; errors disclose no foreign record data. |
| Account erasure is active, or restores from a backup are reconciled. | Existing erasure fences cover creation and modifications; identity, history, typed values, replicas, and pending jobs participate in erasure and cannot resurrect records. |

## Serving and delivery

Postgres queries resolve effective record inputs through domain-specific views.
ClickHouse consumes ledger changes via the established CDC pipeline and resolves
them in the appropriate existing source/measurement models. The two paths share
fixtures and semantic contracts; neither silently relies on client-side merging.

A mutation transaction records a processing operation and its outbox delivery,
using the existing [processing event store](../../../src/processing/processing-event-store.ts).
Changes mark affected source keys, group members, and old/new date windows dirty.
Dependent dbt models must react to human-change arrival even when provider rows
did not change. Existing bounded model patterns and explicit lifecycle tombstones
remain required ([analytics architecture](../../../analytics/README.md),
[dbt incremental models](https://docs.getdbt.com/docs/build/incremental-models)).

The command returns the committed operation, new record version, effective record
where available, and processing state. Cached responses and derived metrics carry
their applied modification state. Reads cannot claim that a cached result includes
a revision it has not processed. While refresh is pending, retain stale values
only with explicit stale/processing status; raw record deletion must not disappear
behind a stale cache. Reuse current processing status contracts where possible.

CDC observation requires the complete committed change, targets, and typed values,
including nutrient rows. An operation marker alone is insufficient when tables
replicate independently. Reconciliation verifies all required identities/payloads
before publishing completion. Per-target predecessor ordering prevents a delayed
old operation from replacing a newer result. A sequence allocated before commit
is not proof that every smaller sequence has committed or replicated.

## API and MCP

The shared API provides capability discovery, paginated record search/detail,
creation where supported, update, clear overrides, delete, restore, undo, history,
and operation status. Reads expose stable references, human version, observed
source state, per-field provenance, allowed operations, and conflicts.

Use descriptive, typed domain tools for discovery and mutation. Keep common
history/status/undo semantics consistent across them. A transport wrapper only
handles authentication, schemas, response formatting, and semantic errors. The
service checks ownership, domain scope, account-erasure state, and every field.
Existing UI mutations delegate to it, eliminating parallel deletion logic.

MCP scopes are `activity:write`, `nutrition:write`, and `health:write`, paired with
their existing read scopes for search/history. Write permission alone does not
grant arbitrary history export. OAuth consent and token controls describe the
actions they permit; refresh does not upgrade old grants. Each tool has concrete
input/output schemas, accurate destructive annotations, and actionable failures,
following the [MCP tool contract](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

Useful MCP additions, ordered by value for this project:

1. Record search/detail with IDs, editable fields, provenance, and source conflicts.
2. Preview a proposed correction, including affected group members and date ranges.
3. Modification history, deleted-record search, restore, clear, and undo.
4. Operation status so clients can distinguish a committed correction from analytics
   still rebuilding. Existing `list_providers` already exposes sync health; extend
   operation tracking rather than duplicating provider-status tools
   ([current provider status](../../../packages/server/src/mcp/provider-status.ts)).
5. Read-only data-quality/source-resolution explanations, plus nutrition nutrient
   detail and supplement occurrence history. These support useful questions beyond
   the current summary and supplement-definition tools
   ([tool catalog](../../../packages/server/src/mcp/tools.ts),
   [supplements tool](../../../packages/server/src/mcp/supplements-tool.ts)).

Preview is a read and optional client experience; the command itself always
validates its expected version and targets. It does not require a new persistent
approval-token subsystem.

## Migration, validation, and delivery boundaries

This is a cross-domain project with multiple reviewable implementation units:
identity/ledger, domain adapters and canonical queries, analytics delivery,
transport integration, and the activity cutover. All approved domains remain in
scope; delivering a generic API without their canonical read integrations does
not complete the project.

Before implementation, produce a per-family inventory of every writer, logical
key, reader, analytics dependency, and existing UI mutation. The inspected paths
above expose real requirements but are not an exhaustive call-site inventory.
Each family requires a tested stable-key policy, including imports that reorder
children or change synthetic keys. This document does not claim those identity
gaps are already solved.

For activity migration, schema-only DDL creates the new storage first. A bounded,
resumable operator backfill records existing `deleted_at` decisions against stable
source keys, with original deletion time and unknown historical actor. Do not
invent the identity of the user/client that originally clicked Delete. Existing
timestamps cannot reliably reconstruct historic multi-source command boundaries;
record source-level legacy deletions with migration provenance.

Backfill and cutover require a controlled writer boundary: quiesce the old human
mutation writers, complete and verify the final catch-up, switch all relevant
readers/writers and analytics, then remove the old column. Do not ship permanent
dual writes, incident-only flags, or a manual-removal compatibility layer. Before
DDL execution, the operator plan must account for old server instances, workers,
CDC schemas, backfill size, dependency ordering, and recovery after cutover. No
production migration or service pause is authorized by this design artifact.

Verification must execute minimal fixtures against real Postgres and ClickHouse
for the acceptance scenarios, then exercise MCP authorization and existing UI
mutation contracts. Shared literal fixtures compare canonical effective values
and histories across SQL paths. Test reimport, group split/merge, clock changes,
null versus clear, rollback, outbox recovery, stale publication, user isolation,
and erasure. No historical production backfill runs in ordinary integration tests.
Use the repository's [explicit integration tiers](../../../docs/testing.md).

## Design review outcome and remaining proof work

The source review rejects row-UUID tombstones, copied provider snapshots,
permanently frozen dedupe groups, and response-only overrides as sufficient
implementations. The shared ledger/adapter direction remains appropriate.

Implementation planning must finish the stable-key inventory, exact typed nutrient
ownership DDL, per-domain editable-field schemas, CDC completeness checks, and
bounded invalidation dependencies. These are required proof work, not optional
future improvements. Until executable fixtures pass, describe the design as
proposed rather than proven.

For future work, add a current `docs/record-modifications.md` reference when the
system ships, with one identity/reader/refresh checklist for new providers.
Source inspection helped expose UUID churn and hidden lifecycle differences;
database-backed TDD is the appropriate next workflow for proving the design.
