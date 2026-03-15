import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupTestDatabase,
  type TestContext,
} from "../../../../../src/db/__tests__/test-helpers.ts";

// We can't directly import the non-exported functions from bot.ts,
// so we test them via the module's exported API + direct DB queries.
// For the pure helper functions, we replicate and test the logic.

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
      const block = rawBlock as {
        type?: string;
        elements?: Array<{ action_id?: string; value?: string }>;
      };
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
