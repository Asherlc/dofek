import { describe, expect, it } from "vitest";
import { drizzleSchema } from "./drizzle-schema.ts";
import { userSettings } from "./schema/account.ts";
import { activity } from "./schema/activity.ts";
import { labResult } from "./schema/clinical.ts";
import { TEST_USER_ID } from "./schema/core.ts";
import { activityTypeEnum } from "./schema/enums.ts";
import { journalEntry } from "./schema/events.ts";
import { foodEntry } from "./schema/nutrition.ts";
import { provider } from "./schema/reference.ts";

describe("drizzleSchema", () => {
  it("aggregates all database schema modules", () => {
    expect(drizzleSchema).toMatchObject({
      TEST_USER_ID,
      activityTypeEnum,
      provider,
      activity,
      foodEntry,
      labResult,
      userSettings,
      journalEntry,
    });
  });
});
