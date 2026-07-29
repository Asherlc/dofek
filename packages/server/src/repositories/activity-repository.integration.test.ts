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
            provider_id, user_id, external_id, canonical_type, provider_type, started_at, ended_at, name
          ) VALUES
          ('mcp_search_test', ${TEST_USER_ID}, 'before', 'cycling', 'cycling',
            '2026-05-09T22:59:59Z', '2026-05-09T23:59:59Z', 'Boundary Ride Before'),
          ('mcp_search_test', ${TEST_USER_ID}, 'first', 'cycling', 'cycling',
            '2026-05-10T00:00:00Z', '2026-05-10T01:00:00Z', 'Boundary Ride First'),
          ('mcp_search_test', ${TEST_USER_ID}, 'matching', 'cycling', 'cycling',
            '2026-05-18T23:00:00Z', '2026-05-18T23:30:00Z', 'Evening Ride'),
          ('mcp_search_test', ${TEST_USER_ID}, 'other', 'walking', 'walking',
            '2026-05-18T12:00:00Z', '2026-05-18T12:30:00Z', 'Lunch Walk'),
          ('mcp_search_test', ${TEST_USER_ID}, 'after', 'cycling', 'cycling',
            '2026-05-19T00:00:00Z', '2026-05-19T01:00:00Z', 'Boundary Ride After'),
          ('mcp_search_test', ${TEST_USER_ID}, 'percent-literal', 'running', 'running',
            '2026-06-01T08:00:00Z', '2026-06-01T09:00:00Z', '50% Effort'),
          ('mcp_search_test', ${TEST_USER_ID}, 'percent-other', 'running', 'running',
            '2026-06-01T10:00:00Z', '2026-06-01T11:00:00Z', '500 Effort'),
          ('mcp_search_test', ${TEST_USER_ID}, 'underscore-literal', 'running', 'running',
            '2026-06-01T12:00:00Z', '2026-06-01T13:00:00Z', 'Leg_day Run'),
          ('mcp_search_test', ${TEST_USER_ID}, 'underscore-other', 'running', 'running',
            '2026-06-01T14:00:00Z', '2026-06-01T15:00:00Z', 'Leg-day Run'),
          ('mcp_search_test', ${TEST_USER_ID}, 'backslash-literal', 'running', 'running',
            '2026-06-01T16:00:00Z', '2026-06-01T17:00:00Z', 'Trail\\Run'),
          ('mcp_search_test', ${TEST_USER_ID}, 'backslash-other', 'running', 'running',
            '2026-06-01T18:00:00Z', '2026-06-01T19:00:00Z', 'TrailRun')`,
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

    const walkingItems = await repository.listRange("2026-05-10", "2026-05-18", ["walking"]);
    expect(walkingItems.map((item) => item.name)).toEqual(["Lunch Walk"]);

    const allItems = await repository.listRange("2026-05-10", "2026-05-18", []);
    expect(allItems).toHaveLength(3);

    const emptyResult = await repository.search({
      startDate: "2027-05-10",
      endDate: "2027-05-18",
      limit: 1,
    });
    expect(emptyResult).toEqual({ items: [], totalCount: 0 });
  });

  it.each([
    ["50%", "50% Effort"],
    ["Leg_day", "Leg_day Run"],
    ["Trail\\Run", "Trail\\Run"],
  ])("matches ILIKE metacharacters literally in %s", async (query, expectedName) => {
    const repository = new ActivityRepository(testContext.db, TEST_USER_ID, "UTC");

    const result = await repository.search({
      startDate: "2026-06-01",
      endDate: "2026-06-01",
      query,
      limit: 10,
    });

    expect(result.items.map((item) => item.name)).toEqual([expectedName]);
    expect(result.totalCount).toBe(1);
  });
});
