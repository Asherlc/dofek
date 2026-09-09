# Stable Activity Groups and Representative-Independent Hydration

## Problem

An activity group currently has no identity of its own. PostgreSQL and ClickHouse both discover overlap groups at read-model refresh time, then expose the selected representative member's UUID as the group's public ID. Changing the representative therefore changes the public ID.

Activity hydration also depends on that selected member. The server selects one compatible ClickHouse summary instead of hydrating the whole group, and structured repositories can be called with an unresolved member ID. A representative change can consequently hide heart-rate data, exercise sets, location, or a more specific activity classification without deleting any source data.

The uploaded Strong CSV establishes a separate diagnostic fact: its September 3 machine rows contain `Weight=140` and `Reps=11/8/7`, and the current Strong parser maps those columns correctly. The WHOOP weightlifting parser also maps its source fields correctly. No importer-side weight/repetition swap will be added without a failing reproduction of the actual corrupting path.

## Goals

- Give each logical activity group a persisted identity that is independent of its representative.
- Preserve identity when representatives or ordinary membership change.
- Make member-ID and historical-group-ID resolution explicit with `resolved_from`.
- Rank representatives by payload, classification specificity, provider refinement, and only then provider priority.
- Hydrate every payload family from all group members, with deterministic source-aware deduplication.
- Preserve the current Strong unit conversion, sequential set indexes, typed rest sets, cross-provider merging, and timezone behavior.
- Diagnose and fix the actual machine-set corruption path rather than introduce value-shape heuristics.
- Enrich verified exercise-name aliases and report unresolved catalogue misses.

## Non-goals

- Deleting or coalescing raw provider records during ingestion.
- Writing sensor-derived facts from ClickHouse back into PostgreSQL application state.
- Treating provider priority as a proxy for data completeness.
- Guessing that large repetition values and small weights should be swapped.
- Building a general entity-resolution system outside activity grouping.

## Considered approaches

### Deterministic group hashes

A hash of sorted member external IDs avoids representative-dependent identity, but the hash changes whenever a late provider joins, a provider record is tombstoned, or a group splits. It converts representative churn into membership churn and does not satisfy durable identity.

### Persist only `group_id` on activity rows

This is simpler and makes current membership explicit, but it lacks a first-class group lifecycle, referential integrity, and a durable target for aliases after groups merge. It also makes it easy to create orphan or reused group IDs.

### Persisted group entity, activity membership, and aliases

This is the selected design. A group is a first-class structural entity; raw provider activities remain intact and point to it. Historical identities redirect through an alias table. PostgreSQL foreign keys enforce valid membership, while transactions and per-user locking make reconciliation atomic. PostgreSQL documents primary/foreign-key constraints as the mechanism for enforcing referential integrity and transaction-level advisory locks as application-defined serialization primitives: [constraints](https://www.postgresql.org/docs/current/ddl-constraints.html), [explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html).

## Data model

Add three structural pieces:

- `fitness.activity_group`
  - `id uuid primary key`
  - `user_id uuid not null`
  - `anchor_activity_id uuid null`
  - `created_at timestamptz not null`
- `fitness.activity.group_id uuid not null`
  - foreign key to `activity_group.id`
  - indexed with `user_id`
- `fitness.activity_group_alias`
  - `alias_id uuid primary key`
  - `group_id uuid not null`
  - `reason text not null`
  - `created_at timestamptz not null`

`activity.group_id` is the single canonical membership location. `activity_group` represents identity and lifecycle; it does not duplicate membership. Aliases represent prior public identities only.

New activities start in a singleton group in the same database transaction. A database-level insertion function/trigger supplies the invariant for every writer, including direct SQL and future providers; application code must not be able to commit an activity without a valid group.

The migration backfills each currently visible overlap component with its current public activity ID. This prevents the migration itself from changing existing bookmarks. Every member receives that group ID before the column becomes non-null and the foreign key is validated.

## Reconciliation and identity rules

The overlap algorithm remains query-time derivation over raw activity timing and type evidence, but its result updates structural membership before the activity canonical-commit watermark is recorded. Reconciliation runs under a transaction-scoped advisory lock keyed by user, so concurrent provider syncs cannot make conflicting membership decisions.

Identity follows these rules:

1. A component containing one existing group retains that group ID.
2. When a new member joins a component, the existing group ID remains.
3. When existing groups merge, the oldest group wins, with UUID as deterministic tie-breaker. Every losing group ID becomes an alias to the winner before membership changes commit.
4. If a component splits, the component containing the group's anchor retains the ID. Each other component gets a new group. This is the unavoidable case where one former aggregate becomes multiple real sessions.
5. Tombstoning does not delete membership or group identity. A restored member rejoins its prior group unless current overlap evidence requires an explicit reconciliation change.

The canonical commit is published only after reconciliation succeeds. Missing reconciliation is a hard failure, not a warn-and-continue path.

## Canonical read models

`fitness.v_activity` groups active raw rows by persisted `group_id`; it no longer calculates identity from the representative. Its public `id` is the group ID, while `primary_activity_id` is the selected representative member ID.

ClickHouse receives `activity.group_id` through the existing activity CDC stream. `deduped_activities` groups by that value and emits it as `activity_id`. `deduped_activity_members`, sensor samples, location samples, summaries, cycling models, and downstream activity analytics consequently retain their keys when the representative changes.

Sensor evidence stays in ClickHouse. It is not copied into PostgreSQL. PostgreSQL can rank relational structured payload such as strength sets; ClickHouse can rank sensor payload. Both follow the same lexicographic rank contract and deterministic tie-breaker.

## Representative rank contract

Representative selection uses a lexicographic tuple, highest quality first:

1. Payload richness for the group domain:
   - strength: structured exercise/set completeness;
   - all activities: deduplicated sensor presence and sample count;
   - location-bearing activities: usable GPS/elevation evidence.
2. Specific canonical type: `cycling`, `running`, `strength`, `walking`, and `climbing` outrank generic `cardio` and `other`.
3. Non-empty provider type refinement.
4. Configured provider/device priority.
5. Member UUID as deterministic tie-breaker.

The ranker is a pure domain function with permutation/property tests. SQL projections implement the same tuple where their source data lives. Payload fields themselves are never selected from the representative.

## Representative-independent hydration

ID resolution first resolves, in order:

1. a stable `activity_group.id`;
2. an `activity.id` member to its current group;
3. an `activity_group_alias.alias_id` to its target group.

When the requested ID differs from the returned group ID, responses include `resolved_from`. This applies to tRPC/domain details and MCP's snake-case schema.

Hydration is organized by payload family:

- Scalar sensor metrics come from the group-keyed ClickHouse summary built over deduplicated samples in the complete group window.
- Time-series streams use the same stable group identity and deduplicated sensor source.
- GPS and elevation use every member mapping, then retain the existing best-source/deduplication semantics.
- Strength, climbing, and finger-loading repositories are called with the resolved group ID and join all current members.
- Display name, provider label, and display classification come from the representative ranker.
- Type refinements are retained from the best classified member even when another member supplies a different payload family.

The server must not filter summaries to those compatible with the current PostgreSQL representative. That compatibility selection is the direct mechanism that currently discards WHOOP cycling heart rate after Peloton becomes representative.

## Strength union semantics

The existing strength repository groups rows only by `exercise_index`. Indexes are provider-local, so member activities with the same numeric index can be collapsed incorrectly.

Hydration will retain `member_activity_id` while reading sets, group exercises by normalized exercise name plus equipment, and deduplicate exact equivalent sets by a deterministic signature containing set type, set index, weight, repetitions, and duration. When equivalent rows conflict only in completeness, the more complete row wins; representative/provider priority is only the final tie-breaker. Disjoint exercises and sets remain visible.

This makes the returned populated field set invariant under representative choice while preventing duplicate mirrors from inflating training volume.

## Strong machine-set investigation

The uploaded source rows and both current parsers are correct, so a blind importer transformation would corrupt legitimate high-repetition or light-weight exercises. Implementation must first produce a failing executable test at the layer where the swap occurs.

The investigation will preserve source-member provenance through the strength query, compare stored sets by provider/member, and reproduce grouped hydration with multiple strength-bearing members. If current code cannot reproduce the swap, the change will consist of the independently proven hydration fix plus a pinned current-parser regression fixture, and production remediation will be an explicit Strong re-import rather than speculative steady-state code.

## Exercise metadata

Metadata lookup already normalizes case and whitespace. `Leg Extension` is an absent exact catalogue name, not a casing or trailing-space failure. The uploaded file has 18 exact-name misses, primarily aliases for catalogue entries.

Add only aliases whose target identity and muscle metadata can be verified in the bundled catalogue. Keep truly absent or ambiguous names unresolved and report them. Tests cover the uploaded exercise-name inventory through the public metadata lookup.

## Failure behavior and observability

- Reconciliation failures are reported to Sentry and fail the canonical commit.
- Alias cycles are prevented by resolving aliases to a current group before insertion and by foreign-key constraints.
- Resolution logs requested ID, resolved group ID, and resolution kind without logging health payloads.
- Group merge/split events record member counts and IDs for diagnosis.
- APIs return an actionable not-found error when no group, member, or alias matches.

## Verification

### Unit

- Representative tuple ordering for payload-bearing versus metadata-only members.
- Specific versus generic canonical types.
- Provider-type refinement and priority tie-breaks.
- Representative permutation/property tests.
- Source-aware strength exercise/set union.
- Exact Strong machine-row parsing.
- Exercise metadata alias coverage and unresolved-name report.

### PostgreSQL integration

- Backfill creates stable groups without changing current public IDs.
- Reconciliation preserves group ID across representative changes and member additions.
- Merge aliases resolve to the retained group.
- `v_activity` returns specific type/refinement and relational payload-bearing representative.
- Structured repositories hydrate all group members from either group or member lookup.

### ClickHouse integration

- Sensor-bearing members outrank metadata-only mirrors.
- Group-keyed summaries union disjoint channels and retain heart rate after representative changes.
- Location and elevation remain visible through stable membership.

### End-to-end

- Re-fetch a previously returned ID after re-evaluation and receive the same group ID.
- Fetch by a member or merged historical group ID and receive `resolved_from`.
- September 3 returns the five expected deadlift working sets plus typed rest entries regardless of representative.
- September 1 returns non-empty strength exercises.
- Both commutes remain `cycling`, retain commute evidence, and have non-null heart rate.

## Rollout

1. Deploy PostgreSQL schema/backfill and the rewritten canonical view together.
2. Deploy ClickHouse model changes and rebuild affected activity read models in dependency order.
3. Deploy server resolution/hydration and response-schema changes.
4. Run targeted activity refresh for affected IDs and verify stable identity and payload invariants.
5. Re-import the supplied Strong CSV only if stored source rows are confirmed corrupt after code deployment.

The rollout remains fail-fast: no compatibility fallback silently substitutes representative IDs or reads raw, non-deduplicated sensor streams.
