import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";

const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";
const DOFEK_PROVIDER_ID = "dofek";

/** Build a SQL `IN (...)` clause from an array of UUID strings */
function sqlIdList(ids: string[]) {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}

describe("Slack food entry confirmed flag", () => {
  let testCtx: TestContext;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    // Ensure the dofek provider exists
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name)
          VALUES (${DOFEK_PROVIDER_ID}, 'Dofek App')
          ON CONFLICT (id) DO NOTHING`,
    );
  }, 60_000);

  afterAll(async () => {
    await testCtx?.cleanup();
  });

  beforeEach(async () => {
    await testCtx.db.execute(
      sql`DELETE FROM fitness.food_entry WHERE user_id = ${DEFAULT_USER_ID}`,
    );
  });

  /** Insert a food entry with the given confirmed status, return its id */
  async function insertEntry(confirmed: boolean, foodName = "Test Food"): Promise<string> {
    const rows = await testCtx.db.execute<{ id: string }>(
      sql`WITH nd AS (
            INSERT INTO fitness.nutrition_data (calories)
            VALUES (500)
            RETURNING id
          )
          INSERT INTO fitness.food_entry (
            user_id, provider_id, date, meal, food_name, nutrition_data_id, confirmed
          ) VALUES (
            ${DEFAULT_USER_ID}, ${DOFEK_PROVIDER_ID}, '2025-06-15'::date,
            'lunch', ${foodName}, (SELECT id FROM nd), ${confirmed}
          ) RETURNING id`,
    );
    const row = rows[0];
    if (!row) throw new Error("Insert failed");
    return row.id;
  }

  describe("unconfirmed entries are hidden from queries", () => {
    it("SELECT * with confirmed=true filter excludes unconfirmed rows", async () => {
      await insertEntry(false, "Unconfirmed Burrito");
      await insertEntry(true, "Confirmed Salad");

      const rows = await testCtx.db.execute<{ food_name: string }>(
        sql`SELECT food_name FROM fitness.food_entry
            WHERE user_id = ${DEFAULT_USER_ID}
              AND confirmed = true`,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.food_name).toBe("Confirmed Salad");
    });

    it("SUM aggregation excludes unconfirmed rows", async () => {
      await insertEntry(false, "Unconfirmed 500cal");
      await insertEntry(true, "Confirmed 500cal");

      const rows = await testCtx.db.execute<{ total: string }>(
        sql`SELECT SUM(nd.calories)::text as total
            FROM fitness.food_entry fe
            JOIN fitness.nutrition_data nd ON nd.id = fe.nutrition_data_id
            WHERE fe.user_id = ${DEFAULT_USER_ID}
              AND fe.confirmed = true`,
      );

      expect(Number(rows[0]?.total)).toBe(500);
    });

    it("search (ILIKE) excludes unconfirmed rows", async () => {
      await insertEntry(false, "Unconfirmed Pizza");
      await insertEntry(true, "Confirmed Pizza");

      const rows = await testCtx.db.execute<{ food_name: string }>(
        sql`SELECT food_name FROM fitness.food_entry
            WHERE user_id = ${DEFAULT_USER_ID}
              AND confirmed = true
              AND food_name ILIKE '%Pizza%'`,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.food_name).toBe("Confirmed Pizza");
    });
  });

  describe("confirm flow", () => {
    it("flips confirmed from false to true", async () => {
      const id = await insertEntry(false);

      const updated = await testCtx.db.execute<{ id: string }>(
        sql`UPDATE fitness.food_entry
            SET confirmed = true
            WHERE id = ${id} AND confirmed = false
            RETURNING id`,
      );

      expect(updated).toHaveLength(1);

      // Now visible in confirmed queries
      const rows = await testCtx.db.execute<{ id: string }>(
        sql`SELECT id FROM fitness.food_entry
            WHERE user_id = ${DEFAULT_USER_ID} AND confirmed = true`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(id);
    });

    it("confirming an already-confirmed entry returns 0 rows", async () => {
      const id = await insertEntry(true);

      const updated = await testCtx.db.execute<{ id: string }>(
        sql`UPDATE fitness.food_entry
            SET confirmed = true
            WHERE id = ${id} AND confirmed = false
            RETURNING id`,
      );

      expect(updated).toHaveLength(0);
    });

    it("confirms multiple entries at once in batch", async () => {
      const id1 = await insertEntry(false, "Item 1");
      const id2 = await insertEntry(false, "Item 2");
      const id3 = await insertEntry(false, "Item 3");

      const updated = await testCtx.db.execute<{ id: string }>(
        sql`UPDATE fitness.food_entry
            SET confirmed = true
            WHERE id IN (${sqlIdList([id1, id2, id3])})
              AND confirmed = false
            RETURNING id`,
      );

      expect(updated).toHaveLength(3);

      const visible = await testCtx.db.execute(
        sql`SELECT id FROM fitness.food_entry
            WHERE user_id = ${DEFAULT_USER_ID} AND confirmed = true`,
      );
      expect(visible).toHaveLength(3);
    });
  });

  describe("cancel flow", () => {
    it("deletes unconfirmed entries", async () => {
      const id = await insertEntry(false);

      await testCtx.db.execute(
        sql`DELETE FROM fitness.food_entry
            WHERE id = ${id} AND confirmed = false`,
      );

      const rows = await testCtx.db.execute(
        sql`SELECT id FROM fitness.food_entry WHERE id = ${id}`,
      );
      expect(rows).toHaveLength(0);
    });

    it("does not delete confirmed entries", async () => {
      const id = await insertEntry(true);

      await testCtx.db.execute(
        sql`DELETE FROM fitness.food_entry
            WHERE id = ${id} AND confirmed = false`,
      );

      // Still exists
      const rows = await testCtx.db.execute(
        sql`SELECT id FROM fitness.food_entry WHERE id = ${id}`,
      );
      expect(rows).toHaveLength(1);
    });

    it("deletes multiple unconfirmed entries in batch", async () => {
      const id1 = await insertEntry(false, "Cancel 1");
      const id2 = await insertEntry(false, "Cancel 2");
      const confirmedId = await insertEntry(true, "Keep This");

      await testCtx.db.execute(
        sql`DELETE FROM fitness.food_entry
            WHERE id IN (${sqlIdList([id1, id2, confirmedId])})
              AND confirmed = false`,
      );

      const remaining = await testCtx.db.execute<{ food_name: string }>(
        sql`SELECT food_name FROM fitness.food_entry
            WHERE user_id = ${DEFAULT_USER_ID}`,
      );
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.food_name).toBe("Keep This");
    });
  });

  describe("refinement flow", () => {
    it("deletes old unconfirmed entries and saves new ones", async () => {
      // Initial parse: save 2 unconfirmed entries
      const oldId1 = await insertEntry(false, "Old Item 1");
      const oldId2 = await insertEntry(false, "Old Item 2");

      // Refinement: delete old, save new
      await testCtx.db.execute(
        sql`DELETE FROM fitness.food_entry
            WHERE id IN (${sqlIdList([oldId1, oldId2])})
              AND confirmed = false`,
      );

      const newId = await insertEntry(false, "Refined Item");

      // Old entries gone
      const oldRows = await testCtx.db.execute(
        sql`SELECT id FROM fitness.food_entry
            WHERE id IN (${sqlIdList([oldId1, oldId2])})`,
      );
      expect(oldRows).toHaveLength(0);

      // New entry exists
      const newRows = await testCtx.db.execute<{ food_name: string }>(
        sql`SELECT food_name FROM fitness.food_entry WHERE id = ${newId}`,
      );
      expect(newRows).toHaveLength(1);
      expect(newRows[0]?.food_name).toBe("Refined Item");
    });
  });

  describe("default confirmed value", () => {
    it("defaults to true when not specified (web UI / provider sync path)", async () => {
      const rows = await testCtx.db.execute<{ id: string; confirmed: boolean }>(
        sql`WITH nd AS (
              INSERT INTO fitness.nutrition_data (calories)
              VALUES (400)
              RETURNING id
            )
            INSERT INTO fitness.food_entry (
              user_id, provider_id, date, meal, food_name, nutrition_data_id
            ) VALUES (
              ${DEFAULT_USER_ID}, ${DOFEK_PROVIDER_ID}, '2025-06-15'::date,
              'dinner', 'Web UI Entry', (SELECT id FROM nd)
            ) RETURNING id, confirmed`,
      );

      expect(rows[0]?.confirmed).toBe(true);
    });
  });

  describe("update and delete respect confirmed flag", () => {
    it("UPDATE only affects confirmed entries", async () => {
      const unconfirmedId = await insertEntry(false, "Unconfirmed");
      const confirmedId = await insertEntry(true, "Confirmed");

      // Try to update both with confirmed=true filter
      const updated1 = await testCtx.db.execute<{ id: string }>(
        sql`UPDATE fitness.food_entry
            SET food_name = 'Updated'
            WHERE user_id = ${DEFAULT_USER_ID}
              AND confirmed = true
              AND id = ${unconfirmedId}
            RETURNING id`,
      );
      expect(updated1).toHaveLength(0);

      const updated2 = await testCtx.db.execute<{ id: string }>(
        sql`UPDATE fitness.food_entry
            SET food_name = 'Updated'
            WHERE user_id = ${DEFAULT_USER_ID}
              AND confirmed = true
              AND id = ${confirmedId}
            RETURNING id`,
      );
      expect(updated2).toHaveLength(1);
    });

    it("DELETE only affects confirmed entries when filter is applied", async () => {
      const unconfirmedId = await insertEntry(false, "Unconfirmed");
      const confirmedId = await insertEntry(true, "Confirmed");

      // Delete with confirmed=true filter (web UI delete path)
      await testCtx.db.execute(
        sql`DELETE FROM fitness.food_entry
            WHERE user_id = ${DEFAULT_USER_ID}
              AND confirmed = true
              AND id = ${confirmedId}`,
      );

      // Confirmed entry deleted
      const confirmedRows = await testCtx.db.execute(
        sql`SELECT id FROM fitness.food_entry WHERE id = ${confirmedId}`,
      );
      expect(confirmedRows).toHaveLength(0);

      // Unconfirmed entry still exists
      const unconfirmedRows = await testCtx.db.execute(
        sql`SELECT id FROM fitness.food_entry WHERE id = ${unconfirmedId}`,
      );
      expect(unconfirmedRows).toHaveLength(1);
    });
  });
});

// ============================================================
// Pure helper function tests (no DB needed)
// ============================================================

/** Replicate extractEntryIdsFromThread for unit testing since it's not exported */
function extractEntryIdsFromThread(
  messages: Array<{ bot_id?: string; blocks?: unknown[] }>,
): string[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const threadMsg = messages[i];
    if (!threadMsg || !threadMsg.bot_id || !threadMsg.blocks) continue;

    for (const rawBlock of threadMsg.blocks) {
      const block: {
        type?: string;
        elements?: Array<{ action_id?: string; value?: string }>;
      } = rawBlock;
      if (block.type !== "actions" || !block.elements) continue;
      for (const element of block.elements) {
        if (element.action_id === "confirm_food" && element.value) {
          const ids = element.value.split(",").filter(Boolean);
          if (ids.length > 0) return ids;
        }
      }
    }
  }
  return null;
}

/** Replicate slackTimestampToLocalTime for unit testing */
function slackTimestampToLocalTime(slackTs: string, timezone: string): string {
  const epochSeconds = Number.parseFloat(slackTs);
  const date = new Date(epochSeconds * 1000);
  return date.toLocaleString("en-US", {
    timeZone: timezone,
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** Replicate slackTimestampToDateString for unit testing */
function slackTimestampToDateString(slackTs: string, timezone: string): string {
  const epochSeconds = Number.parseFloat(slackTs);
  const date = new Date(epochSeconds * 1000);
  return date.toLocaleDateString("en-CA", { timeZone: timezone });
}

describe("Slack Bot — pure helpers", () => {
  describe("extractEntryIdsFromThread", () => {
    it("extracts entry IDs from a bot message with confirm button", () => {
      const messages = [
        { bot_id: undefined },
        {
          bot_id: "B123",
          blocks: [
            {
              type: "actions",
              elements: [
                { action_id: "confirm_food", value: "id-1,id-2,id-3" },
                { action_id: "cancel_food" },
              ],
            },
          ],
        },
      ];
      const ids = extractEntryIdsFromThread(messages);
      expect(ids).toEqual(["id-1", "id-2", "id-3"]);
    });

    it("returns null when no bot messages have confirm buttons", () => {
      const messages = [{ bot_id: undefined }, { bot_id: "B123", blocks: [{ type: "section" }] }];
      expect(extractEntryIdsFromThread(messages)).toBeNull();
    });

    it("returns null for empty messages array", () => {
      expect(extractEntryIdsFromThread([])).toBeNull();
    });

    it("walks backwards and finds the most recent confirm button", () => {
      const messages = [
        {
          bot_id: "B123",
          blocks: [
            {
              type: "actions",
              elements: [{ action_id: "confirm_food", value: "old-id" }],
            },
          ],
        },
        { bot_id: undefined }, // user message
        {
          bot_id: "B123",
          blocks: [
            {
              type: "actions",
              elements: [{ action_id: "confirm_food", value: "new-id" }],
            },
          ],
        },
      ];
      const ids = extractEntryIdsFromThread(messages);
      expect(ids).toEqual(["new-id"]);
    });

    it("skips messages without blocks", () => {
      const messages = [
        { bot_id: "B123" }, // no blocks
      ];
      expect(extractEntryIdsFromThread(messages)).toBeNull();
    });

    it("skips non-actions blocks", () => {
      const messages = [
        {
          bot_id: "B123",
          blocks: [{ type: "section", elements: [{ action_id: "confirm_food", value: "id-1" }] }],
        },
      ];
      expect(extractEntryIdsFromThread(messages)).toBeNull();
    });
  });

  describe("slackTimestampToLocalTime", () => {
    it("converts Slack epoch to readable local time", () => {
      // 2026-02-28T12:00:00Z = Saturday in Eastern time
      const ts = "1772280000.000000";
      const result = slackTimestampToLocalTime(ts, "America/New_York");
      expect(result).toContain("Saturday");
      expect(result).toMatch(/\d{1,2}:\d{2}\s*(AM|PM)/);
    });

    it("handles different timezones", () => {
      const ts = "1772280000.000000";
      const utcResult = slackTimestampToLocalTime(ts, "UTC");
      const tokyoResult = slackTimestampToLocalTime(ts, "Asia/Tokyo");
      // Different timezones should produce different times
      expect(utcResult).not.toBe(tokyoResult);
    });
  });

  describe("slackTimestampToDateString", () => {
    it("converts Slack epoch to YYYY-MM-DD date string", () => {
      // 2026-02-28T12:00:00Z
      const ts = "1772280000.000000";
      const result = slackTimestampToDateString(ts, "UTC");
      expect(result).toBe("2026-02-28");
    });

    it("respects timezone for date boundary", () => {
      // 2026-03-15T23:00:00 UTC = 1773615600
      // In Tokyo (UTC+9) this is 2026-03-16T08:00:00
      const ts = "1773615600.000000";
      const utcResult = slackTimestampToDateString(ts, "UTC");
      const tokyoResult = slackTimestampToDateString(ts, "Asia/Tokyo");
      expect(utcResult).toBe("2026-03-15");
      expect(tokyoResult).toBe("2026-03-16");
    });
  });
});

// ============================================================
// Database integration tests for resolveOrCreateUserId / lookupOrCreateUserId
// ============================================================

describe("Slack Bot — user resolution (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await ctx?.cleanup();
  });

  /** Helper to create a user_profile row */
  async function createUserProfile(name: string, email: string | null = null): Promise<string> {
    const rows = await ctx.db.execute<{ id: string }>(
      sql`INSERT INTO fitness.user_profile (name, email) VALUES (${name}, ${email}) RETURNING id`,
    );
    const row = rows[0];
    if (!row) throw new Error("Failed to create user profile");
    return row.id;
  }

  /** Helper to create an auth_account row */
  async function createAuthAccount(
    userId: string,
    provider: string,
    providerAccountId: string,
    email: string | null = null,
  ): Promise<void> {
    await ctx.db.execute(
      sql`INSERT INTO fitness.auth_account (user_id, auth_provider, provider_account_id, name, email)
          VALUES (${userId}, ${provider}, ${providerAccountId}, 'Test User', ${email})`,
    );
  }

  /** Helper: simulate resolveOrCreateUserId by querying auth_account and user_profile */
  async function resolveOrCreateUserId(email: string | null, name: string): Promise<string> {
    if (email) {
      // Check auth_account first
      const existingByAuthEmail = await ctx.db.execute<{ user_id: string }>(
        sql`SELECT user_id FROM fitness.auth_account WHERE email = ${email} LIMIT 1`,
      );
      const authRow = existingByAuthEmail[0];
      if (authRow) return authRow.user_id;

      // Check user_profile.email
      const existingByProfileEmail = await ctx.db.execute<{ id: string }>(
        sql`SELECT id FROM fitness.user_profile WHERE email = ${email} LIMIT 1`,
      );
      const profileRow = existingByProfileEmail[0];
      if (profileRow) return profileRow.id;
    }

    // Fallback: if exactly one user, use that
    const userCount = await ctx.db.execute<{ count: string; id: string }>(
      sql`SELECT COUNT(*)::text AS count, MIN(id::text)::uuid AS id FROM fitness.user_profile`,
    );
    const countRow = userCount[0];
    if (countRow && parseInt(countRow.count, 10) === 1) {
      return countRow.id;
    }

    // Create new user
    const newUser = await ctx.db.execute<{ id: string }>(
      sql`INSERT INTO fitness.user_profile (name, email) VALUES (${name}, ${email}) RETURNING id`,
    );
    const newUserRow = newUser[0];
    if (!newUserRow) throw new Error("Failed to create user profile");
    return newUserRow.id;
  }

  it("resolves user by auth_account email", async () => {
    const userId = await createUserProfile("Auth User", "auth@test.com");
    await createAuthAccount(userId, "google", "google-123", "auth@test.com");

    const resolved = await resolveOrCreateUserId("auth@test.com", "Slack User");
    expect(resolved).toBe(userId);
  });

  it("resolves user by user_profile email", async () => {
    const userId = await createUserProfile("Profile User", "profile@test.com");

    const resolved = await resolveOrCreateUserId("profile@test.com", "Slack User");
    expect(resolved).toBe(userId);
  });

  it("falls back to sole user when no email match and single user exists (MIN uuid regression)", async () => {
    // Ensure exactly one user — exercises the MIN(id::text)::uuid query path
    // which previously failed because PostgreSQL has no min() aggregate for uuid
    await ctx.db.execute(sql`TRUNCATE fitness.user_profile CASCADE`);

    const userId = await createUserProfile("Sole User");

    const resolved = await resolveOrCreateUserId(null, "Unknown Slack User");
    expect(resolved).toBe(userId);
  });

  it("creates new user when email doesn't match and multiple users exist", async () => {
    // Ensure at least 2 users exist so the single-user fallback doesn't trigger
    await createUserProfile("User A", "a@test.com");
    await createUserProfile("User B", "b@test.com");

    const resolved = await resolveOrCreateUserId("unknown@test.com", "New Slack User");
    // Should be a new user ID (not matching existing ones)
    expect(resolved).toBeDefined();

    // Verify the new user was created
    const rows = await ctx.db.execute<{ name: string }>(
      sql`SELECT name FROM fitness.user_profile WHERE id = ${resolved}`,
    );
    expect(rows[0]?.name).toBe("New Slack User");
  });
});
