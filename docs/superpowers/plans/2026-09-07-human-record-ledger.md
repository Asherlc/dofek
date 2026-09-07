# Human Record Ledger Implementation Plan

**Goal:** Build the durable shared identity and append-only decision storage used
by the universal health-record modification system.

**Architecture:** Stable source identities own linear target histories. A human
command atomically targets one or more identities. Read-only SQL projections
resolve the latest field decisions and visibility without storing provider
snapshots or a second mutable current-state record.

**Tech stack:** Existing TypeScript, Drizzle, PostgreSQL, Zod, and Vitest.

**Spec:** [Human modifications design](../specs/2026-09-07-human-record-modifications-design.md).

## Global constraints

- Provider-owned records are unchanged by human commands.
- Store human input once; nutrient amounts remain in canonical nutrient tables.
- Explicit null and clearing an override are different decisions.
- Target history order comes from predecessors, never wall-clock timestamps.
- User ownership is enforced in relational constraints as well as services.
- Account-erasure fences and physical erasure must cover all new storage.
- No runtime APIs or capabilities claim support before their canonical readers
  and analytics are integrated.
- Run failing real-database tests before adding the schema and projections.
- Use the existing worktree and branch. Do not perform production migrations.

## Delivery map

This is the first independently testable subsystem, not the entire feature.
The full delivery still requires command services and canonical nutrient-row
ownership, food/supplement integration, workout identity/grouping and legacy
deletion cutover, remaining health domains, CDC/analytics delivery, and shared
UI/MCP transport integration. The design's acceptance scenarios remain the
cross-domain completion gate. Subsequent subsystem plans must consume the
contracts below and include their own executable fixtures and review checkpoints.

## Task 1: Stable identities and append-only multi-target decisions

**Files:**

- Create `src/db/schema/record-modifications.ts`.
- Create `drizzle/0110_human_record_ledger.sql`.
- Modify `src/db/drizzle-schema.ts` and `drizzle/meta/_journal.json`.
- Create `src/db/record-modifications.integration.test.ts`.
- Modify `src/account-erasure/postgres-erasure.ts` only if the existing generic
  erasure path cannot delete the new immutable records correctly.

**Storage interface:**

```text
fitness.human_record_identity
  id uuid primary key
  user_id uuid not null -> user_profile
  domain text not null
  namespace text not null
  source_key text not null
  unique(user_id, domain, namespace, source_key)
  unique(id, user_id)

fitness.human_record_change
  id uuid primary key
  user_id uuid not null -> user_profile
  request_id uuid not null
  request_hash text not null (64 lowercase hexadecimal characters)
  kind text not null: create/update/clear/delete/restore/undo/legacy_delete
  channel text not null: web/mobile/mcp/migration
  client_id text nullable (required for mcp; no caller-supplied actor identity)
  recorded_at timestamptz not null
  effective_at timestamptz nullable
  schema_version integer not null, positive
  undo_change_id uuid nullable (same-user FK to human_record_change)
  unique(user_id, request_id)
  unique(id, user_id)

fitness.human_record_target
  id uuid primary key
  user_id uuid not null
  identity_id uuid not null (same-user FK to identity)
  change_id uuid not null (same-user FK to change)
  predecessor_id uuid nullable (same-user, same-identity FK to target)
  fields jsonb not null default '{}' (only scalar non-nutrient decisions)
  deleted boolean nullable (null = this command leaves visibility unchanged)
  unique(identity_id, change_id)
  unique(identity_id, predecessor_id) NULLS NOT DISTINCT
  unique(id, identity_id, user_id)
```

The JSON field contract is a map of domain field names to exactly one of:

```json
{"operation":"set","value":null}
```

```json
{"operation":"set","value":"Corrected name"}
```

```json
{"operation":"clear"}
```

Set accepts a JSON scalar (string, boolean, finite number, or null); nested
objects/arrays and unknown operation shapes are invalid. Nutrients are not
encoded here; their amounts will have revision ownership in the existing
nutrient tables. Add a database JSON validation function so malformed stored
decisions fail even when bypassing TypeScript. The later domain service owns
the per-domain allowlist and units; this storage is not an arbitrary-field API.

- [ ] Write an integration fixture with two users and provider-independent
  identities. Insert a command and target using the concrete columns above.
  Assert actual constraint failures for cross-user targets/predecessors/undo,
  two first heads, branching successors, duplicate request IDs, self-predecessors,
  empty identity parts, unsupported channels/kinds, and malformed field JSON.
  Use separate transactions for expected SQL errors so one failure does not
  poison subsequent assertions.

```ts
await expect(database.execute(sql`
  INSERT INTO fitness.human_record_target
    (user_id, identity_id, change_id, fields)
  VALUES (${otherUserId}::uuid, ${identityId}::uuid,
          ${otherChangeId}::uuid, '{}'::jsonb)
`)).rejects.toThrow();
```

- [ ] Run `pnpm test:integration -- src/db/record-modifications.integration.test.ts`.
  Confirm the initial failure is the missing ledger schema.
- [ ] Implement the Drizzle schema and schema-only migration. Add UPDATE/DELETE
  guards to preserve append-only decisions while permitting verified account
  erasure. Reuse existing erasure trigger installation and coverage checks;
  do not permit deletion merely because an arbitrary session flag is present.
- [ ] Add tests that ordinary UPDATE/DELETE is rejected, foreign provider-row
  deletion cannot cascade into the ledger, source UUID replacement preserves
  the identity, and the real account-erasure path removes the user's history
  without touching the other user.
- [ ] Run the focused integration suite and root/server/web typechecks. Run
  migration policy and schema-diagram generation. Apply the migration only to
  this workspace's local database through the documented migration command.
- [ ] Review this task against the storage interface and erasure invariants;
  record findings and fixes before committing and pushing.

## Task 2: Canonical field and visibility projections

**Files:**

- Create `drizzle/0111_human_record_projections.sql` and register it in
  `drizzle/meta/_journal.json`; never rewrite the already-applied ledger migration.
- Extend `src/db/record-modifications.integration.test.ts`.

**Read interface:**

```text
fitness.v_human_record_head
  user_id, identity_id, target_id, change_id
fitness.v_human_record_field
  user_id, identity_id, field, operation, value, target_id, change_id
fitness.v_human_record_visibility
  user_id, identity_id, deleted, target_id, change_id
```

Head returns only identities with a decision. Field returns each field's nearest
decision in the predecessor chain, including `clear` rows. A set-to-null value
remains JSON null. Visibility returns the nearest non-null visibility decision;
no row means no human visibility assertion. Each projection preserves provenance
to the exact target/change. These are read-only views, not stored snapshots.

- [ ] Add a history with three decisions: set name and notes, then explicit
  null for name, then clear notes. Give recorded timestamps a deliberately
  reversed order. Query the projection and assert these literal results:

```ts
expect(fields).toEqual([
  { field: 'name', operation: 'set', value: null },
  { field: 'notes', operation: 'clear', value: null },
]);
```

- [ ] Run the focused integration suite and observe missing-projection failure.
- [ ] Implement recursive head-to-predecessor resolution with nearest-field
  selection. Never use `max(recorded_at)` or a global sequence as record order.
- [ ] Test deletion followed by an ordinary edit remains deleted, restore
  retains field overrides, and a later delete wins even with an earlier clock.
  A multi-target command must resolve independently for each identity, without
  joining target histories into one mutable group.
- [ ] Query the actual views for two users and verify provenance and isolation.
  Repeat the focused integration suite, migration policy, lint, and typechecks.
- [ ] Review the complete subsystem diff and test evidence. Record the completed
  contracts and remaining integration work before committing and pushing.

## Verification and retrospective

The pass criterion is executable PostgreSQL evidence, not SQL-string assertions.
This subsystem does not yet expose mutation tools, migrate activity deletion,
or make effective domain reads consume the ledger. Keep the PR draft until the
full design's integration gates are satisfied. The testing runbook should gain
a verified network-address-pool recovery note after local recovery succeeds.

PostgreSQL references: [constraints](https://www.postgresql.org/docs/current/ddl-constraints.html),
[recursive queries](https://www.postgresql.org/docs/current/queries-with.html),
[triggers](https://www.postgresql.org/docs/current/triggers.html).
