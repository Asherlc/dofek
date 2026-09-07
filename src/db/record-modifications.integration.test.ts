import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { erasePostgresAccount } from "../account-erasure/postgres-erasure.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

let ctx: TestContext;
let userId: string;
let otherUserId: string;
const hash = "a".repeat(64);

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
    await target(first, successor, head);
    await expect(target(first, await change(), head)).rejects.toMatchObject({
      cause: { code: "23505" },
    });
    await expect(target(first, successor, head)).rejects.toMatchObject({
      cause: { code: "23505" },
    });
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
          await tx.execute(
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
      VALUES (${userId}, ${provider}, ${externalId}, '2026-09-07', 'Resynced')`);
    await ctx.db.execute(sql`DELETE FROM fitness.food_entry WHERE provider_id = ${provider}`);
    await ctx.db.execute(sql`DELETE FROM fitness.provider WHERE id = ${provider}`);
    const rows = await ctx.db.execute(
      sql`SELECT id FROM fitness.human_record_identity WHERE id = ${record}`,
    );
    expect(rows).toHaveLength(1);
    expect(
      await ctx.db.execute(
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
        await tx.execute(
          sql`SELECT set_config('dofek.account_erasure_request_id', ${request}, true)`,
        );
        await tx.execute(
          sql`DELETE FROM fitness.human_record_target WHERE user_id = ${otherUserId}`,
        );
      }),
    ).rejects.toMatchObject({ cause: { code: "55000" } });
    await expect(
      ctx.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('dofek.account_erasure_request_id', ${request}, true)`,
        );
        await tx.execute(
          sql`UPDATE fitness.human_record_target SET fields = '{}' WHERE user_id = ${userId}`,
        );
      }),
    ).rejects.toMatchObject({ cause: { code: "55000" } });
    const otherBefore = await ctx.db.execute(
      sql`SELECT id FROM fitness.human_record_target WHERE user_id = ${otherUserId}`,
    );
    await erasePostgresAccount(ctx.db, request, userId);
    for (const table of ["human_record_target", "human_record_change", "human_record_identity"]) {
      expect(
        await ctx.db.execute(
          sql`SELECT id FROM fitness.${sql.identifier(table)} WHERE user_id = ${userId}`,
        ),
      ).toHaveLength(0);
    }
    expect(
      await ctx.db.execute(
        sql`SELECT id FROM fitness.human_record_target WHERE user_id = ${otherUserId}`,
      ),
    ).toEqual(otherBefore);
  });
});
