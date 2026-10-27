import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
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

async function insertUserFixture(name: string): Promise<string> {
  const id = randomUUID();
  await context.db.insert(userProfile).values({ id, name });
  return id;
}

async function insertBenchmarkFixture(id: string) {
  const [benchmark] = await context.db
    .insert(effortEquivalenceGroup)
    .values({
      userId: id,
      name: "Saturday benchmark",
      effortKind: "user_defined_benchmark",
    })
    .returning();
  if (!benchmark) throw new Error("Benchmark group insert did not return a row");
  return benchmark;
}

describe("effort equivalence groups", () => {
  beforeAll(async () => {
    context = await setupTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  beforeEach(async () => {
    userId = await insertUserFixture("Benchmark test user");
    activityGroupId = randomUUID();
  });

  it("stores a user-defined benchmark against a canonical activity group", async () => {
    const group = await insertActivityGroupFixture(context.db, userId, activityGroupId);
    const benchmark = await insertBenchmarkFixture(userId);

    const [member] = await context.db
      .insert(effortEquivalenceGroupMember)
      .values({
        groupId: benchmark.id,
        userId,
        canonicalActivityId: group.id,
        inclusionNote: "Saturday hill repeats",
      })
      .returning();
    if (!member) throw new Error("Benchmark member insert did not return a row");

    expect(benchmark.id).toMatch(/[0-9a-f-]{36}/);
    expect(
      await context.db
        .select({
          canonicalActivityId: effortEquivalenceGroupMember.canonicalActivityId,
          groupId: effortEquivalenceGroupMember.groupId,
          inclusionNote: effortEquivalenceGroupMember.inclusionNote,
          userId: effortEquivalenceGroupMember.userId,
        })
        .from(effortEquivalenceGroupMember)
        .where(eq(effortEquivalenceGroupMember.id, member.id)),
    ).toEqual([
      {
        canonicalActivityId: group.id,
        groupId: benchmark.id,
        inclusionNote: "Saturday hill repeats",
        userId,
      },
    ]);
  });

  it("rejects cross-user benchmark and canonical activity memberships", async () => {
    const otherUserId = await insertUserFixture("Other benchmark test user");
    const benchmark = await insertBenchmarkFixture(userId);
    const otherGroup = await insertActivityGroupFixture(context.db, otherUserId, randomUUID());

    await expect(
      context.db.insert(effortEquivalenceGroupMember).values({
        groupId: benchmark.id,
        userId: otherUserId,
        canonicalActivityId: otherGroup.id,
      }),
    ).rejects.toThrow();
    await expect(
      context.db.insert(effortEquivalenceGroupMember).values({
        groupId: benchmark.id,
        userId,
        canonicalActivityId: otherGroup.id,
      }),
    ).rejects.toThrow();
  });

  it("rejects memberships with nonexistent benchmark or canonical activity groups", async () => {
    const group = await insertActivityGroupFixture(context.db, userId, activityGroupId);
    const benchmark = await insertBenchmarkFixture(userId);

    await expect(
      context.db.insert(effortEquivalenceGroupMember).values({
        groupId: randomUUID(),
        userId,
        canonicalActivityId: group.id,
      }),
    ).rejects.toThrow();
    await expect(
      context.db.insert(effortEquivalenceGroupMember).values({
        groupId: benchmark.id,
        userId,
        canonicalActivityId: randomUUID(),
      }),
    ).rejects.toThrow();
  });

  it("rejects unsupported effort kinds", async () => {
    await expect(
      context.db.execute(sql`
        INSERT INTO fitness.effort_equivalence_group (user_id, display_name, effort_kind)
        VALUES (${userId}, 'Unsupported benchmark', 'provider_route')
      `),
    ).rejects.toThrow();
  });

  it("rejects duplicate benchmark members", async () => {
    const group = await insertActivityGroupFixture(context.db, userId, activityGroupId);
    const benchmark = await insertBenchmarkFixture(userId);
    const member = {
      groupId: benchmark.id,
      userId,
      canonicalActivityId: group.id,
    };

    await context.db.insert(effortEquivalenceGroupMember).values(member);
    await expect(context.db.insert(effortEquivalenceGroupMember).values(member)).rejects.toThrow();
  });

  it("rejects members missing required references", async () => {
    await expect(
      context.db.execute(sql`
        INSERT INTO fitness.effort_equivalence_group_member (user_id)
        VALUES (${userId})
      `),
    ).rejects.toThrow();
  });

  it("cascades benchmark deletion while retaining referenced canonical activities", async () => {
    const group = await insertActivityGroupFixture(context.db, userId, activityGroupId);
    const benchmark = await insertBenchmarkFixture(userId);
    await context.db.insert(effortEquivalenceGroupMember).values({
      groupId: benchmark.id,
      userId,
      canonicalActivityId: group.id,
    });

    await expect(
      context.db.delete(activityGroup).where(eq(activityGroup.id, group.id)),
    ).rejects.toThrow();

    await context.db
      .delete(effortEquivalenceGroup)
      .where(eq(effortEquivalenceGroup.id, benchmark.id));

    expect(
      await context.db
        .select({ id: effortEquivalenceGroupMember.id })
        .from(effortEquivalenceGroupMember)
        .where(eq(effortEquivalenceGroupMember.groupId, benchmark.id)),
    ).toEqual([]);
    expect(
      await context.db
        .select({ id: activityGroup.id })
        .from(activityGroup)
        .where(eq(activityGroup.id, group.id)),
    ).toEqual([{ id: group.id }]);
  });
});
