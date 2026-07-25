import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensurePushProvider } from "./push-provider-repository.ts";

describe("ensurePushProvider (integration)", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("creates independent connections for two users sharing one push provider type", async () => {
    const firstUserId = "55555555-5555-4555-8555-555555555555";
    const secondUserId = "66666666-6666-4666-8666-666666666666";
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES
            (${firstUserId}, 'First Push User'),
            (${secondUserId}, 'Second Push User')
          ON CONFLICT (id) DO NOTHING`,
    );

    await ensurePushProvider({
      database: context.db,
      providerId: "whoop_ble",
      userId: firstUserId,
    });
    await ensurePushProvider({
      database: context.db,
      providerId: "whoop_ble",
      userId: secondUserId,
    });

    const catalogRows = await context.db.execute<{ id: string }>(
      sql`SELECT id FROM fitness.provider WHERE id = 'whoop_ble'`,
    );
    const connectionRows = await context.db.execute<{ user_id: string }>(
      sql`SELECT user_id
          FROM fitness.provider_connection
          WHERE provider_id = 'whoop_ble'
          ORDER BY user_id`,
    );

    expect(catalogRows).toEqual([{ id: "whoop_ble" }]);
    expect(connectionRows).toEqual([{ user_id: firstUserId }, { user_id: secondUserId }]);
  });
});
