import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reconcileActivityGroups } from "./activity-group-reconciliation.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

describe("transactional activity group reconciliation", () => {
  let context: TestContext;
  let userId: string;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`INSERT INTO fitness.provider (id, name)
      VALUES ('group-test-a', 'Group A'), ('group-test-b', 'Group B')`);
  }, 120_000);
  afterAll(async () => {
    await context?.cleanup();
  });
  beforeEach(async () => {
    userId = randomUUID();
    await context.db.execute(sql`INSERT INTO fitness.user_profile (id, name)
      VALUES (${userId}, 'Activity group test')`);
  });

  async function activity(
    provider = "group-test-a",
    start = "2026-09-01T08:00:00Z",
    end = "2026-09-01T09:00:00Z",
    created = "2026-09-01T10:00:00Z",
  ) {
    const id = randomUUID();
    const groupId = randomUUID();
    await context.db.execute(sql`INSERT INTO fitness.activity
      (id, group_id, user_id, provider_id, external_id, canonical_type, provider_type, started_at, ended_at, created_at)
      VALUES (${id}, ${groupId}, ${userId}, ${provider}, ${id}, 'cycling', 'cycling', ${start}, ${end}, ${created})`);
    return { id, groupId };
  }
  const reconcile = () =>
    context.db.transaction((transaction) => reconcileActivityGroups(transaction, userId));
  const membership = (id: string) =>
    context.db.execute(sql`SELECT group_id FROM fitness.activity WHERE id = ${id}`);
  const aliases = () =>
    context.db.execute(
      sql`SELECT alias_id, group_id, reason FROM fitness.activity_group_alias WHERE user_id = ${userId} ORDER BY alias_id`,
    );

  it("keeps identity through late provider addition and provider priority changes", async () => {
    const first = await activity();
    await reconcile();
    const second = await activity("group-test-b", undefined, undefined, "2026-09-02T10:00:00Z");
    await reconcile();
    expect(await membership(second.id)).toEqual([{ group_id: first.groupId }]);
    await context.db.execute(sql`INSERT INTO fitness.provider_priority (provider_id, priority)
      VALUES ('group-test-b', 1) ON CONFLICT (provider_id) DO UPDATE SET priority = excluded.priority`);
    await reconcile();
    expect(await membership(first.id)).toEqual([{ group_id: first.groupId }]);
    expect(await membership(second.id)).toEqual([{ group_id: first.groupId }]);
    expect(await aliases()).toEqual([
      { alias_id: second.groupId, group_id: first.groupId, reason: "merge" },
    ]);
  });

  it("flattens historical aliases when their target later merges into an older group", async () => {
    const first = await activity(undefined, undefined, undefined, "2026-09-02T10:00:00Z");
    const second = await activity("group-test-b", undefined, undefined, "2026-09-03T10:00:00Z");
    await reconcile();
    const oldest = await activity(undefined, undefined, undefined, "2026-09-01T10:00:00Z");
    await reconcile();
    expect(await membership(first.id)).toEqual([{ group_id: oldest.groupId }]);
    expect(await membership(second.id)).toEqual([{ group_id: oldest.groupId }]);
    expect(await aliases()).toEqual(
      [
        { alias_id: first.groupId, group_id: oldest.groupId, reason: "merge" },
        { alias_id: second.groupId, group_id: oldest.groupId, reason: "merge" },
      ].sort((left, right) => left.alias_id.localeCompare(right.alias_id)),
    );
  });

  it("assigns a split component a new persisted group while the oldest active member retains identity", async () => {
    const first = await activity();
    const second = await activity("group-test-b", undefined, undefined, "2026-09-02T10:00:00Z");
    await reconcile();
    await context.db.execute(sql`UPDATE fitness.activity SET
      started_at = '2026-09-01T11:00:00Z', ended_at = '2026-09-01T12:00:00Z' WHERE id = ${second.id}`);
    await reconcile();
    expect(await membership(first.id)).toEqual([{ group_id: first.groupId }]);
    const split = await membership(second.id);
    expect(split[0]?.group_id).not.toBe(first.groupId);
    expect(split[0]?.group_id).not.toBe(second.groupId);
    expect(
      await context.db.execute(
        sql`SELECT anchor_activity_id FROM fitness.activity_group WHERE id = ${split[0]?.group_id}`,
      ),
    ).toEqual([{ anchor_activity_id: second.id }]);
    await reconcile();
    expect(await membership(second.id)).toEqual(split);
  });

  it.each(["deleted_at", "provider_absent_at"] as const)(
    "preserves %s members through merge, full inactivity, and restore",
    async (column) => {
      const first = await activity(undefined, undefined, undefined, "2026-09-02T10:00:00Z");
      const second = await activity("group-test-b", undefined, undefined, "2026-09-03T10:00:00Z");
      await reconcile();
      await context.db.execute(
        sql`UPDATE fitness.activity SET ${sql.identifier(column)} = now() WHERE id = ${second.id}`,
      );
      const older = await activity(undefined, undefined, undefined, "2026-09-01T10:00:00Z");
      await reconcile();
      expect(await membership(second.id)).toEqual([{ group_id: older.groupId }]);
      await context.db.execute(
        sql`UPDATE fitness.activity SET ${sql.identifier(column)} = now() WHERE user_id = ${userId}`,
      );
      await reconcile();
      expect(await membership(first.id)).toEqual([{ group_id: older.groupId }]);
      await context.db.execute(
        sql`UPDATE fitness.activity SET ${sql.identifier(column)} = NULL WHERE user_id = ${userId}`,
      );
      await reconcile();
      expect(await membership(second.id)).toEqual([{ group_id: older.groupId }]);
    },
  );

  it("does not let an inactive bridge connect separate active sessions", async () => {
    const first = await activity();
    const bridge = await activity("group-test-b", "2026-09-01T08:00:00Z", "2026-09-01T11:00:00Z");
    const last = await activity(undefined, "2026-09-01T10:00:00Z", "2026-09-01T11:00:00Z");
    await context.db.execute(
      sql`UPDATE fitness.activity SET provider_absent_at = now() WHERE id = ${bridge.id}`,
    );
    await reconcile();
    expect(await membership(first.id)).toEqual([{ group_id: first.groupId }]);
    expect(await membership(last.id)).toEqual([{ group_id: last.groupId }]);
    expect(await membership(bridge.id)).toEqual([{ group_id: bridge.groupId }]);
  });

  it.each([
    {
      provider: "group-test-b",
      start: "2026-09-01T08:15:00Z",
      end: "2026-09-01T08:45:00Z",
      merges: true,
    },
    {
      provider: "group-test-a",
      start: "2026-09-01T08:15:00Z",
      end: "2026-09-01T08:45:00Z",
      merges: false,
    },
    {
      provider: "group-test-a",
      start: "2026-09-01T08:00:00Z",
      end: "2026-09-01T08:48:00Z",
      merges: false,
    },
    {
      provider: "group-test-a",
      start: "2026-09-01T08:00:00Z",
      end: "2026-09-01T08:49:00Z",
      merges: true,
    },
    {
      provider: "group-test-b",
      start: "2026-09-01T09:00:00Z",
      end: "2026-09-01T10:00:00Z",
      merges: false,
    },
  ])(
    "preserves strict overlap and cross-provider containment rules: $provider $start $end",
    async ({ provider, start, end, merges }) => {
      const first = await activity();
      const second = await activity(provider, start, end, "2026-09-02T10:00:00Z");
      await reconcile();
      expect(await membership(second.id)).toEqual([
        { group_id: merges ? first.groupId : second.groupId },
      ]);
    },
  );

  it("uses the one-hour end fallback and transitive active overlap", async () => {
    const first = await activity();
    const bridge = await activity(
      "group-test-b",
      "2026-09-01T08:00:00Z",
      "2026-09-01T11:00:00Z",
      "2026-09-02T10:00:00Z",
    );
    const last = await activity(
      undefined,
      "2026-09-01T10:00:00Z",
      "2026-09-01T11:00:00Z",
      "2026-09-03T10:00:00Z",
    );
    await context.db.execute(
      sql`UPDATE fitness.activity SET ended_at = NULL WHERE id = ${first.id}`,
    );
    await reconcile();
    expect(await membership(bridge.id)).toEqual([{ group_id: first.groupId }]);
    expect(await membership(last.id)).toEqual([{ group_id: first.groupId }]);
  });

  it("serializes concurrent reconciliations for the same user", async () => {
    const first = await activity();
    const second = await activity("group-test-b", undefined, undefined, "2026-09-02T10:00:00Z");
    await Promise.all([reconcile(), reconcile(), reconcile()]);
    expect(await membership(second.id)).toEqual([{ group_id: first.groupId }]);
    expect(await aliases()).toEqual([
      { alias_id: second.groupId, group_id: first.groupId, reason: "merge" },
    ]);
  });

  it("holds the per-user lock until transaction completion and leaves other users independent", async () => {
    await activity();
    const lock = (id: string) =>
      context.db.transaction((transaction) =>
        transaction.execute(sql`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${`activity-groups:${id}`}, 0)) AS acquired`),
      );
    await context.db.transaction(async (transaction) => {
      await reconcileActivityGroups(transaction, userId);
      expect(await lock(userId)).toEqual([{ acquired: false }]);
      expect(await lock(randomUUID())).toEqual([{ acquired: true }]);
    });
    expect(await lock(userId)).toEqual([{ acquired: true }]);
  });

  it("retains inactive members with the original group during a split", async () => {
    const first = await activity();
    const second = await activity("group-test-b", undefined, undefined, "2026-09-02T10:00:00Z");
    const third = await activity("group-test-b", undefined, undefined, "2026-09-03T10:00:00Z");
    await reconcile();
    await context.db.execute(
      sql`UPDATE fitness.activity SET deleted_at = now() WHERE id = ${first.id}`,
    );
    await context.db.execute(sql`UPDATE fitness.activity SET
      started_at = '2026-09-01T11:00:00Z', ended_at = '2026-09-01T12:00:00Z' WHERE id = ${third.id}`);
    await reconcile();
    expect(await membership(first.id)).toEqual([{ group_id: first.groupId }]);
    expect(await membership(second.id)).toEqual([{ group_id: first.groupId }]);
    expect((await membership(third.id))[0]?.group_id).not.toBe(first.groupId);
  });

  it("rolls membership and aliases back with the enclosing canonical transaction", async () => {
    const first = await activity();
    const second = await activity("group-test-b", undefined, undefined, "2026-09-02T10:00:00Z");
    await expect(
      context.db.transaction(async (transaction) => {
        await reconcileActivityGroups(transaction, userId);
        throw new Error("canonical commit failed");
      }),
    ).rejects.toThrow("canonical commit failed");
    expect(await membership(first.id)).toEqual([{ group_id: first.groupId }]);
    expect(await membership(second.id)).toEqual([{ group_id: second.groupId }]);
    expect(await aliases()).toEqual([]);
  });
});
