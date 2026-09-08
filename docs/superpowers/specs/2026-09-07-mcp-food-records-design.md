# MCP Food Record Read and Write Design

**Status:** Approved in chat on 2026-09-07; implementation pending.

## Goal

Expose the complete food-record lifecycle through Dofek's remote MCP server:
search, detail, create, update, delete, restore, and history. Reads return the
effective human-visible record. Writes use the append-only human-record system
introduced in [PR #2678](https://github.com/Asherlc/dofek/pull/2678), so provider
rows remain raw and repeated provider imports do not overwrite human decisions.

This is the first domain integration for the approved
[universal human-record modification design](./2026-09-07-human-record-modifications-design.md).
It implements the nutrition/MCP slice without adding web or mobile editing UI.
Those clients can later call the same domain service rather than creating a
parallel mutation path.

## Non-goals

- Editing supplement schedules or dose occurrences.
- Editing calculated daily nutrition totals.
- Writing corrections back to Apple Health or another provider.
- Generic JSON mutation tools for every health domain.
- Preserving modifications for a provider record that has no stable source
  identity and is later physically replaced with an unrelated identifier.

## Chosen architecture

Add a food-specific domain service between MCP and the database. MCP owns
transport schemas, scope checks, client attribution, and tool annotations. The
service owns authorization, stable identity resolution, field validation,
idempotency, optimistic concurrency, append-only history, and effective reads.
Repositories own SQL and transactions.

```text
MCP tool
  -> FoodRecordService
       -> food record repository
       -> human-record repository
       -> one Postgres transaction
  -> effective nutrition views
  -> typed MCP result
```

Direct `FoodRepository.update()` and `FoodRepository.delete()` are not used by
the MCP tools. Those methods mutate or physically delete provider rows and
would violate the raw-source and reimport-survival requirements. A generic
human-record MCP tool is also rejected: domain-specific schemas provide clearer
validation and prevent arbitrary field names or units.

## Stable identity

MCP record IDs are `fitness.human_record_identity.id`, not
`fitness.food_entry.id`. The source-row UUID may change after a provider
reimport, while the human-record identity must remain stable.

Food identities use:

- `domain`: `nutrition.food`
- `namespace`: the canonical provider ID
- `source_key`: `external:<external_id>` when the provider supplies a stable
  external identity, otherwise `row:<food_entry.id>`

All ingestion paths that participate in modification must supply a stable
external identity. Dofek-created entries receive a generated external identity
before insertion. Search lazily and idempotently creates structural identities
so every returned record has one MCP record ID. Existing records without a
stable source identity use the row-key form for reading but return
`modifiable: false` with an actionable reason; the service must not pretend
that a row UUID will survive replacement.

The effective reader joins a current source row to the identity by user,
domain, provider namespace, and the prefixed external-key or row-key form. If a
provider replaces the physical row while retaining its external key, the same
human decisions apply to the new row.
PostgreSQL uniqueness constraints remain the final authority for concurrent
identity creation; see the official documentation for
[unique constraints](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-UNIQUE-CONSTRAINTS).

## Nutrient decision storage

Scalar food fields use `human_record_target.fields`. Nutrient decisions must
remain normalized and therefore use a new table instead of ledger JSON:

```text
fitness.human_food_nutrient_decision
  target_id uuid not null -> human_record_target
  nutrient_id text not null -> nutrient
  operation text not null: set | clear
  amount real nullable
  primary key (target_id, nutrient_id)
```

Constraints enforce:

- `set` may contain a non-negative amount or explicit `NULL`.
- `clear` contains no amount and means follow the current source value.
- Each target records at most one decision for a nutrient.
- The target and nutrient decision share the same user-owned history through
  the target foreign key.

An explicit `NULL` suppresses a source nutrient. It is different from `clear`,
which removes the human assertion and reveals the current source value. This
matches the parent design's null-versus-clear contract.

Human-created entries store their initial facts once in canonical
`food_entry`/`food_entry_nutrient` rows under the Dofek provider. Their ledger
`create` operation records authorship and identity without copying initial
nutrients into decision storage. Later changes use ledger decisions.

## Effective reads

Create a read-only effective food projection that combines:

1. The current raw source row and source nutrients.
2. The nearest scalar decisions from `v_human_record_field`.
3. The nearest nutrient decisions in the target predecessor chain.
4. The current visibility decision from `v_human_record_visibility`.

The projection returns stable record ID, current source-row ID, effective
fields, effective nutrients, deletion state, modification version, source
provider, per-field provenance, and whether modification is supported.

Canonical nutrition display and aggregation views must read the effective
projection before contribution-set selection. A deleted item is absent from
daily totals. A changed date or meal moves the item to its effective date/meal.
A nutrient correction participates once under the existing source-resolution
rules. Raw provider projections retain raw values for provenance.

Normal search excludes deleted records. Search accepts an explicit visibility
filter of `visible`, `deleted`, or `all`, allowing a client to find a deleted
record for restoration. Detail and history can address a deleted stable ID.

## Domain service commands

`FoodRecordService` exposes typed operations:

- `search`: exact date range, optional text query, visibility, cursor, limit.
- `get`: stable record ID, including effective data and provenance.
- `create`: validated itemized food facts and nutrients.
- `update`: expected version, scalar set/clear decisions, and nutrient
  set/clear decisions.
- `delete`: append a visibility tombstone.
- `restore`: append a visible decision while retaining field overrides.
- `history`: cursor-paginated operations and exact provenance.

Each mutation accepts a caller-generated UUID `request_id`. The service hashes
the canonical validated command and stores it in `human_record_change`.
Repeating the same request returns the original result. Reusing the request ID
with a different command returns a conflict.

Mutations also accept `expected_version`, represented by the current target ID.
The transaction locks the current head and appends exactly one successor.
Concurrent commands based on the same version cannot both succeed because the
ledger's unique predecessor constraint permits one successor. The loser
receives a version conflict and the current version to reread. This uses normal
transactional constraints rather than timestamps; PostgreSQL documents the
relevant concurrency model under
[explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html).

Create runs inside the existing account-erasure write fence. Update, delete,
and restore verify user ownership before recording any operation. The MCP
caller supplies neither `user_id`, channel, nor client identity.

## MCP contract

Add these typed tools:

| Tool | Scope | Behavior |
| --- | --- | --- |
| `search_food_entries` | `nutrition:read` | Search effective food records, with explicit deleted-record filtering. |
| `get_food_entry` | `nutrition:read` | Return one effective record, provenance, version, and allowed operations. |
| `create_food_entry` | `nutrition:read` + `nutrition:write` | Create one itemized Dofek food record. |
| `update_food_entry` | `nutrition:read` + `nutrition:write` | Append validated scalar and nutrient decisions. |
| `delete_food_entry` | `nutrition:read` + `nutrition:write` | Append a deletion tombstone. |
| `restore_food_entry` | `nutrition:read` + `nutrition:write` | Restore visibility without discarding overrides. |
| `get_food_entry_history` | `nutrition:read` | Return paginated operations and provenance. |

Mutation tools require read scope because their responses contain the effective
record and provenance. `delete_food_entry` declares `destructiveHint: true`.
Read tools declare `readOnlyHint: true`; every tool declares
`openWorldHint: false`. Tool inputs and outputs have concrete Zod schemas and
follow the MCP specification's
[tool annotations and structured content contract](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

The existing summary tool remains unchanged except that its values now come
from the effective canonical nutrition views.

## Authorization and consent

Restore `nutrition:write` to the MCP scope schema, OAuth consent labels,
manually created token controls, route tests, and documentation. Existing MCP
tokens and OAuth grants do not gain the scope. Users must explicitly authorize
or mint credentials containing both `nutrition:read` and `nutrition:write`.

The authenticated MCP token ID or OAuth client ID becomes
`human_record_change.client_id`; request input cannot override it. Logs and
errors must not include bearer tokens, raw OAuth secrets, or full food payloads.

## Validation and errors

Allowed scalar fields are date, meal, food name, description, category,
serving count, serving unit, serving weight, and supported provider-neutral
serving facts. Provider IDs, source keys, raw payloads, confirmation state, and
calculated totals are immutable through MCP.

Nutrients use canonical nutrient IDs and canonical units. Amounts must satisfy
the shared nutrition safety rules. Updating a calculated daily total is
rejected because only itemized/source observations are editable.

Failures return structured MCP errors with actionable messages:

- `NOT_FOUND`: no user-owned stable record exists.
- `PRECONDITION_FAILED`: the source lacks a stable modifiable identity.
- `CONFLICT`: expected version is stale or a request ID was reused differently.
- `INVALID_ARGUMENT`: field, nutrient, unit, or command validation failed.
- `INSUFFICIENT_SCOPE`: required read or write scope is absent.
- `ACCOUNT_ERASURE_ACTIVE`: the account write fence is active.

Unexpected errors are reported to Sentry and returned without database or
credential details.

## Cache and derived data

After commit, invalidate the existing nutrition cache for every affected date.
An update that changes the date invalidates both the old and new dates. Delete
and restore invalidate the effective date. No timeout, retry, or fallback is
added. Current nutrition summaries are Postgres view-backed, so this slice does
not introduce a separate ClickHouse write path.

## Migration and rollout

The forward migration adds nutrient decision storage and the effective
nutrition projections. It updates canonical nutrition views in dependency
order and regenerates schema diagrams. The migration contains no historical
backfill: identity creation is lazy for existing stable source records, and new
human records create their identity in the same transaction.

Deployment order is migration, server release, then client reauthorization.
Because old credentials lack `nutrition:write`, deploying the server cannot
silently expand access. Rollback may remove the MCP tools while leaving the
append-only decisions and effective views intact; committed user history is not
discarded.

## Testing

Follow test-driven development. Database behavior is verified against real
PostgreSQL rather than SQL-string assertions.

Required integration coverage:

- Stable identity survives physical source-row replacement with the same key.
- Scalar and nutrient set, explicit null, and clear semantics.
- Delete excludes an item from detail defaults and daily totals.
- Restore reveals the item while retaining overrides.
- Concurrent writes allow one successor and report one conflict.
- Identical request replay is idempotent; changed-body replay conflicts.
- Cross-user IDs and target versions cannot be read or mutated.
- Account erasure remains able to remove append-only history.
- Corrected records still obey canonical provider contribution selection.
- Date changes invalidate both affected daily summaries.

Required MCP coverage:

- Tool listing exposes exact input/output schemas and annotations.
- Read and write scopes are independently enforced.
- Existing scope sets remain unchanged until explicitly reauthorized.
- Search/detail/history include deleted and provenance behavior as specified.
- Every mutation maps authenticated client identity and never accepts actor
  identity from input.
- Domain validation and concurrency failures return actionable structured
  errors.

Run focused tests first, followed by schema validation, migration policy,
typecheck, lint, Docker-free unit/mobile tests, and the relevant PostgreSQL
integration suite.

## Acceptance scenarios

1. An MCP client searches today's food, reads a stable ID, corrects protein,
   and sees the corrected nutrient in detail and the daily summary.
2. The provider refreshes the source row under the same external key; the
   correction remains and unchanged fields follow the refreshed source.
3. The client deletes the entry; normal search and totals omit it. Deleted
   search and history still find it.
4. The client restores it; visibility returns and the protein correction is
   retained.
5. Two clients update the same version; one succeeds and one receives a clear
   conflict without losing history.
6. A client retries after losing a response; the request ID returns the same
   committed operation without creating another target.
