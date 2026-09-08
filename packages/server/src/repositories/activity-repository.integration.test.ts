import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { makeMockSensorStore } from "../routers/test-helpers.ts";
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

const RESOLUTION_GROUP_ID = "70000000-0000-4000-8000-000000000001";
const RESOLUTION_MEMBER_ID = "70000000-0000-4000-8000-000000000002";
const RESOLUTION_SECOND_MEMBER_ID = "70000000-0000-4000-8000-000000000003";
const RESOLUTION_ALIAS_ID = "70000000-0000-4000-8000-000000000004";
const OTHER_USER_ID = "70000000-0000-4000-8000-000000000005";
const OTHER_GROUP_ID = "70000000-0000-4000-8000-000000000006";
const OTHER_MEMBER_ID = "70000000-0000-4000-8000-000000000007";
const OTHER_ALIAS_ID = "70000000-0000-4000-8000-000000000008";
const ABSENT_DELETED_MEMBER_ID = "70000000-0000-4000-8000-000000000009";
const ABSENT_GROUP_ID = "70000000-0000-4000-8000-000000000010";
const ABSENT_GENERIC_MEMBER_ID = "70000000-0000-4000-8000-000000000011";
const ABSENT_UNREFINED_MEMBER_ID = "70000000-0000-4000-8000-000000000012";
const ABSENT_REFINED_MEMBER_ID = "70000000-0000-4000-8000-000000000013";
const ABSENT_WINNER_MEMBER_ID = "70000000-0000-4000-8000-000000000014";
const ABSENT_ALIAS_ID = "70000000-0000-4000-8000-000000000016";

describe("ActivityRepository stable activity id resolution", () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await testContext.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('activity_resolution_test', 'Activity Resolution Test', ${TEST_USER_ID})`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES (${OTHER_USER_ID}, 'Activity Resolution Other User')`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('activity_resolution_other', 'Activity Resolution Other', ${OTHER_USER_ID})`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.activity (
            id, group_id, provider_id, user_id, external_id, canonical_type, provider_type,
            started_at, ended_at, name
          ) VALUES
          (
            ${RESOLUTION_MEMBER_ID}, ${RESOLUTION_GROUP_ID}, 'activity_resolution_test',
            ${TEST_USER_ID}, 'member-1', 'cycling', 'ride',
            '2026-08-01T10:00:00Z', '2026-08-01T11:00:00Z', 'Stable Group Ride'
          ),
          (
            ${RESOLUTION_SECOND_MEMBER_ID}, ${RESOLUTION_GROUP_ID}, 'activity_resolution_test',
            ${TEST_USER_ID}, 'member-2', 'cycling', 'cycling',
            '2026-08-01T10:00:00Z', '2026-08-01T11:00:00Z', 'Stable Group Ride'
          )`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.activity_group (id, user_id, anchor_activity_id)
          VALUES (${RESOLUTION_ALIAS_ID}, ${TEST_USER_ID}, NULL)`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.activity_group_alias (alias_id, group_id, user_id, reason)
          VALUES (${RESOLUTION_ALIAS_ID}, ${RESOLUTION_GROUP_ID}, ${TEST_USER_ID}, 'merge')`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.activity (
            id, group_id, provider_id, user_id, external_id, canonical_type, provider_type,
            started_at, ended_at, name
          ) VALUES (
            ${OTHER_MEMBER_ID}, ${OTHER_GROUP_ID}, 'activity_resolution_other', ${OTHER_USER_ID},
            'other-member', 'running', 'running', '2026-08-02T10:00:00Z',
            '2026-08-02T11:00:00Z', 'Other User Run'
          )`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.activity_group (id, user_id, anchor_activity_id)
          VALUES (${OTHER_ALIAS_ID}, ${OTHER_USER_ID}, NULL)`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.activity_group_alias (alias_id, group_id, user_id, reason)
          VALUES (${OTHER_ALIAS_ID}, ${OTHER_GROUP_ID}, ${OTHER_USER_ID}, 'merge')`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES
            ('activity_resolution_absent_generic', 'Absent Generic', ${TEST_USER_ID}),
            ('activity_resolution_absent_unrefined', 'Absent Unrefined', ${TEST_USER_ID}),
            ('activity_resolution_absent_refined', 'Absent Refined', ${TEST_USER_ID}),
            ('activity_resolution_absent_winner', 'Absent Winner', ${TEST_USER_ID}),
            ('activity_resolution_absent_deleted', 'Absent Deleted', ${TEST_USER_ID})`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.provider_priority (provider_id, priority)
          VALUES
            ('activity_resolution_absent_generic', 0),
            ('activity_resolution_absent_unrefined', 0),
            ('activity_resolution_absent_refined', 20),
            ('activity_resolution_absent_winner', 90),
            ('activity_resolution_absent_deleted', 0)`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.device_priority (provider_id, source_name_pattern, priority)
          VALUES ('activity_resolution_absent_winner', 'Preferred%', 2)`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.activity (
            id, group_id, provider_id, user_id, external_id, canonical_type, provider_type,
            started_at, ended_at, name, source_name, provider_absent_at, deleted_at
          ) VALUES
          (
            ${ABSENT_DELETED_MEMBER_ID}, ${ABSENT_GROUP_ID},
            'activity_resolution_absent_deleted', ${TEST_USER_ID}, 'absent-deleted',
            'cycling', 'Outdoor Ride', '2026-08-03T10:00:00Z', '2026-08-03T11:00:00Z',
            'Deleted absent ride', 'Deleted Device', '2026-08-04T00:00:00Z',
            '2026-08-04T01:00:00Z'
          ),
          (
            ${ABSENT_GENERIC_MEMBER_ID}, ${ABSENT_GROUP_ID},
            'activity_resolution_absent_generic', ${TEST_USER_ID}, 'absent-generic',
            'other', 'other', '2026-08-03T10:00:00Z', '2026-08-03T11:00:00Z',
            'Generic absent activity', 'Generic Device', '2026-08-04T00:00:00Z', NULL
          ),
          (
            ${ABSENT_UNREFINED_MEMBER_ID}, ${ABSENT_GROUP_ID},
            'activity_resolution_absent_unrefined', ${TEST_USER_ID}, 'absent-unrefined',
            'cycling', ' Cycling ', '2026-08-03T10:00:00Z', '2026-08-03T11:00:00Z',
            'Unrefined absent ride', 'Unrefined Device', '2026-08-04T00:00:00Z', NULL
          ),
          (
            ${ABSENT_REFINED_MEMBER_ID}, ${ABSENT_GROUP_ID},
            'activity_resolution_absent_refined', ${TEST_USER_ID}, 'absent-refined',
            'cycling', 'Indoor Ride', '2026-08-03T10:00:00Z', '2026-08-03T11:00:00Z',
            'Provider-ranked absent ride', 'Standard Trainer', '2026-08-04T00:00:00Z', NULL
          ),
          (
            ${ABSENT_WINNER_MEMBER_ID}, ${ABSENT_GROUP_ID},
            'activity_resolution_absent_winner', ${TEST_USER_ID}, 'absent-winner',
            'cycling', 'Workout', '2026-08-03T10:00:00Z', '2026-08-03T11:00:00Z',
            'Preferred absent ride', 'Preferred Trainer', '2026-08-04T00:00:00Z', NULL
          )`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.activity_group (id, user_id, anchor_activity_id)
          VALUES (${ABSENT_ALIAS_ID}, ${TEST_USER_ID}, NULL)`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.activity_group_alias (alias_id, group_id, user_id, reason)
          VALUES (${ABSENT_ALIAS_ID}, ${ABSENT_GROUP_ID}, ${TEST_USER_ID}, 'merge')`,
    );
  }, 60_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("returns a direct stable group without substitution metadata", async () => {
    const repository = new ActivityRepository(testContext.db, TEST_USER_ID, "UTC");

    const activity = await repository.findById(RESOLUTION_GROUP_ID);

    expect(activity).toMatchObject({ id: RESOLUTION_GROUP_ID, name: "Stable Group Ride" });
    expect(activity).not.toHaveProperty("resolved_from");
  });

  it("resolves a member id to its stable group and reports the requested id", async () => {
    const repository = new ActivityRepository(testContext.db, TEST_USER_ID, "UTC");

    await expect(repository.findById(RESOLUTION_MEMBER_ID)).resolves.toMatchObject({
      id: RESOLUTION_GROUP_ID,
      resolved_from: RESOLUTION_MEMBER_ID,
    });
  });

  it("resolves a merged historical alias to its retained stable group", async () => {
    const repository = new ActivityRepository(testContext.db, TEST_USER_ID, "UTC");

    await expect(repository.findById(RESOLUTION_ALIAS_ID)).resolves.toMatchObject({
      id: RESOLUTION_GROUP_ID,
      resolved_from: RESOLUTION_ALIAS_ID,
    });
  });

  it.each([OTHER_GROUP_ID, OTHER_MEMBER_ID, OTHER_ALIAS_ID])(
    "does not reveal a cross-user group, member, or alias (%s)",
    async (activityId) => {
      const repository = new ActivityRepository(testContext.db, TEST_USER_ID, "UTC");

      await expect(repository.findById(activityId)).resolves.toBeNull();
    },
  );

  it.each([
    ["missing", "70000000-0000-4000-8000-000000000099"],
    ["cross-user", OTHER_GROUP_ID],
  ])("returns the same NOT_FOUND from every sensor entry point for a %s id", async (_case, id) => {
    const sensorStore = makeMockSensorStore();
    const calls = [
      () =>
        new ActivityRepository(
          testContext.db,
          TEST_USER_ID,
          "UTC",
          undefined,
          sensorStore,
        ).getStream(id, 500),
      () =>
        new ActivityRepository(
          testContext.db,
          TEST_USER_ID,
          "UTC",
          undefined,
          sensorStore,
        ).getHrZones(id),
      () =>
        new ActivityRepository(
          testContext.db,
          TEST_USER_ID,
          "UTC",
          undefined,
          sensorStore,
        ).getPowerZones(id, 250),
    ];

    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "Activity not found",
      });
    }
  });

  it("returns null when no group, member, or alias matches", async () => {
    const repository = new ActivityRepository(testContext.db, TEST_USER_ID, "UTC");

    await expect(repository.findById("70000000-0000-4000-8000-000000000099")).resolves.toBeNull();
  });

  it("selects the same deterministic non-deleted fallback for an absent group, members, and alias", async () => {
    const requestedIds = [
      ABSENT_GROUP_ID,
      ABSENT_GENERIC_MEMBER_ID,
      ABSENT_UNREFINED_MEMBER_ID,
      ABSENT_ALIAS_ID,
    ];

    const activities = await Promise.all(
      requestedIds.map((activityId) =>
        new ActivityRepository(testContext.db, TEST_USER_ID, "UTC").findById(activityId),
      ),
    );

    expect(
      activities.map((activity) => ({
        canonical_type: activity?.canonical_type,
        id: activity?.id,
        name: activity?.name,
        provider_id: activity?.provider_id,
        raw_type: activity?.raw_type,
        resolved_from: activity?.resolved_from,
      })),
    ).toEqual([
      {
        canonical_type: "cycling",
        id: ABSENT_GROUP_ID,
        name: "Preferred absent ride",
        provider_id: "activity_resolution_absent_winner",
        raw_type: "Workout",
        resolved_from: undefined,
      },
      {
        canonical_type: "cycling",
        id: ABSENT_GROUP_ID,
        name: "Preferred absent ride",
        provider_id: "activity_resolution_absent_winner",
        raw_type: "Workout",
        resolved_from: ABSENT_GENERIC_MEMBER_ID,
      },
      {
        canonical_type: "cycling",
        id: ABSENT_GROUP_ID,
        name: "Preferred absent ride",
        provider_id: "activity_resolution_absent_winner",
        raw_type: "Workout",
        resolved_from: ABSENT_UNREFINED_MEMBER_ID,
      },
      {
        canonical_type: "cycling",
        id: ABSENT_GROUP_ID,
        name: "Preferred absent ride",
        provider_id: "activity_resolution_absent_winner",
        raw_type: "Workout",
        resolved_from: ABSENT_ALIAS_ID,
      },
    ]);
  });
});
