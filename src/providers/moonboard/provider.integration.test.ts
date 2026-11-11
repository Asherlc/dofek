import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { climbingAttempt, climbingLogEntry } from "../../db/schema/climbing.ts";
import { TEST_USER_ID } from "../../db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../db/test-helpers.ts";
import { moonBoardHeader, moonBoardRow } from "../climbing-file-test-helpers.ts";
import { importMoonBoardExportFile } from "./provider.ts";

describe("historical MoonBoard BoardLib file persistence", () => {
  let context: TestContext;
  beforeAll(async () => {
    context = await setupTestDatabase();
  });
  afterAll(async () => {
    await context.cleanup();
  });
  it("preserves an explicit completion on only the described attempt", async () => {
    const csv = `${moonBoardHeader}\n${moonBoardRow({ tries: "3", is_ascent: "True" })}`;
    expect(await importMoonBoardExportFile(context.db, csv, TEST_USER_ID)).toMatchObject({
      recordsSynced: 1,
      errors: [],
    });
    await importMoonBoardExportFile(context.db, csv, TEST_USER_ID);
    const logs = await context.db
      .select()
      .from(climbingLogEntry)
      .where(eq(climbingLogEntry.providerId, "moonboard"));
    expect(logs).toHaveLength(1);
    const attempts = await context.db
      .select()
      .from(climbingAttempt)
      .where(eq(climbingAttempt.climbingLogEntryId, logs[0]?.id ?? ""));
    expect(attempts).toHaveLength(3);
    expect(attempts.filter((attempt) => attempt.sourceCompleted === true)).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.sourceCompleted === null)).toHaveLength(2);
    await importMoonBoardExportFile(context.db, moonBoardHeader, TEST_USER_ID);
    expect(
      await context.db
        .select()
        .from(climbingLogEntry)
        .where(eq(climbingLogEntry.providerId, "moonboard")),
    ).toMatchObject([{ id: logs[0]?.id, providerAbsentAt: null }]);
  });
});
