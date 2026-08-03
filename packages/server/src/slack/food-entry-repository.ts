import * as Sentry from "@sentry/node";
import type { Database } from "dofek/db";
import {
  AccountErasureIdentityFencedError,
  AccountErasureUserFencedError,
  lockAndAssertAccountErasureIdentityWriteFence,
} from "dofek/db/account-erasure";
import { nutrientAmountEntriesFromLegacyFields } from "dofek/db/nutrient-columns";
import { ensureProvider } from "dofek/db/tokens";
import { invalidateAllUserQueries } from "dofek/lib/cache";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { NutritionItemWithMeal } from "../lib/ai-nutrition.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";
import { SettingsRepository } from "../repositories/settings-repository.ts";
import { SlackInstallationRepository } from "../repositories/slack-installation-repository.ts";
import { createPendingEntryStore, type PendingEntryStore } from "./pending-entry-store.ts";

const slackBlockSchema = z.object({
  type: z.string(),
  elements: z
    .array(
      z.object({
        action_id: z.string().optional(),
        value: z.string().optional(),
      }),
    )
    .optional(),
});

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

export type DailyCalorieProgress =
  | {
      status?: "available";
      calorieGoal: number;
      caloriesConsumed: number;
    }
  | {
      status: "source_conflict";
      message: string;
      sourceLabels: string[];
    };

const dailyCaloriesRowSchema = z.object({
  calories_consumed: z.coerce.number().nullable(),
  resolution_status: z.enum(["available", "source_conflict"]),
  resolution_message: z.string(),
  source_labels: z.array(z.string()),
});
const confirmedSummaryRowSchema = z.object({
  food_name: z.string(),
  calories: z.coerce.number().nullable(),
  date: dateStringSchema,
});

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
          const ids = element.value
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean);
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

export interface InboundSlackNutritionFenceInput {
  slackClient: SlackClient;
  slackUserId: string;
  teamId?: string;
}

export interface InboundSlackNutritionContext extends SlackUserInfo {
  repository: FoodEntryRepository;
}

interface SlackProfile {
  email: string | null;
  name: string;
  timezone: string;
}

interface SlackUserResolution {
  existingUserId: string | null;
  userId: string;
}

type FoodEntryDatabase = Pick<Database, "execute" | "transaction">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isAccountErasureDatabaseFenceError(error: unknown): boolean {
  let candidate: unknown = error;
  while (isRecord(candidate)) {
    if (
      candidate.code === "55000" &&
      typeof candidate.message === "string" &&
      candidate.message.includes("Account erasure is active")
    ) {
      return true;
    }
    candidate = candidate.cause;
  }
  return false;
}

/**
 * Encapsulates all database operations for the Slack bot's food tracking workflow:
 * user resolution, food entry CRUD, and cache invalidation.
 */
export class FoodEntryRepository {
  readonly #db: FoodEntryDatabase;
  readonly #pendingEntryStore: PendingEntryStore;

  constructor(
    db: FoodEntryDatabase,
    pendingEntryStore: PendingEntryStore = createPendingEntryStore(),
  ) {
    this.#db = db;
    this.#pendingEntryStore = pendingEntryStore;
  }

  /** Find an existing user by email. Throws if no match is found. */
  async resolveUserByEmail(email: string | null): Promise<string> {
    return this.#resolveUserByEmail(email, true);
  }

  async #resolveUserByEmail(email: string | null, logMatch: boolean): Promise<string> {
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
        if (logMatch) {
          logger.info(
            `[slack] Found existing user ${authRow.user_id} via auth_account email ${email}`,
          );
        }
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
        if (logMatch) {
          logger.info(
            `[slack] Found existing user ${profileRow.id} via user_profile email ${email}`,
          );
        }
        return profileRow.id;
      }
    }

    throw new Error(
      "Could not match your Slack account to a Dofek user. " +
        "Make sure the Slack app has the `users:read` and `users:read.email` scopes, " +
        "and that your Slack email matches your Dofek login email.",
    );
  }

  async #loadSlackProfile(slackUserId: string, slackClient: SlackClient): Promise<SlackProfile> {
    let name = "Slack User";
    let email: string | null = null;
    let timezone = FALLBACK_TIMEZONE;
    try {
      const info = await slackClient.users.info({ user: slackUserId });
      if (info.user?.real_name) name = info.user.real_name;
      if (info.user?.profile?.email) email = info.user.profile.email;
      if (info.user?.tz) timezone = info.user.tz;
    } catch {
      logger.warn("[slack] Could not fetch Slack profile; using fallback identity data");
      const sanitizedError = new Error("Slack profile lookup failed");
      sanitizedError.name = "SlackProfileLookupError";
      Sentry.captureException(sanitizedError, {
        tags: { slack_operation: "profile_lookup" },
      });
    }
    return { email, name, timezone };
  }

  async #findSlackUserResolution(
    slackUserId: string,
    email: string | null,
    logEmailMatch: boolean,
  ): Promise<SlackUserResolution> {
    const existing = await executeWithSchema(
      this.#db,
      z.object({ user_id: z.string() }),
      sql`SELECT user_id FROM fitness.auth_account
          WHERE auth_provider = 'slack' AND provider_account_id = ${slackUserId}
          LIMIT 1`,
    );
    const existingRow = existing[0];
    if (existingRow) {
      if (email) {
        const canonical = await executeWithSchema(
          this.#db,
          z.object({ user_id: z.string() }),
          sql`SELECT user_id FROM fitness.auth_account
              WHERE LOWER(email) = LOWER(${email}) AND auth_provider != 'slack'
              LIMIT 1`,
        );
        const canonicalRow = canonical[0];
        if (canonicalRow) {
          return {
            existingUserId: existingRow.user_id,
            userId: canonicalRow.user_id,
          };
        }
      }
      return {
        existingUserId: existingRow.user_id,
        userId: existingRow.user_id,
      };
    }

    return {
      existingUserId: null,
      userId: await this.#resolveUserByEmail(email, logEmailMatch),
    };
  }

  async #applySlackUserResolution(
    slackUserId: string,
    profile: SlackProfile,
    resolution: SlackUserResolution,
  ): Promise<void> {
    if (resolution.existingUserId && resolution.existingUserId !== resolution.userId) {
      logger.info(
        `[slack] Repairing orphan: moving Slack user ${slackUserId} from ${resolution.existingUserId} → ${resolution.userId}`,
      );
      await this.#db.execute(
        sql`UPDATE fitness.auth_account
            SET user_id = ${resolution.userId}
            WHERE auth_provider = 'slack' AND provider_account_id = ${slackUserId}`,
      );
      await this.#db.execute(
        sql`UPDATE fitness.food_entry
            SET user_id = ${resolution.userId}
            WHERE user_id = ${resolution.existingUserId}`,
      );
      await Promise.all([
        invalidateAllUserQueries(resolution.existingUserId),
        invalidateAllUserQueries(resolution.userId),
      ]);
      return;
    }

    if (resolution.existingUserId) {
      logger.info(
        `[slack] Using existing Slack link for ${slackUserId} → user ${resolution.userId}`,
      );
      return;
    }

    await this.#db.execute(
      sql`INSERT INTO fitness.auth_account (user_id, auth_provider, provider_account_id, name, email)
          VALUES (
            ${resolution.userId},
            'slack',
            ${slackUserId},
            ${profile.name},
            ${profile.email}
          )`,
    );
    await invalidateAllUserQueries(resolution.userId);
    logger.info(
      `[slack] Linked Slack user ${slackUserId} to user ${resolution.userId} (${profile.name})`,
    );
  }

  /** Look up the dofek user ID for a Slack user, or create a new user + link if none exists.
   *  Also returns the user's IANA timezone from their Slack profile. */
  async lookupOrCreateUserId(
    slackUserId: string,
    slackClient: SlackClient,
  ): Promise<SlackUserInfo> {
    const profile = await this.#loadSlackProfile(slackUserId, slackClient);
    const resolution = await this.#findSlackUserResolution(slackUserId, profile.email, true);
    await this.#applySlackUserResolution(slackUserId, profile, resolution);
    return { userId: resolution.userId, timezone: profile.timezone };
  }

  /**
   * Resolve the inbound Slack identity and hold the user, identity, and team
   * locks until the nutrition processor and pending-entry write finish.
   */
  async withInboundNutritionWriteFence<T>(
    input: InboundSlackNutritionFenceInput,
    operation: (context: InboundSlackNutritionContext) => Promise<T>,
  ): Promise<T> {
    const profile = await this.#loadSlackProfile(input.slackUserId, input.slackClient);
    const expectedResolution = await this.#findSlackUserResolution(
      input.slackUserId,
      profile.email,
      false,
    );

    try {
      return await this.#db.transaction(async (transaction) => {
        const userIds = [
          ...new Set(
            [expectedResolution.existingUserId, expectedResolution.userId].filter(
              (userId): userId is string => userId !== null,
            ),
          ),
        ].sort();
        for (const userId of userIds) {
          await transaction.execute(
            sql`SELECT fitness.lock_and_reject_account_erasure_write(${userId}::uuid)`,
          );
        }
        await lockAndAssertAccountErasureIdentityWriteFence(transaction, [
          {
            authProvider: "slack",
            kind: "provider_account",
            providerAccountId: input.slackUserId,
          },
        ]);

        const fencedRepository = new FoodEntryRepository(transaction, this.#pendingEntryStore);
        const currentResolution = await fencedRepository.#findSlackUserResolution(
          input.slackUserId,
          profile.email,
          false,
        );
        if (
          currentResolution.existingUserId !== expectedResolution.existingUserId ||
          currentResolution.userId !== expectedResolution.userId
        ) {
          throw new Error(
            "Slack account mapping changed while the message was being processed. Please retry.",
          );
        }

        if (input.teamId) {
          await transaction.execute(
            sql`SELECT pg_advisory_xact_lock(
                  hashtextextended(
                    'account-erasure-slack-team:' || ${input.teamId},
                    0
                  )
                )`,
          );
          await new SlackInstallationRepository(transaction).upsertTeamMembership({
            slackUserId: input.slackUserId,
            teamId: input.teamId,
            userId: currentResolution.userId,
          });
        }

        await fencedRepository.#applySlackUserResolution(
          input.slackUserId,
          profile,
          currentResolution,
        );
        return operation({
          repository: fencedRepository,
          userId: currentResolution.userId,
          timezone: profile.timezone,
        });
      });
    } catch (error: unknown) {
      if (
        error instanceof AccountErasureIdentityFencedError ||
        error instanceof AccountErasureUserFencedError ||
        isAccountErasureDatabaseFenceError(error)
      ) {
        throw new AccountErasureUserFencedError();
      }
      throw error;
    }
  }

  /** Ensure the 'dofek' provider row exists (for self-created entries) */
  async ensureDofekProvider(userId: string): Promise<void> {
    await ensureProvider(this.#db, DOFEK_PROVIDER_ID, "Dofek App", undefined, userId);
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
      const nutrientEntries = nutrientAmountEntriesFromLegacyFields(item);
      const nutrientValuesClauses = nutrientEntries.map(
        (nutrientEntry) =>
          sql`(${pendingEntry.id}::uuid, ${nutrientEntry.nutrientId}::text, ${nutrientEntry.amount}::real)`,
      );
      const rows = await executeWithSchema(
        this.#db,
        z.object({ id: z.string() }),
        sql`WITH new_entry AS (
            INSERT INTO fitness.food_entry (
              id, user_id, provider_id, date, meal, food_name, food_description,
              category, nutrition_grain, confirmed
            ) VALUES (
              ${pendingEntry.id}, ${pendingEntry.userId}, ${DOFEK_PROVIDER_ID}, ${pendingEntry.date}::date,
              ${item.meal}, ${item.foodName}, ${item.foodDescription},
              ${item.category}, 'itemized', true
            ) RETURNING id
          ),
          new_nutrition AS (
            INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
            VALUES ${sql.join(nutrientValuesClauses, sql`, `)}
          )
          SELECT id FROM new_entry`,
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

  /** Delete unconfirmed food entries */
  async deleteUnconfirmed(entryIds: string[]): Promise<void> {
    if (entryIds.length === 0) return;
    await this.#pendingEntryStore.deleteByIds(entryIds);
  }

  async findPendingIdsByMessage(
    channelId: string,
    confirmationMessageTs: string,
  ): Promise<string[]> {
    return this.#pendingEntryStore.findIdsByMessage(channelId, confirmationMessageTs);
  }

  /** Load food entries by IDs for display after confirmation */
  async loadConfirmedSummary(
    entryIds: string[],
  ): Promise<Array<{ food_name: string; calories: number | null; date: string }>> {
    return executeWithSchema(
      this.#db,
      confirmedSummaryRowSchema,
      sql`SELECT food_name, calories, date
          FROM fitness.v_food_entry_with_nutrition
          WHERE id IN (${sqlIdList(entryIds)})
          ORDER BY date, food_name`,
    );
  }

  async loadDailyCalorieProgress(userId: string, date: string): Promise<DailyCalorieProgress> {
    const calorieGoal = await new SettingsRepository(this.#db, userId).getCalorieGoal();

    const dailyCaloriesRows = await executeWithSchema(
      this.#db,
      dailyCaloriesRowSchema,
      sql`SELECT
            calories AS calories_consumed,
            resolution_status,
            resolution_message,
            source_labels
          FROM fitness.v_nutrition_daily
          WHERE user_id = ${userId}
            AND date = ${date}::date`,
    );

    const dailyCalories = dailyCaloriesRows[0];
    if (!dailyCalories) {
      return { status: "available", calorieGoal, caloriesConsumed: 0 };
    }
    if (dailyCalories.resolution_status === "source_conflict") {
      return {
        status: "source_conflict",
        message: dailyCalories.resolution_message,
        sourceLabels: dailyCalories.source_labels,
      };
    }
    return {
      status: "available",
      calorieGoal,
      caloriesConsumed: Math.round(dailyCalories.calories_consumed ?? 0),
    };
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
