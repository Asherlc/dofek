import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTaggedQueryClient, type TaggedQueryClient } from "./tagged-query-client.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

describe("tagged query client transactions", () => {
  let context: TestContext;
  let sql: TaggedQueryClient;

  beforeAll(async () => {
    context = await setupTestDatabase();
    sql = createTaggedQueryClient(context.connectionString);
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await context?.cleanup();
  });

  it("rolls back all writes when the transaction callback fails", async () => {
    const userId = randomUUID();

    await expect(
      sql.transaction(async (transaction) => {
        await transaction`
          INSERT INTO fitness.user_profile (id, name, email)
          VALUES (${userId}, 'Transaction rollback', 'transaction-rollback@example.test')
        `;
        throw new Error("force transaction rollback");
      }),
    ).rejects.toThrow("force transaction rollback");

    await expect(
      sql<{ id: string }>`SELECT id FROM fitness.user_profile WHERE id = ${userId}`,
    ).resolves.toEqual([]);
  });
});
