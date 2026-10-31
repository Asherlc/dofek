import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activity } from "../../db/schema/activity.ts";
import { climbingAttempt, climbingLogEntry } from "../../db/schema/climbing.ts";
import { TEST_USER_ID } from "../../db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../db/test-helpers.ts";
import { eightAHeader, eightARow } from "../climbing-file-test-helpers.ts";
import { importEightAExportFile } from "./provider.ts";

describe("8a.nu file import persistence", () => {
  let context: TestContext;
  beforeAll(async () => {
    context = await setupTestDatabase();
  });
  afterAll(async () => {
    await context.cleanup();
  });
  it("keeps source occurrences idempotent/additive and preserves an attached activity", async () => {
    const first = eightARow({ type: "f", tries: "1" });
    const duplicate = eightARow({ type: "rp", tries: "0" });
    expect(
      await importEightAExportFile(
        context.db,
        `${eightAHeader}\n${first}\n${duplicate}\n${duplicate}`,
        TEST_USER_ID,
      ),
    ).toMatchObject({ recordsSynced: 3, errors: [] });
    const original = await context.db
      .select()
      .from(climbingLogEntry)
      .where(eq(climbingLogEntry.providerId, "eight-a"));
    const entry = original.find((log) => log.raw && JSON.stringify(log.raw).includes('"f"'));
    if (!entry) throw new Error("Expected imported flash");
    const [attached] = await context.db
      .insert(activity)
      .values({
        userId: TEST_USER_ID,
        providerId: "eight-a",
        externalId: "test-attachment",
        canonicalType: "climbing",
        providerType: "test",
        startedAt: new Date("2026-09-01T12:00:00Z"),
      })
      .returning();
    if (!attached) throw new Error("Expected attachment activity");
    await context.db
      .update(climbingLogEntry)
      .set({ activityId: attached.id })
      .where(eq(climbingLogEntry.id, entry.id));
    await importEightAExportFile(
      context.db,
      `${eightAHeader}\n${duplicate}\n${first}\n${duplicate}`,
      TEST_USER_ID,
    );
    await importEightAExportFile(context.db, `${eightAHeader}\n${first}`, TEST_USER_ID);
    const saved = await context.db
      .select()
      .from(climbingLogEntry)
      .where(eq(climbingLogEntry.providerId, "eight-a"));
    expect(saved).toHaveLength(3);
    expect(saved.find((log) => log.id === entry.id)).toMatchObject({
      activityId: attached.id,
      providerAbsentAt: null,
    });
    const attempts = await context.db
      .select()
      .from(climbingAttempt)
      .where(eq(climbingAttempt.climbingLogEntryId, entry.id));
    expect(attempts).toEqual([expect.objectContaining({ sourceResult: "f" })]);
    expect(
      await context.db.select().from(activity).where(eq(activity.providerId, "eight-a")),
    ).toHaveLength(1);
  });
});
