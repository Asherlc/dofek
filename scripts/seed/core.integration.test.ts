import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTaggedQueryClient,
  type TaggedQueryClient,
} from "../../src/db/tagged-query-client.ts";
import { setupTestDatabase, type TestContext } from "../../src/db/test-helpers.ts";
import { listScopedProcessingOperations } from "../../src/processing/processing-event-store.ts";
import { seedCore } from "./core.ts";
import { USER_ID } from "./helpers.ts";

describe("review seed core", () => {
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

  it("seeds an identity accepted by processing runtime boundaries", async () => {
    await seedCore(sql);

    await expect(
      listScopedProcessingOperations(context.db, {
        userId: USER_ID,
      }),
    ).resolves.toEqual([]);
  });
});
