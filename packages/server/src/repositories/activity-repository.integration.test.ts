import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ActivityRepository } from "./activity-repository.ts";

describe("ActivityRepository exact-range search", () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await testContext.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('mcp_search_test', 'MCP Search Test', ${TEST_USER_ID})`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, external_id, activity_type, started_at, ended_at, name
          ) VALUES
          ('mcp_search_test', ${TEST_USER_ID}, 'before', 'cycling',
            '2026-05-09T22:59:59Z', '2026-05-09T23:59:59Z', 'Boundary Ride Before'),
          ('mcp_search_test', ${TEST_USER_ID}, 'first', 'cycling',
            '2026-05-10T00:00:00Z', '2026-05-10T01:00:00Z', 'Boundary Ride First'),
          ('mcp_search_test', ${TEST_USER_ID}, 'matching', 'cycling',
            '2026-05-18T23:00:00Z', '2026-05-18T23:30:00Z', 'Evening Ride'),
          ('mcp_search_test', ${TEST_USER_ID}, 'nonmatching', 'walking',
            '2026-05-18T12:00:00Z', '2026-05-18T12:30:00Z', 'Lunch Walk'),
          ('mcp_search_test', ${TEST_USER_ID}, 'after', 'cycling',
            '2026-05-19T00:00:00Z', '2026-05-19T01:00:00Z', 'Boundary Ride After')`,
    );
  }, 60_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("applies both inclusive date boundaries before filtering, counting, and limiting", async () => {
    const repository = new ActivityRepository(testContext.db, TEST_USER_ID, "UTC");
    const rangeItems = await repository.listRange("2026-05-10", "2026-05-18");

    expect(rangeItems.map((item) => item.name)).toEqual([
      "Evening Ride",
      "Lunch Walk",
      "Boundary Ride First",
    ]);

    const result = await repository.search({
      startDate: "2026-05-10",
      endDate: "2026-05-18",
      query: "ride",
      limit: 1,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.name).toBe("Evening Ride");
    expect(result.totalCount).toBe(2);
  });
});
