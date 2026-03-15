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
      sql`INSERT INTO fitness.food_entry (
            user_id, provider_id, date, meal, food_name, calories, confirmed
          ) VALUES (
            ${DEFAULT_USER_ID}, ${DOFEK_PROVIDER_ID}, '2025-06-15'::date,
            'lunch', ${foodName}, 500, ${confirmed}
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
        sql`SELECT SUM(calories)::text as total FROM fitness.food_entry
            WHERE user_id = ${DEFAULT_USER_ID}
              AND confirmed = true`,
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
        sql`INSERT INTO fitness.food_entry (
              user_id, provider_id, date, meal, food_name, calories
            ) VALUES (
              ${DEFAULT_USER_ID}, ${DOFEK_PROVIDER_ID}, '2025-06-15'::date,
              'dinner', 'Web UI Entry', 400
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
