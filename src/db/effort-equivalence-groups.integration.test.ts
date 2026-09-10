import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityGroup,
  effortEquivalenceGroup,
  effortEquivalenceGroupMember,
} from "./schema/activity.ts";
import { userProfile } from "./schema/reference.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

let context: TestContext;
let userId: string;
let activityGroupId: string;

async function insertActivityGroupFixture(db: TestContext["db"], id: string, groupId: string) {
  const [group] = await db.insert(activityGroup).values({ id: groupId, userId: id }).returning();
  if (!group) throw new Error("Activity group insert did not return a row");
  return group;
}

describe("effort equivalence groups", () => {
  beforeAll(async () => {
    context = await setupTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  beforeEach(async () => {
    userId = randomUUID();
    activityGroupId = randomUUID();
    await context.db.insert(userProfile).values({
      id: userId,
      name: "Benchmark test user",
    });
  });

  it("stores a user-defined benchmark against a canonical activity group", async () => {
    const group = await insertActivityGroupFixture(context.db, userId, activityGroupId);
    const [benchmark] = await context.db
      .insert(effortEquivalenceGroup)
      .values({
        userId,
        name: "Saturday benchmark",
        effortKind: "user_defined_benchmark",
      })
      .returning();
    if (!benchmark) throw new Error("Benchmark group insert did not return a row");

    await context.db.insert(effortEquivalenceGroupMember).values({
      groupId: benchmark.id,
      userId,
      canonicalActivityId: group.id,
    });

    expect(benchmark.id).toMatch(/[0-9a-f-]{36}/);
  });
});
