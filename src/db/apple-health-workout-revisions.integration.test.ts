import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

describe("Apple Health workout revisions in v_activity", () => {
  let context: TestContext;
  let userId: string;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`INSERT INTO fitness.provider (id, name)
      VALUES ('apple_health', 'Apple Health'), ('whoop', 'WHOOP') ON CONFLICT (id) DO NOTHING`);
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  beforeEach(async () => {
    userId = randomUUID();
    await context.db.execute(sql`INSERT INTO fitness.user_profile (id, name)
      VALUES (${userId}, 'Workout revision test')`);
  });

  async function revision(options: {
    version: number | string;
    current?: boolean;
    syncIdentifier?: string;
    ownerId?: string;
    createdAt?: string;
  }) {
    const id = randomUUID();
    const groupId = randomUUID();
    const startedAt = options.current ? "2026-09-29T14:28:31Z" : "2026-09-29T13:57:00Z";
    const endedAt = options.current ? "2026-09-29T15:23:48Z" : "2026-09-29T15:04:59Z";
    const raw = {
      sourceName: "WHOOP",
      metadata: {
        HKMetadataKeySyncIdentifier: options.syncIdentifier ?? "whoop://workout/revised-climb",
        HKMetadataKeySyncVersion: options.version,
      },
    };
    await context.db.execute(sql`INSERT INTO fitness.activity
      (id, group_id, user_id, provider_id, external_id, canonical_type, provider_type,
       source_name, started_at, ended_at, created_at, raw)
      VALUES (${id}, ${groupId}, ${options.ownerId ?? userId}, 'apple_health', ${`hk:workout:${id}`},
        'climbing', '9', 'WHOOP', ${startedAt}, ${endedAt},
        ${options.createdAt ?? "2026-09-29T16:00:00Z"}, ${JSON.stringify(raw)}::jsonb)`);
    return { id, groupId };
  }

  const visible = () =>
    context.db.execute<{ id: string; started_at: Date; ended_at: Date }>(sql`
      SELECT id, started_at, ended_at FROM fitness.v_activity WHERE user_id = ${userId}`);

  async function directWorkout(groupId: string) {
    const id = randomUUID();
    await context.db.execute(sql`INSERT INTO fitness.activity
      (id, group_id, user_id, provider_id, external_id, canonical_type, provider_type, started_at, ended_at)
      VALUES (${id}, ${groupId}, ${userId}, 'whoop', ${id}, 'climbing', 'rock-climbing',
        '2026-09-29T14:28:31Z', '2026-09-29T15:23:48Z')`);
  }

  it("serves the highest sync version after the workout times change while retaining raw revisions", async () => {
    await revision({ version: 1834, createdAt: "2026-09-29T17:00:00Z" });
    const latest = await revision({ version: "1835", current: true });

    const rows = await visible();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(latest.groupId);
    expect(new Date(rows[0]?.started_at ?? "").toISOString()).toBe("2026-09-29T14:28:31.000Z");
    expect(new Date(rows[0]?.ended_at ?? "").toISOString()).toBe("2026-09-29T15:23:48.000Z");
    expect(
      await context.db.execute(sql`SELECT COUNT(*)::int AS count FROM fitness.activity
      WHERE user_id = ${userId}`),
    ).toEqual([{ count: 2 }]);
  });

  it.each(["provider_absent_at", "deleted_at"] as const)(
    "does not resurrect an older version when the latest has %s",
    async (column) => {
      await revision({ version: 1834 });
      const latest = await revision({ version: 1835, current: true });
      await context.db.execute(sql`UPDATE fitness.activity SET ${sql.identifier(column)} = now()
        WHERE id = ${latest.id}`);

      expect(await visible()).toEqual([]);
    },
  );

  it("keeps different sync identifiers visible", async () => {
    const first = await revision({ version: 1834 });
    const second = await revision({
      version: 1835,
      current: true,
      syncIdentifier: "another-workout",
    });

    expect((await visible()).map((row) => row.id).sort()).toEqual(
      [first.groupId, second.groupId].sort(),
    );
  });

  it("scopes revision selection to the owning user", async () => {
    const first = await revision({ version: 1834 });
    const otherUser = randomUUID();
    await context.db.execute(sql`INSERT INTO fitness.user_profile (id, name)
      VALUES (${otherUser}, 'Other workout owner')`);
    await revision({ version: 1835, current: true, ownerId: otherUser });

    expect((await visible()).map((row) => row.id)).toEqual([first.groupId]);
  });

  it("normalizes sync identifiers and breaks equal-version ties by arrival", async () => {
    await revision({ version: 1835, syncIdentifier: " whoop://workout/revised-climb " });
    const latest = await revision({
      version: "1835",
      current: true,
      createdAt: "2026-09-29T17:00:00Z",
    });

    expect((await visible()).map((row) => row.id)).toEqual([latest.groupId]);
  });

  it("keeps workouts without a sync identifier independent", async () => {
    const first = await revision({ version: 1834, syncIdentifier: "" });
    const second = await revision({ version: 1835, current: true, syncIdentifier: " " });

    expect((await visible()).map((row) => row.id).sort()).toEqual(
      [first.groupId, second.groupId].sort(),
    );
  });

  it("applies the latest revision's absence to its direct-provider group despite an active older sibling", async () => {
    await revision({ version: 1834 });
    const latest = await revision({ version: 1835, current: true });
    await directWorkout(latest.groupId);
    await context.db.execute(sql`UPDATE fitness.activity SET provider_absent_at = now()
      WHERE id = ${latest.id}`);

    expect(await visible()).toEqual([]);
  });

  it.each([false, true])(
    "ignores a superseded tombstone when the latest revision is deleted=%s",
    async (latestDeleted) => {
      const old = await revision({ version: 1834 });
      const latest = await revision({ version: 1835, current: true });
      await directWorkout(latest.groupId);
      await context.db.execute(sql`UPDATE fitness.activity
      SET group_id = ${latest.groupId}, provider_absent_at = now() WHERE id = ${old.id}`);
      if (latestDeleted) {
        await context.db.execute(
          sql`UPDATE fitness.activity SET deleted_at = now() WHERE id = ${latest.id}`,
        );
      }

      expect((await visible()).map((row) => row.id)).toEqual([latest.groupId]);
    },
  );
});
