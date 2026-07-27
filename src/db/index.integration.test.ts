import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { userProfile } from "./schema/reference.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

describe("normalized database wrapper (integration)", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
  });

  afterAll(async () => {
    await context.cleanup();
  });

  it("normalizes raw rows while preserving Drizzle operations and nested savepoints", async () => {
    const primaryId = randomUUID();
    const deletedId = randomUUID();
    const rolledBackId = randomUUID();
    const nestedId = randomUUID();

    await expect(
      context.db.execute<{ value: number }>(sql`SELECT 7::integer AS value`),
    ).resolves.toEqual([{ value: 7 }]);

    await context.db.transaction(async (transaction) => {
      await expect(
        transaction.execute<{ value: number }>(sql`SELECT 11::integer AS value`),
      ).resolves.toEqual([{ value: 11 }]);

      await transaction.insert(userProfile).values([
        { id: primaryId, name: "Primary" },
        { id: deletedId, name: "Delete me" },
      ]);
      await expect(
        transaction
          .select({ id: userProfile.id, name: userProfile.name })
          .from(userProfile)
          .where(eq(userProfile.id, primaryId)),
      ).resolves.toEqual([{ id: primaryId, name: "Primary" }]);

      await transaction
        .update(userProfile)
        .set({ name: "Updated" })
        .where(eq(userProfile.id, primaryId));
      await transaction.delete(userProfile).where(eq(userProfile.id, deletedId));

      await expect(
        transaction.transaction(async (nested) => {
          await nested.insert(userProfile).values({ id: rolledBackId, name: "Rolled back" });
          await expect(
            nested.execute<{ value: number }>(sql`SELECT 13::integer AS value`),
          ).resolves.toEqual([{ value: 13 }]);
          throw new Error("roll back nested savepoint");
        }),
      ).rejects.toThrow("roll back nested savepoint");

      await expect(
        transaction
          .select({ id: userProfile.id })
          .from(userProfile)
          .where(eq(userProfile.id, rolledBackId)),
      ).resolves.toEqual([]);

      await transaction.transaction(async (nested) => {
        await nested.insert(userProfile).values({ id: nestedId, name: "Nested" });
      });
    });

    await expect(
      context.db
        .select({ id: userProfile.id, name: userProfile.name })
        .from(userProfile)
        .where(inArray(userProfile.id, [primaryId, deletedId, rolledBackId, nestedId]))
        .orderBy(userProfile.name),
    ).resolves.toEqual([
      { id: nestedId, name: "Nested" },
      { id: primaryId, name: "Updated" },
    ]);
  });
});
