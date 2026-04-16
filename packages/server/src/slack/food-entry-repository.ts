import type { Database } from "dofek/db";
import { NUTRIENT_SQL_COLUMNS } from "dofek/db/nutrient-columns";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { NutritionItemWithMeal } from "../lib/ai-nutrition.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";
import { createPendingEntryStore, type PendingEntryStore } from "./pending-entry-store.ts";

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

export interface ThreadConfirmContext {
  entryIds: string[];
  messageTs: string | null;
}

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

export interface SlackEntryContext {
  channelId: string;
  confirmationMessageTs: string;
  threadTs: string;
  sourceMessageTs: string;
  slackUserId: string;
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
  const context = extractLatestConfirmFromThread(messages);
  return context?.entryIds ?? null;
}

/**
 * Extract the latest confirm button context from thread messages returned by
 * conversations.replies. Includes both the entry IDs and the message ts so
 * callers can retire stale confirm buttons after refinements.
 */
export function extractLatestConfirmFromThread(
  messages: Array<{ bot_id?: string; blocks?: unknown[]; ts?: string }>,
): ThreadConfirmContext | null {
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
          if (ids.length > 0) {
            return { entryIds: ids, messageTs: threadMsg.ts ?? null };
          }
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
  readonly #pendingEntryStore: PendingEntryStore;

  constructor(db: Database, pendingEntryStore: PendingEntryStore = createPendingEntryStore()) {
    this.#db = db;
    this.#pendingEntryStore = pendingEntryStore;
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
    context?: SlackEntryContext,
  ): Promise<string[]> {
    if (!context) {
      throw new Error("Slack entry context is required for pending entry storage");
    }

    const ids = await this.#pendingEntryStore.save(
      items.map((item) => ({
        userId,
        date,
        item,
        channelId: context.channelId,
        confirmationMessageTs: context.confirmationMessageTs,
        threadTs: context.threadTs,
        sourceMessageTs: context.sourceMessageTs,
        slackUserId: context.slackUserId,
      })),
    );
    logger.info(`[slack] Saved ${ids.length} unconfirmed entries: ${ids.join(",")}`);
    return ids;
  }

  /** Confirm pending entries by writing final rows into Postgres. */
  async confirm(
    pendingEntryIds: string[],
  ): Promise<{ confirmedCount: number; confirmedEntryIds: string[]; userId: string | null }> {
    if (pendingEntryIds.length === 0) {
      return { confirmedCount: 0, confirmedEntryIds: [], userId: null };
    }

    const pendingEntries = await this.#pendingEntryStore.loadByIds(pendingEntryIds);
    if (pendingEntries.length === 0) {
      const userId = await this.lookupUserIdForEntries(pendingEntryIds);
      return { confirmedCount: 0, confirmedEntryIds: pendingEntryIds, userId };
    }

    const userId = pendingEntries[0]?.userId ?? null;
    if (!userId) {
      return { confirmedCount: 0, confirmedEntryIds: [], userId: null };
    }

    await this.ensureDofekProvider(userId);

    const confirmedEntryIds: string[] = [];
    for (const pendingEntry of pendingEntries) {
      const item = pendingEntry.item;
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
              ${pendingEntry.userId}, ${DOFEK_PROVIDER_ID}, ${pendingEntry.date}::date,
              ${item.meal}, ${item.foodName}, ${item.foodDescription},
              ${item.category}, (SELECT id FROM new_nutrition), true
            ) RETURNING id`,
      );
      const row = rows[0];
      if (!row) {
        throw new Error(`Failed to confirm parsed food entry "${item.foodName}"`);
      }
      confirmedEntryIds.push(row.id);
    }

    await this.#pendingEntryStore.deleteByIds(pendingEntries.map((entry) => entry.id));
    return { confirmedCount: confirmedEntryIds.length, confirmedEntryIds, userId };
  }

  /** Delete unconfirmed food entries and their nutrition_data */
  async deleteUnconfirmed(entryIds: string[]): Promise<void> {
    if (entryIds.length === 0) return;
    await this.#pendingEntryStore.deleteByIds(entryIds);
  }

  /** Load food entries by IDs for display after confirmation */
  async loadConfirmedSummary(
    entryIds: string[],
  ): Promise<Array<{ food_name: string; calories: number | null }>> {
    return executeWithSchema(
      this.#db,
      z.object({ food_name: z.string(), calories: z.coerce.number().nullable() }),
      sql`SELECT fe.food_name, nd.calories
          FROM fitness.food_entry fe
          LEFT JOIN fitness.nutrition_data nd ON fe.nutrition_data_id = nd.id
          WHERE fe.id IN (${sqlIdList(entryIds)})`,
    );
  }

  /** Load food entries for refinement (thread follow-up messages) */
  async loadForRefinement(entryIds: string[]): Promise<NutritionItemWithMeal[]> {
    const pendingEntries = await this.#pendingEntryStore.loadByIds(entryIds);
    return pendingEntries.map((pendingEntry) => pendingEntry.item);
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
