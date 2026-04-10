import type { Database } from "dofek/db";
import { NUTRIENT_SQL_COLUMNS } from "dofek/db/nutrient-columns";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { NutritionItemWithMeal } from "../lib/ai-nutrition.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";

export const slackBlockSchema = z.object({
  type: z.string().optional(),
  elements: z
    .array(
      z.object({
        action_id: z.string().optional(),
        value: z.string().optional(),
      }),
    )
    .optional(),
});

export const mealSchema = z.enum(["breakfast", "lunch", "dinner", "snack", "other"]).catch("other");
export const categorySchema = z
  .enum([
    "beans_and_legumes",
    "beverages",
    "breads_and_cereals",
    "cheese_milk_and_dairy",
    "eggs",
    "fast_food",
    "fish_and_seafood",
    "fruit",
    "meat",
    "nuts_and_seeds",
    "pasta_rice_and_noodles",
    "salads",
    "sauces_spices_and_spreads",
    "snacks",
    "soups",
    "sweets_candy_and_desserts",
    "vegetables",
    "supplement",
    "other",
  ])
  .catch("other");

const DOFEK_PROVIDER_ID = "dofek";

export const FALLBACK_TIMEZONE = process.env.TIMEZONE ?? "America/Los_Angeles";

/** Build a SQL `IN (...)` clause from an array of UUID strings */
export function sqlIdList(ids: string[]) {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}

export interface SlackUserInfo {
  userId: string;
  timezone: string;
}

/** Convert a Slack epoch timestamp to a readable local time string using the user's timezone */
export function slackTimestampToLocalTime(slackTs: string, timezone: string): string {
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

/** Convert a Slack epoch timestamp to YYYY-MM-DD date string in the user's timezone */
export function slackTimestampToDateString(slackTs: string, timezone: string): string {
  const epochSeconds = Number.parseFloat(slackTs);
  const date = new Date(epochSeconds * 1000);
  return date.toLocaleDateString("en-CA", { timeZone: timezone });
}

/**
 * Extract food entry IDs from thread messages returned by conversations.replies.
 * Walks backwards to find the most recent bot message with a confirm button.
 * The button value contains comma-separated food_entry UUIDs.
 */
export function extractEntryIdsFromThread(
  messages: Array<{ bot_id?: string; blocks?: unknown[] }>,
): string[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const threadMsg = messages[i];
    if (!threadMsg || !threadMsg.bot_id || !threadMsg.blocks) continue;

    for (const rawBlock of threadMsg.blocks) {
      const parsed = slackBlockSchema.safeParse(rawBlock);
      if (!parsed.success) continue;
      const block = parsed.data;
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

export interface SlackClient {
  users: {
    info: (args: {
      user: string;
    }) => Promise<{ user?: { tz?: string; real_name?: string; profile?: { email?: string } } }>;
  };
}

/**
 * Encapsulates all database operations for the Slack bot's food tracking workflow:
 * user resolution, food entry CRUD, and cache invalidation.
 */
export class FoodEntryRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Find an existing user by email. Throws if no match is found. */
  async resolveUserByEmail(email: string | null): Promise<string> {
    if (email) {
      const existingByAuthEmail = await executeWithSchema(
        this.#db,
        z.object({ user_id: z.string() }),
        sql`SELECT user_id FROM fitness.auth_account
            WHERE LOWER(email) = LOWER(${email})
            LIMIT 1`,
      );
      const authRow = existingByAuthEmail[0];
      if (authRow) {
        logger.info(
          `[slack] Found existing user ${authRow.user_id} via auth_account email ${email}`,
        );
        return authRow.user_id;
      }

      const existingByProfileEmail = await executeWithSchema(
        this.#db,
        z.object({ id: z.string() }),
        sql`SELECT id FROM fitness.user_profile
            WHERE LOWER(email) = LOWER(${email})
            LIMIT 1`,
      );
      const profileRow = existingByProfileEmail[0];
      if (profileRow) {
        logger.info(`[slack] Found existing user ${profileRow.id} via user_profile email ${email}`);
        return profileRow.id;
      }
    }

    throw new Error(
      "Could not match your Slack account to a Dofek user. " +
        "Make sure the Slack app has the `users:read` and `users:read.email` scopes, " +
        "and that your Slack email matches your Dofek login email.",
    );
  }

  /** Look up the dofek user ID for a Slack user, or create a new user + link if none exists.
   *  Also returns the user's IANA timezone from their Slack profile. */
  async lookupOrCreateUserId(
    slackUserId: string,
    slackClient: SlackClient,
  ): Promise<SlackUserInfo> {
    let name = "Slack User";
    let email: string | null = null;
    let timezone = FALLBACK_TIMEZONE;
    try {
      const info = await slackClient.users.info({ user: slackUserId });
      if (info.user?.real_name) name = info.user.real_name;
      if (info.user?.profile?.email) email = info.user.profile.email;
      if (info.user?.tz) timezone = info.user.tz;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.warn(`[slack] Could not fetch Slack profile for ${slackUserId}: ${detail}`);
    }

    const existing = await executeWithSchema(
      this.#db,
      z.object({ user_id: z.string() }),
      sql`SELECT user_id FROM fitness.auth_account
          WHERE auth_provider = 'slack' AND provider_account_id = ${slackUserId}
          LIMIT 1`,
    );
    const existingRow = existing[0];
    if (existing.length > 0 && existingRow) {
      if (email) {
        const canonical = await executeWithSchema(
          this.#db,
          z.object({ user_id: z.string() }),
          sql`SELECT user_id FROM fitness.auth_account
              WHERE LOWER(email) = LOWER(${email}) AND auth_provider != 'slack'
              LIMIT 1`,
        );
        const canonicalRow = canonical[0];
        if (canonicalRow && canonicalRow.user_id !== existingRow.user_id) {
          const orphanId = existingRow.user_id;
          const correctId = canonicalRow.user_id;
          logger.info(
            `[slack] Repairing orphan: moving Slack user ${slackUserId} from ${orphanId} → ${correctId}`,
          );
          await this.#db.execute(
            sql`UPDATE fitness.auth_account
                SET user_id = ${correctId}
                WHERE auth_provider = 'slack' AND provider_account_id = ${slackUserId}`,
          );
          await this.#db.execute(
            sql`UPDATE fitness.food_entry
                SET user_id = ${correctId}
                WHERE user_id = ${orphanId}`,
          );
          return { userId: correctId, timezone };
        }
      }

      logger.info(
        `[slack] Using existing Slack link for ${slackUserId} → user ${existingRow.user_id}`,
      );
      return { userId: existingRow.user_id, timezone };
    }

    const userId = await this.resolveUserByEmail(email);

    await this.#db.execute(
      sql`INSERT INTO fitness.auth_account (user_id, auth_provider, provider_account_id, name, email)
          VALUES (${userId}, 'slack', ${slackUserId}, ${name}, ${email})`,
    );

    logger.info(`[slack] Linked Slack user ${slackUserId} to user ${userId} (${name})`);
    return { userId, timezone };
  }

  /** Ensure the 'dofek' provider row exists (for self-created entries) */
  async ensureDofekProvider(userId: string): Promise<void> {
    await this.#db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES (${DOFEK_PROVIDER_ID}, 'Dofek App', ${userId})
          ON CONFLICT (id) DO NOTHING`,
    );
  }

  /** Save parsed food items to the database as unconfirmed. Returns the entry IDs. */
  async saveUnconfirmed(
    userId: string,
    date: string,
    items: NutritionItemWithMeal[],
  ): Promise<string[]> {
    await this.ensureDofekProvider(userId);

    const ids: string[] = [];
    for (const item of items) {
      const rows = await executeWithSchema(
        this.#db,
        z.object({ id: z.string() }),
        sql`WITH new_nutrition AS (
              INSERT INTO fitness.nutrition_data (
                ${sql.raw(NUTRIENT_SQL_COLUMNS)}
              ) VALUES (
                ${item.calories}, ${item.proteinG},
                ${item.carbsG}, ${item.fatG},
                ${item.saturatedFatG}, ${item.polyunsaturatedFatG ?? null},
                ${item.monounsaturatedFatG ?? null}, ${item.transFatG ?? null},
                ${item.cholesterolMg ?? null}, ${item.sodiumMg},
                ${item.potassiumMg ?? null}, ${item.fiberG}, ${item.sugarG},
                ${item.vitaminAMcg ?? null}, ${item.vitaminCMg ?? null},
                ${item.vitaminDMcg ?? null}, ${item.vitaminEMg ?? null},
                ${item.vitaminKMcg ?? null},
                ${item.vitaminB1Mg ?? null}, ${item.vitaminB2Mg ?? null},
                ${item.vitaminB3Mg ?? null}, ${item.vitaminB5Mg ?? null},
                ${item.vitaminB6Mg ?? null},
                ${item.vitaminB7Mcg ?? null}, ${item.vitaminB9Mcg ?? null},
                ${item.vitaminB12Mcg ?? null},
                ${item.calciumMg ?? null}, ${item.ironMg ?? null},
                ${item.magnesiumMg ?? null}, ${item.zincMg ?? null},
                ${item.seleniumMcg ?? null},
                ${item.copperMg ?? null}, ${item.manganeseMg ?? null},
                ${item.chromiumMcg ?? null}, ${item.iodineMcg ?? null},
                ${item.omega3Mg ?? null}, ${item.omega6Mg ?? null}
              ) RETURNING id
            )
            INSERT INTO fitness.food_entry (
              user_id, provider_id, date, meal, food_name, food_description,
              category, nutrition_data_id, confirmed
            ) VALUES (
              ${userId}, ${DOFEK_PROVIDER_ID}, ${date}::date,
              ${item.meal}, ${item.foodName}, ${item.foodDescription},
              ${item.category}, (SELECT id FROM new_nutrition), false
            ) RETURNING id`,
      );
      const row = rows[0];
      if (row) {
        ids.push(row.id);
      } else {
        logger.warn(`[slack] INSERT RETURNING returned no id for "${item.foodName}"`);
      }
    }
    logger.info(`[slack] Saved ${ids.length} unconfirmed entries: ${ids.join(",")}`);
    return ids;
  }

  /** Confirm food entries by setting confirmed = true */
  async confirm(entryIds: string[]): Promise<number> {
    if (entryIds.length === 0) return 0;
    const result = await executeWithSchema(
      this.#db,
      z.object({ id: z.string() }),
      sql`UPDATE fitness.food_entry
          SET confirmed = true
          WHERE id IN (${sqlIdList(entryIds)})
            AND confirmed = false
          RETURNING id`,
    );
    return result.length;
  }

  /** Delete unconfirmed food entries and their nutrition_data */
  async deleteUnconfirmed(entryIds: string[]): Promise<void> {
    if (entryIds.length === 0) return;
    await this.#db.execute(
      sql`WITH deleted AS (
            DELETE FROM fitness.food_entry
            WHERE id IN (${sqlIdList(entryIds)})
              AND confirmed = false
            RETURNING nutrition_data_id
          )
          DELETE FROM fitness.nutrition_data
          WHERE id IN (SELECT nutrition_data_id FROM deleted WHERE nutrition_data_id IS NOT NULL)`,
    );
  }

  /** Load food entries by IDs for display after confirmation */
  async loadConfirmedSummary(
    entryIds: string[],
  ): Promise<Array<{ food_name: string; calories: number | null }>> {
    return executeWithSchema(
      this.#db,
      z.object({ food_name: z.string(), calories: z.coerce.number().nullable() }),
      sql`SELECT food_name, calories
          FROM fitness.food_entry
          WHERE id IN (${sqlIdList(entryIds)})`,
    );
  }

  /** Load food entries for refinement (thread follow-up messages) */
  async loadForRefinement(entryIds: string[]): Promise<NutritionItemWithMeal[]> {
    const rows = await executeWithSchema(
      this.#db,
      z.object({
        food_name: z.string(),
        food_description: z.string().nullable(),
        category: z.string().nullable(),
        calories: z.coerce.number().nullable(),
        protein_g: z.coerce.number().nullable(),
        carbs_g: z.coerce.number().nullable(),
        fat_g: z.coerce.number().nullable(),
        fiber_g: z.coerce.number().nullable(),
        saturated_fat_g: z.coerce.number().nullable(),
        sugar_g: z.coerce.number().nullable(),
        sodium_mg: z.coerce.number().nullable(),
        meal: z.string().nullable(),
      }),
      sql`SELECT food_name, food_description, category, calories,
                 protein_g, carbs_g, fat_g, fiber_g,
                 saturated_fat_g, sugar_g, sodium_mg, meal
          FROM fitness.food_entry
          WHERE id IN (${sqlIdList(entryIds)})`,
    );

    return rows.map((row) => ({
      foodName: row.food_name,
      foodDescription: row.food_description ?? "",
      category: categorySchema.parse(row.category ?? "other"),
      calories: row.calories ?? 0,
      proteinG: row.protein_g ?? 0,
      carbsG: row.carbs_g ?? 0,
      fatG: row.fat_g ?? 0,
      fiberG: row.fiber_g ?? 0,
      saturatedFatG: row.saturated_fat_g ?? 0,
      sugarG: row.sugar_g ?? 0,
      sodiumMg: row.sodium_mg ?? 0,
      meal: mealSchema.parse(row.meal ?? "other"),
    }));
  }

  /** Look up the user ID that owns the given food entries */
  async lookupUserIdForEntries(entryIds: string[]): Promise<string | null> {
    const rows = await executeWithSchema(
      this.#db,
      z.object({ user_id: z.string() }),
      sql`SELECT DISTINCT user_id FROM fitness.food_entry WHERE id IN (${sqlIdList(entryIds)}) LIMIT 1`,
    );
    return rows[0]?.user_id ?? null;
  }
}
