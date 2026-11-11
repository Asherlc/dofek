import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  assertPostgresAccountErasureCoverage,
  erasePostgresAccount,
} from "../../../../src/account-erasure/postgres-erasure.ts";
import {
  persistClimbingLogEntries,
  type SourceClimbingLogEntry,
} from "../../../../src/db/climbing-log-sync.ts";
import {
  clearClimbingLogSyncTestContext,
  createClimbingLogSyncTestContext,
  CLIMBING_SYNC_OTHER_PROVIDER_ID as otherProviderId,
  CLIMBING_SYNC_OTHER_USER_ID as otherUserId,
  CLIMBING_SYNC_PROVIDER_ID as providerId,
} from "../../../../src/db/climbing-log-sync-test-helpers.ts";
import { area } from "../../../../src/db/schema/climbing.ts";
import { TEST_USER_ID as userId } from "../../../../src/db/schema/core.ts";
import type { TestContext } from "../../../../src/db/test-helpers.ts";
import { executeWithSchema } from "../../../../src/db/typed-sql.ts";
import { ClimbingActivityLogEntryRepository } from "./climbing-activity-log-entry-repository.ts";

describe("explicit climbing area groups", () => {
  let context: TestContext;
  beforeAll(async () => {
    context = await createClimbingLogSyncTestContext();
  });
  afterEach(async () => {
    await clearClimbingLogSyncTestContext(context);
    await context.db.execute(sql`DELETE FROM fitness.area_group`);
  });
  afterAll(async () => {
    await context.cleanup();
  });

  const entry = (name: string): SourceClimbingLogEntry => ({
    externalId: "log",
    climbedOn: "2026-11-09",
    climb: { externalId: "problem", name: "Problem", areas: [{ externalId: "gym", name }] },
    attempts: [{ scope: "climb" }],
  });
  const write = (provider: string, source: SourceClimbingLogEntry, owner = userId) =>
    persistClimbingLogEntries(context.db, {
      userId: owner,
      providerId: provider,
      entries: [source],
    });
  async function makeGroup(owner = userId) {
    const id = randomUUID();
    await context.db.execute(
      sql`INSERT INTO fitness.area_group(id, user_id) VALUES (${id}::uuid, ${owner}::uuid)`,
    );
    return id;
  }
  const repository = () => new ClimbingActivityLogEntryRepository(context.db, userId, "UTC");

  it("retains a shared identity and source names through resync and a rename", async () => {
    await write(providerId, entry("Touchstone Great Western Power Company"));
    await write(otherProviderId, entry("Great Western Power Company"));
    const groupId = await makeGroup();
    await context.db.execute(
      sql`UPDATE fitness.area SET group_id=${groupId}::uuid WHERE user_id=${userId}::uuid`,
    );
    const before = await repository().getUnattachedLogEntriesForDate("2026-11-09");
    expect(before).toHaveLength(2);
    expect(before).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId,
          areaGroupId: groupId,
          areaPath: [expect.objectContaining({ name: "Touchstone Great Western Power Company" })],
        }),
        expect.objectContaining({
          providerId: otherProviderId,
          areaGroupId: groupId,
          areaPath: [expect.objectContaining({ name: "Great Western Power Company" })],
        }),
      ]),
    );
    await write(providerId, entry("A renamed gym"));
    const after = await repository().getUnattachedLogEntriesForDate("2026-11-09");
    expect(after.map((log) => log.id).sort()).toEqual(before.map((log) => log.id).sort());
    expect(after.every((log) => log.areaGroupId === groupId)).toBe(true);
    expect(after.find((log) => log.providerId === providerId)?.areaPath?.[0]?.name).toBe(
      "A renamed gym",
    );
  });

  it("uses the log's recorded area membership before its catalogue area", async () => {
    const source = {
      ...entry("Catalogue gym"),
      areas: [{ externalId: "logged-gym", name: "Recorded gym" }],
    };
    await write(providerId, source);
    const catalogueGroup = await makeGroup();
    const recordedGroup = await makeGroup();
    await context.db.execute(
      sql`UPDATE fitness.area SET group_id=CASE WHEN external_id='gym' THEN ${catalogueGroup}::uuid ELSE ${recordedGroup}::uuid END WHERE user_id=${userId}::uuid`,
    );
    const [log] = await repository().getUnattachedLogEntriesForDate("2026-11-09");
    expect(log).toMatchObject({
      areaGroupId: recordedGroup,
      areaPath: [expect.objectContaining({ name: "Recorded gym" })],
      climb: { areaPath: [expect.objectContaining({ name: "Catalogue gym" })] },
    });
  });

  it("rejects assigning another owner's group", async () => {
    await write(providerId, entry("Owner's gym"));
    const groupId = await makeGroup(otherUserId);
    await expect(
      context.db.execute(
        sql`UPDATE fitness.area SET group_id=${groupId}::uuid WHERE user_id=${userId}::uuid`,
      ),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("fences and erases group ownership while preserving another owner's group", async () => {
    await write(providerId, entry("Other owner's gym"), otherUserId);
    const otherGroup = await makeGroup(otherUserId);
    const retainedGroup = await makeGroup();
    await context.db.execute(
      sql`UPDATE fitness.area SET group_id=${otherGroup}::uuid WHERE user_id=${otherUserId}::uuid`,
    );
    await expect(assertPostgresAccountErasureCoverage(context.db)).resolves.toBeUndefined();
    const requestId = randomUUID();
    await context.db.execute(
      sql`INSERT INTO fitness.account_erasure_request(id,user_id,user_hash,user_hash_key_id,write_fence_hash,status_token_hash,replay_retained_until,completion_deadline) VALUES(${requestId}::uuid,${otherUserId}::uuid,${"1".repeat(64)},'test-key',${"2".repeat(64)},${"3".repeat(64)},now()+interval '7 days',now()+interval '30 days')`,
    );
    await expect(makeGroup(otherUserId)).rejects.toMatchObject({ cause: { code: "55000" } });
    await erasePostgresAccount(context.db, requestId, otherUserId);
    expect(await context.db.select().from(area).where(eq(area.userId, otherUserId))).toEqual([]);
    expect(
      await executeWithSchema(
        context.db,
        z.object({ id: z.guid() }),
        sql`SELECT id FROM fitness.area_group`,
      ),
    ).toEqual([{ id: retainedGroup }]);
  });
});
