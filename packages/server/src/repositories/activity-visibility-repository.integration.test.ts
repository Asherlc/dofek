import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { countActivityOriginCalls } from "./activity-origin-call-test-helpers.ts";
import { ActivityVisibilityRepository } from "./activity-visibility-repository.ts";

describe("activity visibility query work", () => {
  let context: TestContext;
  const visibleGroupId = randomUUID();
  const removedGroupId = randomUUID();
  const otherUserGroupId = randomUUID();
  const otherUserId = randomUUID();

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`INSERT INTO fitness.provider(id, name)
      VALUES ('activity-query-test', 'Activity query test')`);
    await context.db.execute(sql`INSERT INTO fitness.user_profile(id, name)
      VALUES (${otherUserId}, 'Other user')`);
    await context.db.execute(sql`INSERT INTO fitness.activity
      (id, group_id, user_id, provider_id, external_id, canonical_type, provider_type,
        started_at, ended_at, local_time_source, start_utc_offset_minutes, deleted_at)
      VALUES
        (${randomUUID()}, ${visibleGroupId}, ${TEST_USER_ID}, 'activity-query-test', 'first',
          'climbing', 'climbing', '2026-11-16T05:00:00Z', '2026-11-16T06:00:00Z', 'provider_offset', -420, NULL),
        (${randomUUID()}, ${visibleGroupId}, ${TEST_USER_ID}, 'activity-query-test', 'second',
          'climbing', 'climbing', '2026-11-16T05:10:00Z', '2026-11-16T05:50:00Z', 'provider_offset', -420, NULL),
        (${randomUUID()}, ${removedGroupId}, ${TEST_USER_ID}, 'activity-query-test', 'removed',
          'climbing', 'climbing', '2026-11-15T05:00:00Z', '2026-11-15T06:00:00Z', 'unknown', NULL, now()),
        (${randomUUID()}, ${otherUserGroupId}, ${otherUserId}, 'activity-query-test', 'other',
          'climbing', 'climbing', '2026-11-15T05:00:00Z', '2026-11-15T06:00:00Z', 'unknown', NULL, NULL)`);
  });
  afterAll(async () => {
    await context.cleanup();
  });

  it("resolves visible group IDs without hydrating recording provenance", async () => {
    const repository = new ActivityVisibilityRepository(context.db, TEST_USER_ID, "UTC");
    const { result, calls } = await countActivityOriginCalls(context, () =>
      repository.resolveVisibleActivityIds([
        visibleGroupId,
        visibleGroupId,
        removedGroupId,
        otherUserGroupId,
      ]),
    );
    expect(result).toEqual(new Set([visibleGroupId]));
    expect(calls).toBe(0);
  });

  it("filters canonical IDs by the source date and entitlement without hydrating provenance", async () => {
    const repository = new ActivityVisibilityRepository(context.db, TEST_USER_ID, "UTC", {
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: "2026-11-15",
      endDateExclusive: "2026-11-16",
    });
    const { result, calls } = await countActivityOriginCalls(context, () =>
      repository.filterToVisibleCanonicalActivities([
        { id: visibleGroupId },
        { id: removedGroupId },
        { id: otherUserGroupId },
      ]),
    );
    expect(result).toEqual([{ id: visibleGroupId }]);
    expect(calls).toBe(0);
  });

  it("lists the local-date range without hydrating provenance for historical groups", async () => {
    const repository = new ActivityVisibilityRepository(context.db, TEST_USER_ID, "UTC");
    const { result, calls } = await countActivityOriginCalls(context, () =>
      repository.listVisibleActivityIdsInRange("2026-11-15", "2026-11-16"),
    );
    expect(result).toEqual([visibleGroupId]);
    expect(calls).toBe(0);
  });
});
