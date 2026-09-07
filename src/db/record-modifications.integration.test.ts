import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { erasePostgresAccount } from "../account-erasure/postgres-erasure.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { executeWithSchema } from "./typed-sql.ts";

let ctx: TestContext;
let userId: string;
let otherUserId: string;
const hash = "a".repeat(64);
const idRowSchema = z.object({ id: z.uuid() });
const settingRowSchema = z.object({ set_config: z.string() });
const provenanceSchema = z.object({ target_id: z.uuid(), change_id: z.uuid() });
const headRowSchema = provenanceSchema.extend({ user_id: z.uuid(), identity_id: z.uuid() });
const fieldRowSchema = z.object({
  field: z.string(),
  operation: z.enum(["set", "clear"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});
const visibilityRowSchema = z.object({ deleted: z.boolean() });

async function identity(owner = userId, sourceKey = randomUUID()) {
  const id = randomUUID();
  await ctx.db.execute(sql`INSERT INTO fitness.human_record_identity
    (id, user_id, domain, namespace, source_key)
    VALUES (${id}, ${owner}, 'food', 'provider:test', ${sourceKey})`);
  return id;
}

async function change(owner = userId, requestId = randomUUID()) {
  const id = randomUUID();
  await ctx.db.execute(sql`INSERT INTO fitness.human_record_change
    (id, user_id, request_id, request_hash, kind, channel, schema_version)
    VALUES (${id}, ${owner}, ${requestId}, ${hash}, 'update', 'web', 1)`);
  return id;
}

async function changeAt(recordedAt: string, owner = userId, kind = "update") {
  const id = randomUUID();
  await ctx.db.execute(sql`INSERT INTO fitness.human_record_change
    (id, user_id, request_id, request_hash, kind, channel, recorded_at, schema_version)
    VALUES (${id}, ${owner}, ${randomUUID()}, ${hash}, ${kind}, 'web', ${recordedAt}, 1)`);
  return id;
}

async function target(
  identityId: string,
  changeId: string,
  predecessorId: string | null = null,
  owner = userId,
  fields: unknown = {},
  id = randomUUID(),
) {
  await ctx.db.execute(sql`INSERT INTO fitness.human_record_target
    (id, user_id, identity_id, change_id, predecessor_id, fields)
    VALUES (${id}, ${owner}, ${identityId}, ${changeId}, ${predecessorId}, ${JSON.stringify(fields)}::jsonb)`);
  return id;
}

beforeAll(async () => {
  ctx = await setupTestDatabase();
}, 120_000);
beforeEach(async () => {
  userId = randomUUID();
  otherUserId = randomUUID();
  await ctx.db.execute(sql`INSERT INTO fitness.user_profile (id, name)
    VALUES (${userId}, 'Ledger owner'), (${otherUserId}, 'Other ledger owner')`);
});
afterAll(async () => {
  await ctx?.cleanup();
});

describe("human record ledger constraints", () => {
  it("rejects a cycle formed by two targets inserted together", async () => {
    const record = await identity();
    const first = randomUUID();
    const second = randomUUID();
    const firstChange = await change();
    const secondChange = await change();
    await expect(
      ctx.db.execute(sql`INSERT INTO fitness.human_record_target
      (id, user_id, identity_id, change_id, predecessor_id)
      VALUES (${first}, ${userId}, ${record}, ${firstChange}, ${second}),
        (${second}, ${userId}, ${record}, ${secondChange}, ${first})`),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });
  it("stores scalar decisions, multi-target commands, and one linear chain per identity", async () => {
    const first = await identity();
    const second = await identity();
    const command = await change();
    const head = await target(first, command, null, userId, {
      name: { operation: "set", value: "Corrected" },
      note: { operation: "set", value: null },
      amount: { operation: "set", value: 2.5 },
      enabled: { operation: "set", value: false },
      meal: { operation: "clear" },
    });
    await target(second, command);
    await expect(target(first, await change())).rejects.toMatchObject({ cause: { code: "23505" } });
    const successor = await change();
    const nextHead = await target(first, successor, head);
    await expect(target(first, await change(), head)).rejects.toMatchObject({
      cause: { code: "23505" },
    });
    await expect(target(first, successor, nextHead)).rejects.toMatchObject({
      cause: { code: "23505", constraint: "human_record_target_change_key" },
    });
  });

  it("requires an undo target exactly for undo commands", async () => {
    const original = await change();
    for (const kind of [
      "create",
      "update",
      "clear",
      "delete",
      "restore",
      "legacy_delete",
      "undo",
    ]) {
      const undoTarget = kind === "undo" ? null : original;
      await expect(
        ctx.db.execute(sql`INSERT INTO fitness.human_record_change
          (user_id, request_id, request_hash, kind, channel, schema_version, undo_change_id)
          VALUES (${userId}, ${randomUUID()}, ${hash}, ${kind}, 'web', 1, ${undoTarget})`),
      ).rejects.toMatchObject({
        cause: { code: "23514", constraint: "human_record_change_undo_kind_valid" },
      });
      await ctx.db.execute(sql`INSERT INTO fitness.human_record_change
        (user_id, request_id, request_hash, kind, channel, schema_version, undo_change_id)
        VALUES (${userId}, ${randomUUID()}, ${hash}, ${kind}, 'web', 1, ${kind === "undo" ? original : null})`);
    }
  });

  it("rejects cross-owner identity, command, predecessor, and undo references", async () => {
    const first = await identity();
    const other = await identity(otherUserId);
    const otherCommand = await change(otherUserId);
    const otherHead = await target(other, otherCommand, null, otherUserId);
    await expect(target(first, otherCommand, null, otherUserId)).rejects.toMatchObject({
      cause: { code: "23503" },
    });
    await expect(target(first, otherCommand)).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(target(first, await change(), otherHead)).rejects.toMatchObject({
      cause: { code: "23503" },
    });
    await expect(
      ctx.db.execute(sql`INSERT INTO fitness.human_record_change
      (user_id, request_id, request_hash, kind, channel, schema_version, undo_change_id)
      VALUES (${userId}, ${randomUUID()}, ${hash}, 'undo', 'web', 1, ${otherCommand})`),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
    const sameOwnerOtherHead = await target(await identity(), await change());
    await expect(target(first, await change(), sameOwnerOtherHead)).rejects.toMatchObject({
      cause: { code: "23503" },
    });
  });

  it("rejects self-predecessors and duplicate request IDs", async () => {
    const id = randomUUID();
    await expect(
      target(await identity(), await change(), id, userId, {}, id),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    const request = randomUUID();
    await change(userId, request);
    await expect(change(userId, request)).rejects.toMatchObject({ cause: { code: "23505" } });
    await change(otherUserId, request);
  });

  it("rejects empty identity parts and duplicate stable identities", async () => {
    for (const parts of [
      ["", "provider:test", "source"],
      ["food", " ", "source"],
      ["food", "provider:test", ""],
    ]) {
      await expect(
        ctx.db.execute(sql`INSERT INTO fitness.human_record_identity
        (user_id, domain, namespace, source_key) VALUES (${userId}, ${parts[0]}, ${parts[1]}, ${parts[2]})`),
      ).rejects.toMatchObject({ cause: { code: "23514" } });
    }
    const key = randomUUID();
    await identity(userId, key);
    await expect(identity(userId, key)).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("validates command kind, channel, hash, version and MCP attribution", async () => {
    for (const values of [
      { kind: "bad", channel: "web", hash, version: 1, client: null },
      { kind: "update", channel: "bad", hash, version: 1, client: null },
      { kind: "update", channel: "mcp", hash, version: 1, client: null },
      { kind: "update", channel: "mcp", hash, version: 1, client: " " },
      { kind: "update", channel: "web", hash: "A".repeat(64), version: 1, client: null },
      { kind: "update", channel: "web", hash, version: 0, client: null },
    ]) {
      await expect(
        ctx.db.execute(sql`INSERT INTO fitness.human_record_change
        (user_id, request_id, request_hash, kind, channel, schema_version, client_id)
        VALUES (${userId}, ${randomUUID()}, ${values.hash}, ${values.kind}, ${values.channel}, ${values.version}, ${values.client})`),
      ).rejects.toMatchObject({ cause: { code: "23514" } });
    }
  });

  it("rejects malformed stored decisions", async () => {
    const record = await identity();
    for (const fields of [
      null,
      [],
      "bad",
      { name: null },
      { name: { operation: "set" } },
      { name: { operation: "set", value: [] } },
      { name: { operation: "set", value: {} } },
      { name: { operation: "clear", value: null } },
      { name: { operation: "unknown" } },
      { name: { operation: "clear", extra: true } },
      { name: { operation: "set", value: 1, extra: true } },
    ]) {
      await expect(target(record, await change(), null, userId, fields)).rejects.toMatchObject({
        cause: { code: "23514" },
      });
    }
  });

  it("rejects mutations even with an unverified erasure flag", async () => {
    const record = await identity();
    const command = await change();
    const revision = await target(record, command);
    for (const [table, id] of [
      ["human_record_identity", record],
      ["human_record_change", command],
      ["human_record_target", revision],
    ] as const) {
      await expect(
        ctx.db.execute(
          sql`UPDATE fitness.${sql.identifier(table)} SET user_id = user_id WHERE id = ${id}`,
        ),
      ).rejects.toMatchObject({ cause: { code: "55000" } });
      await expect(
        ctx.db.execute(sql`DELETE FROM fitness.${sql.identifier(table)} WHERE id = ${id}`),
      ).rejects.toMatchObject({ cause: { code: "55000" } });
      await expect(
        ctx.db.transaction(async (tx) => {
          await executeWithSchema(
            tx,
            settingRowSchema,
            sql`SELECT set_config('dofek.account_erasure_request_id', ${randomUUID()}, true)`,
          );
          await tx.execute(sql`DELETE FROM fitness.${sql.identifier(table)} WHERE id = ${id}`);
        }),
      ).rejects.toMatchObject({ cause: { code: "55000" } });
    }
  });

  it("keeps identity and decisions across provider row deletion and UUID replacement", async () => {
    const provider = `ledger-${randomUUID()}`;
    const externalId = randomUUID();
    await ctx.db.execute(
      sql`INSERT INTO fitness.provider (id, name) VALUES (${provider}, 'Ledger fixture')`,
    );
    await ctx.db.execute(sql`INSERT INTO fitness.food_entry (user_id, provider_id, external_id, date, food_name)
      VALUES (${userId}, ${provider}, ${externalId}, '2026-09-07', 'Original')`);
    const record = await identity(userId, externalId);
    await target(record, await change());
    await ctx.db.execute(sql`DELETE FROM fitness.food_entry WHERE provider_id = ${provider}`);
    await ctx.db.execute(sql`INSERT INTO fitness.food_entry (user_id, provider_id, external_id, date, food_name)
      VALUES (${userId}, ${provider}, ${externalId}, '2026-09-07', 'Imported again')`);
    await ctx.db.execute(sql`DELETE FROM fitness.food_entry WHERE provider_id = ${provider}`);
    await ctx.db.execute(sql`DELETE FROM fitness.provider WHERE id = ${provider}`);
    const rows = await executeWithSchema(
      ctx.db,
      idRowSchema,
      sql`SELECT id FROM fitness.human_record_identity WHERE id = ${record}`,
    );
    expect(rows).toHaveLength(1);
    expect(
      await executeWithSchema(
        ctx.db,
        idRowSchema,
        sql`SELECT id FROM fitness.human_record_target WHERE identity_id = ${record}`,
      ),
    ).toHaveLength(1);
  });

  it("erases only the verified user's complete history through the real erasure path", async () => {
    const record = await identity();
    const command = await change();
    const head = await target(record, command);
    const undo = randomUUID();
    await ctx.db.execute(sql`INSERT INTO fitness.human_record_change
      (id, user_id, request_id, request_hash, kind, channel, schema_version, undo_change_id)
      VALUES (${undo}, ${userId}, ${randomUUID()}, ${hash}, 'undo', 'mobile', 1, ${command})`);
    await target(record, undo, head);
    await target(await identity(otherUserId), await change(otherUserId), null, otherUserId);
    const request = randomUUID();
    await ctx.db.execute(sql`INSERT INTO fitness.account_erasure_request
      (id, user_id, user_hash, user_hash_key_id, write_fence_hash, status_token_hash, replay_retained_until, completion_deadline)
      VALUES (${request}, ${userId}, ${hash}, 'test', ${randomUUID()}, ${randomUUID()}, now(), now())`);
    await expect(
      ctx.db.transaction(async (tx) => {
        await executeWithSchema(
          tx,
          settingRowSchema,
          sql`SELECT set_config('dofek.account_erasure_request_id', ${request}, true)`,
        );
        await tx.execute(
          sql`DELETE FROM fitness.human_record_target WHERE user_id = ${otherUserId}`,
        );
      }),
    ).rejects.toMatchObject({ cause: { code: "55000" } });
    await expect(
      ctx.db.transaction(async (tx) => {
        await executeWithSchema(
          tx,
          settingRowSchema,
          sql`SELECT set_config('dofek.account_erasure_request_id', ${request}, true)`,
        );
        await tx.execute(
          sql`UPDATE fitness.human_record_target SET fields = '{}' WHERE user_id = ${userId}`,
        );
      }),
    ).rejects.toMatchObject({ cause: { code: "55000" } });
    const otherBefore = await executeWithSchema(
      ctx.db,
      idRowSchema,
      sql`SELECT id FROM fitness.human_record_target WHERE user_id = ${otherUserId}`,
    );
    await erasePostgresAccount(ctx.db, request, userId);
    for (const table of ["human_record_target", "human_record_change", "human_record_identity"]) {
      expect(
        await executeWithSchema(
          ctx.db,
          idRowSchema,
          sql`SELECT id FROM fitness.${sql.identifier(table)} WHERE user_id = ${userId}`,
        ),
      ).toHaveLength(0);
    }
    expect(
      await executeWithSchema(
        ctx.db,
        idRowSchema,
        sql`SELECT id FROM fitness.human_record_target WHERE user_id = ${otherUserId}`,
      ),
    ).toEqual(otherBefore);
  });
});

describe("human record ledger projections", () => {
  it("projects only valid heads when replication has inserted a disconnected cycle", async () => {
    const record = await identity();
    const validChange = await change();
    const validHead = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    const firstChange = await change();
    const secondChange = await change();
    await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`INSERT INTO fitness.human_record_target
        (id, user_id, identity_id, change_id, predecessor_id, fields, deleted)
        VALUES
          (${validHead}, ${userId}, ${record}, ${validChange}, NULL,
            '{"name":{"operation":"set","value":"Valid"}}', false),
          (${first}, ${userId}, ${record}, ${firstChange}, ${second},
            '{"name":{"operation":"set","value":"Cycle"}}', true),
          (${second}, ${userId}, ${record}, ${secondChange}, ${first}, '{}', NULL)`);
    });
    await expect(
      ctx.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role = replica`);
        await tx.execute(sql`INSERT INTO fitness.human_record_target
          (user_id, identity_id, change_id, predecessor_id)
          VALUES (${userId}, ${record}, ${await change()}, ${first})`);
      }),
    ).rejects.toMatchObject({
      cause: { code: "23505", constraint: "human_record_target_successor_key" },
    });
    const heads = await executeWithSchema(
      ctx.db,
      headRowSchema,
      sql`SELECT user_id, identity_id, target_id, change_id
        FROM fitness.v_human_record_head WHERE identity_id = ${record}`,
    );
    expect(heads).toEqual([
      { user_id: userId, identity_id: record, target_id: validHead, change_id: validChange },
    ]);
    const fields = await executeWithSchema(
      ctx.db,
      fieldRowSchema,
      sql`SELECT field, operation, value FROM fitness.v_human_record_field
        WHERE identity_id = ${record}`,
    );
    expect(fields).toEqual([{ field: "name", operation: "set", value: "Valid" }]);
    const visibility = await executeWithSchema(
      ctx.db,
      visibilityRowSchema,
      sql`SELECT deleted FROM fitness.v_human_record_visibility WHERE identity_id = ${record}`,
    );
    expect(visibility).toEqual([{ deleted: false }]);
  });

  it("rejects writes through the head projection", async () => {
    const record = await identity();
    const command = await change();
    await expect(
      ctx.db.execute(sql`INSERT INTO fitness.v_human_record_head
        (user_id, identity_id, target_id, change_id)
        VALUES (${userId}, ${record}, ${randomUUID()}, ${command})`),
    ).rejects.toMatchObject({ cause: { code: "55000" } });
  });

  it("projects the nearest field decisions by predecessor order, including null sets and clears", async () => {
    const record = await identity();
    const firstChange = await changeAt("2026-09-07T03:00:00Z");
    const first = await target(record, firstChange, null, userId, {
      name: { operation: "set", value: "Original" },
      notes: { operation: "set", value: "Remember this" },
    });
    const secondChange = await changeAt("2026-09-07T02:00:00Z");
    const second = await target(record, secondChange, first, userId, {
      name: { operation: "set", value: null },
    });
    const thirdChange = await changeAt("2026-09-07T01:00:00Z");
    const third = await target(record, thirdChange, second, userId, {
      notes: { operation: "clear" },
    });

    const heads = await executeWithSchema(
      ctx.db,
      headRowSchema,
      sql`SELECT user_id, identity_id, target_id, change_id
      FROM fitness.v_human_record_head WHERE identity_id = ${record}`,
    );
    expect(heads).toEqual([
      { user_id: userId, identity_id: record, target_id: third, change_id: thirdChange },
    ]);
    const fields = await executeWithSchema(
      ctx.db,
      fieldRowSchema,
      sql`SELECT field, operation, value
      FROM fitness.v_human_record_field WHERE identity_id = ${record} ORDER BY field`,
    );
    expect(fields).toEqual([
      { field: "name", operation: "set", value: null },
      { field: "notes", operation: "clear", value: null },
    ]);
    expect(
      await executeWithSchema(
        ctx.db,
        visibilityRowSchema,
        sql`SELECT deleted FROM fitness.v_human_record_visibility
      WHERE identity_id = ${record}`,
      ),
    ).toEqual([]);
  });

  it("inherits visibility independently from ordinary edits, restores, and misleading clocks", async () => {
    const record = await identity();
    const createdChange = await changeAt("2026-09-07T05:00:00Z");
    const created = await target(record, createdChange, null, userId, {
      name: { operation: "set", value: "Kept" },
    });
    const deletedChange = await changeAt("2026-09-07T04:00:00Z", userId, "delete");
    const deleted = randomUUID();
    await ctx.db.execute(sql`INSERT INTO fitness.human_record_target
      (id, user_id, identity_id, change_id, predecessor_id, deleted)
      VALUES (${deleted}, ${userId}, ${record}, ${deletedChange}, ${created}, true)`);
    const editChange = await changeAt("2026-09-07T03:00:00Z");
    const edit = randomUUID();
    await ctx.db.execute(sql`INSERT INTO fitness.human_record_target
      (id, user_id, identity_id, change_id, predecessor_id, fields)
      VALUES (${edit}, ${userId}, ${record}, ${editChange}, ${deleted},
        '{"notes":{"operation":"set","value":"Still kept"}}')`);
    expect(
      await executeWithSchema(
        ctx.db,
        visibilityRowSchema,
        sql`SELECT deleted FROM fitness.v_human_record_visibility
      WHERE identity_id = ${record}`,
      ),
    ).toEqual([{ deleted: true }]);

    const restoreChange = await changeAt("2026-09-07T02:00:00Z", userId, "restore");
    const restore = randomUUID();
    await ctx.db.execute(sql`INSERT INTO fitness.human_record_target
      (id, user_id, identity_id, change_id, predecessor_id, deleted)
      VALUES (${restore}, ${userId}, ${record}, ${restoreChange}, ${edit}, false)`);
    expect(
      await executeWithSchema(
        ctx.db,
        visibilityRowSchema,
        sql`SELECT deleted FROM fitness.v_human_record_visibility
      WHERE identity_id = ${record}`,
      ),
    ).toEqual([{ deleted: false }]);

    const finalDeleteChange = await changeAt("2026-09-07T01:00:00Z", userId, "delete");
    const finalDelete = randomUUID();
    await ctx.db.execute(sql`INSERT INTO fitness.human_record_target
      (id, user_id, identity_id, change_id, predecessor_id, deleted)
      VALUES (${finalDelete}, ${userId}, ${record}, ${finalDeleteChange}, ${restore}, true)`);

    const visibility = await executeWithSchema(
      ctx.db,
      visibilityRowSchema.extend(provenanceSchema.shape),
      sql`SELECT deleted, target_id, change_id
      FROM fitness.v_human_record_visibility WHERE identity_id = ${record}`,
    );
    expect(visibility).toEqual([
      { deleted: true, target_id: finalDelete, change_id: finalDeleteChange },
    ]);
    const fields = await executeWithSchema(
      ctx.db,
      fieldRowSchema,
      sql`SELECT field, operation, value
      FROM fitness.v_human_record_field WHERE identity_id = ${record} ORDER BY field`,
    );
    expect(fields).toEqual([
      { field: "name", operation: "set", value: "Kept" },
      { field: "notes", operation: "set", value: "Still kept" },
    ]);
  });

  it("isolates multi-target commands and exact projection provenance by user and identity", async () => {
    const first = await identity();
    const second = await identity();
    const other = await identity(otherUserId);
    const sharedChange = await change();
    const firstTarget = await target(first, sharedChange, null, userId, {
      name: { operation: "set", value: "First" },
    });
    const secondTarget = await target(second, sharedChange, null, userId, {
      name: { operation: "set", value: "Second" },
    });
    const otherChange = await change(otherUserId);
    const otherTarget = await target(other, otherChange, null, otherUserId, {
      name: { operation: "set", value: "Other" },
    });

    const rows = await executeWithSchema(
      ctx.db,
      fieldRowSchema.extend(headRowSchema.shape),
      sql`SELECT user_id, identity_id, field, operation, value, target_id, change_id
      FROM fitness.v_human_record_field
      WHERE identity_id IN (${first}, ${second}, ${other})
      ORDER BY value #>> '{}'`,
    );
    expect(rows).toEqual([
      {
        user_id: userId,
        identity_id: first,
        field: "name",
        operation: "set",
        value: "First",
        target_id: firstTarget,
        change_id: sharedChange,
      },
      {
        user_id: otherUserId,
        identity_id: other,
        field: "name",
        operation: "set",
        value: "Other",
        target_id: otherTarget,
        change_id: otherChange,
      },
      {
        user_id: userId,
        identity_id: second,
        field: "name",
        operation: "set",
        value: "Second",
        target_id: secondTarget,
        change_id: sharedChange,
      },
    ]);
  });
});
