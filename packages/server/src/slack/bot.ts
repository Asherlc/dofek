import type { App as AppType } from "@slack/bolt";
import bolt from "@slack/bolt";

const { App, ExpressReceiver } = bolt;

import type { GenericMessageEvent } from "@slack/types";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import type express from "express";
import {
  analyzeNutritionItems,
  type NutritionItemWithMeal,
  refineNutritionItems,
} from "../lib/ai-nutrition.ts";
import { logger } from "../logger.ts";
import { formatConfirmationMessage, formatSavedMessage } from "./formatting.ts";
import { removePendingItems, retrievePendingItems, storePendingItems } from "./pending-items.ts";

const DOFEK_PROVIDER_ID = "dofek";

const FALLBACK_TIMEZONE = process.env.TIMEZONE ?? "America/Los_Angeles";

/** Convert a Slack epoch timestamp to a readable local time string using the user's timezone */
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

interface SlackUserInfo {
  userId: string;
  timezone: string;
}

/**
 * Extract food items from thread messages returned by conversations.replies.
 * Walks backwards to find the most recent bot message with a confirm button.
 * The button value is a pending-store key (UUID); falls back to inline JSON
 * for backwards compatibility with messages sent before the pending-store change.
 */
function extractItemsFromThread(
  messages: Array<{ bot_id?: string; blocks?: unknown[] }>,
): NutritionItemWithMeal[] | null {
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
          // Try pending store lookup first (value is a UUID key)
          const fromStore = retrievePendingItems(element.value);
          if (fromStore) return fromStore;
          // Fall back to inline JSON for legacy messages
          try {
            return JSON.parse(element.value) as NutritionItemWithMeal[];
          } catch {
            return null;
          }
        }
      }
    }
  }

  return null;
}

/** Find an existing user by email, or create a new user profile. */
async function resolveOrCreateUserId(
  db: Database,
  email: string | null,
  name: string,
): Promise<string> {
  // Check if a user with this email already exists (e.g., from Google/Apple web login)
  if (email) {
    const existingByEmail = await db.execute<{ user_id: string }>(
      sql`SELECT user_id FROM fitness.auth_account
          WHERE email = ${email}
          LIMIT 1`,
    );
    const emailRow = existingByEmail[0];
    if (emailRow) {
      logger.info(`[slack] Found existing user ${emailRow.user_id} via email ${email}`);
      return emailRow.user_id;
    }
  }

  // No existing user — create a new one
  const newUser = await db.execute<{ id: string }>(
    sql`INSERT INTO fitness.user_profile (name, email)
        VALUES (${name}, ${email})
        RETURNING id`,
  );
  const newUserRow = newUser[0];
  if (!newUserRow) throw new Error("Failed to create user profile for Slack user");
  return newUserRow.id;
}

/** Look up the dofek user ID for a Slack user, or create a new user + link if none exists.
 *  Also returns the user's IANA timezone from their Slack profile. */
async function lookupOrCreateUserId(
  db: Database,
  slackUserId: string,
  slackClient: {
    users: {
      info: (args: {
        user: string;
      }) => Promise<{ user?: { tz?: string; real_name?: string; profile?: { email?: string } } }>;
    };
  },
): Promise<SlackUserInfo> {
  // Fetch Slack profile — we always need the timezone, and also name/email for new users
  let name = "Slack User";
  let email: string | null = null;
  let timezone = FALLBACK_TIMEZONE;
  try {
    const info = await slackClient.users.info({ user: slackUserId });
    if (info.user?.real_name) name = info.user.real_name;
    if (info.user?.profile?.email) email = info.user.profile.email;
    if (info.user?.tz) timezone = info.user.tz;
  } catch {
    logger.warn(`[slack] Could not fetch Slack profile for ${slackUserId}`);
  }

  // Check for existing Slack auth link
  const existing = await db.execute<{ user_id: string }>(
    sql`SELECT user_id FROM fitness.auth_account
        WHERE auth_provider = 'slack' AND provider_account_id = ${slackUserId}
        LIMIT 1`,
  );
  const existingRow = existing[0];
  if (existing.length > 0 && existingRow) {
    // Verify this Slack account isn't orphaned: if a non-Slack auth_account exists
    // with the same email but a different user_id, the Slack link is stale
    // (e.g., Slack bot ran before the user logged in on the web).
    if (email) {
      const canonical = await db.execute<{ user_id: string }>(
        sql`SELECT user_id FROM fitness.auth_account
            WHERE email = ${email} AND auth_provider != 'slack'
            LIMIT 1`,
      );
      const canonicalRow = canonical[0];
      if (canonicalRow && canonicalRow.user_id !== existingRow.user_id) {
        const orphanId = existingRow.user_id;
        const correctId = canonicalRow.user_id;
        logger.info(
          `[slack] Repairing orphan: moving Slack user ${slackUserId} from ${orphanId} → ${correctId}`,
        );
        // Repoint the Slack auth_account to the correct user
        await db.execute(
          sql`UPDATE fitness.auth_account
              SET user_id = ${correctId}
              WHERE auth_provider = 'slack' AND provider_account_id = ${slackUserId}`,
        );
        // Migrate any food entries saved under the orphan user
        await db.execute(
          sql`UPDATE fitness.food_entry
              SET user_id = ${correctId}
              WHERE user_id = ${orphanId}`,
        );
        return { userId: correctId, timezone };
      }
    }
    return { userId: existingRow.user_id, timezone };
  }

  // Try to find an existing user with the same email (e.g., from Google/Apple web login)
  const userId = await resolveOrCreateUserId(db, email, name);

  // Link Slack account
  await db.execute(
    sql`INSERT INTO fitness.auth_account (user_id, auth_provider, provider_account_id, name, email)
        VALUES (${userId}, 'slack', ${slackUserId}, ${name}, ${email})`,
  );

  logger.info(`[slack] Linked Slack user ${slackUserId} to user ${userId} (${name})`);
  return { userId, timezone };
}

/** Ensure the 'dofek' provider row exists (for self-created entries) */
async function ensureDofekProvider(db: Database) {
  await db.execute(
    sql`INSERT INTO fitness.provider (id, name)
        VALUES (${DOFEK_PROVIDER_ID}, 'Dofek App')
        ON CONFLICT (id) DO NOTHING`,
  );
}

/** Save parsed food items to the database */
async function saveFoodEntries(
  db: Database,
  userId: string,
  date: string,
  items: NutritionItemWithMeal[],
) {
  await ensureDofekProvider(db);

  for (const item of items) {
    await db.execute(
      sql`INSERT INTO fitness.food_entry (
            user_id, provider_id, date, meal, food_name, food_description, category,
            calories, protein_g, carbs_g, fat_g, fiber_g,
            saturated_fat_g, sugar_g, sodium_mg,
            polyunsaturated_fat_g, monounsaturated_fat_g, trans_fat_g, cholesterol_mg,
            potassium_mg, calcium_mg, iron_mg, magnesium_mg, zinc_mg,
            selenium_mcg, copper_mg, manganese_mg, chromium_mcg, iodine_mcg,
            vitamin_a_mcg, vitamin_c_mg, vitamin_d_mcg, vitamin_e_mg, vitamin_k_mcg,
            vitamin_b1_mg, vitamin_b2_mg, vitamin_b3_mg, vitamin_b5_mg,
            vitamin_b6_mg, vitamin_b7_mcg, vitamin_b9_mcg, vitamin_b12_mcg,
            omega3_mg, omega6_mg
          ) VALUES (
            ${userId}, ${DOFEK_PROVIDER_ID}, ${date}::date,
            ${item.meal}, ${item.foodName}, ${item.foodDescription},
            ${item.category}, ${item.calories}, ${item.proteinG},
            ${item.carbsG}, ${item.fatG}, ${item.fiberG},
            ${item.saturatedFatG}, ${item.sugarG}, ${item.sodiumMg},
            ${item.polyunsaturatedFatG ?? null}, ${item.monounsaturatedFatG ?? null},
            ${item.transFatG ?? null}, ${item.cholesterolMg ?? null},
            ${item.potassiumMg ?? null}, ${item.calciumMg ?? null},
            ${item.ironMg ?? null}, ${item.magnesiumMg ?? null},
            ${item.zincMg ?? null}, ${item.seleniumMcg ?? null},
            ${item.copperMg ?? null}, ${item.manganeseMg ?? null},
            ${item.chromiumMcg ?? null}, ${item.iodineMcg ?? null},
            ${item.vitaminAMcg ?? null}, ${item.vitaminCMg ?? null},
            ${item.vitaminDMcg ?? null}, ${item.vitaminEMg ?? null},
            ${item.vitaminKMcg ?? null}, ${item.vitaminB1Mg ?? null},
            ${item.vitaminB2Mg ?? null}, ${item.vitaminB3Mg ?? null},
            ${item.vitaminB5Mg ?? null}, ${item.vitaminB6Mg ?? null},
            ${item.vitaminB7Mcg ?? null}, ${item.vitaminB9Mcg ?? null},
            ${item.vitaminB12Mcg ?? null}, ${item.omega3Mg ?? null},
            ${item.omega6Mg ?? null}
          )`,
    );
  }
}

/** Get today's date in YYYY-MM-DD format, in the given IANA timezone. */
function todayDate(timezone: string): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: timezone });
}

/** Convert a Slack epoch timestamp to YYYY-MM-DD date string in the user's timezone */
function slackTimestampToDateString(slackTs: string, timezone: string): string {
  const epochSeconds = Number.parseFloat(slackTs);
  const date = new Date(epochSeconds * 1000);
  return date.toLocaleDateString("en-CA", { timeZone: timezone });
}

/** Register message and action handlers on a Bolt app */
function registerHandlers(app: AppType, db: Database) {
  // Handle direct messages (both top-level and thread replies)
  app.message(async ({ message, say, client }) => {
    const msg = message as GenericMessageEvent;
    if (msg.subtype || !msg.text || msg.bot_id) return;

    const { timezone: userTimezone } = await lookupOrCreateUserId(db, msg.user, client);

    // Thread reply — look for previous items to refine
    if (msg.thread_ts && msg.thread_ts !== msg.ts) {
      logger.info(`[slack] Thread reply from ${msg.user}: "${msg.text}"`);

      try {
        const thread = await client.conversations.replies({
          channel: msg.channel,
          ts: msg.thread_ts,
        });
        const previousItems = extractItemsFromThread(
          (thread.messages ?? []) as Array<{ bot_id?: string; blocks?: unknown[] }>,
        );

        if (previousItems) {
          logger.info(`[slack] Refining ${previousItems.length} items with: "${msg.text}"`);
          const localTime = slackTimestampToLocalTime(msg.ts, userTimezone);
          const result = await refineNutritionItems(previousItems, msg.text, localTime);
          const pendingKey = storePendingItems(result.items);
          const confirmation = formatConfirmationMessage(result.items, pendingKey);
          await say({ ...confirmation, thread_ts: msg.thread_ts });
          return;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`[slack] Refinement failed: ${errorMessage}`);
        await say({
          text: `Sorry, I couldn't refine that.\n\`${errorMessage}\``,
          thread_ts: msg.thread_ts,
        });
        return;
      }
    }

    // Top-level message — fresh analysis (reply in thread so user can refine)
    logger.info(`[slack] Parsing food from ${msg.user}: "${msg.text}"`);

    try {
      const localTime = slackTimestampToLocalTime(msg.ts, userTimezone);
      const result = await analyzeNutritionItems(msg.text, localTime);
      const pendingKey = storePendingItems(result.items);
      const confirmation = formatConfirmationMessage(result.items, pendingKey);
      await say({ ...confirmation, thread_ts: msg.ts });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[slack] AI analysis failed: ${errorMessage}`);
      await say({
        text: `Sorry, I couldn't parse that. Try describing what you ate more specifically.\n\`${errorMessage}\``,
        thread_ts: msg.ts,
      });
    }
  });

  // Handle "Confirm" button click
  app.action("confirm_food", async ({ ack, body, client }) => {
    await ack();

    if (body.type !== "block_actions" || !body.actions[0]) return;

    const slackUserId = body.user.id;
    const { userId, timezone } = await lookupOrCreateUserId(db, slackUserId, client);

    const action = body.actions[0];
    if (!("value" in action) || !action.value) return;

    // Value is a pending-store key (UUID); fall back to inline JSON for legacy messages
    let items: NutritionItemWithMeal[];
    const fromStore = retrievePendingItems(action.value);
    if (fromStore) {
      items = fromStore;
      removePendingItems(action.value);
    } else {
      try {
        items = JSON.parse(action.value) as NutritionItemWithMeal[];
      } catch {
        logger.error(`[slack] Could not find pending items for key ${action.value}`);
        if (body.channel?.id && body.message?.ts) {
          await client.chat.update({
            channel: body.channel.id,
            ts: body.message.ts,
            text: "This entry has expired. Please log your food again.",
            blocks: [],
          });
        }
        return;
      }
    }

    const date = body.message?.ts
      ? slackTimestampToDateString(body.message.ts, timezone)
      : todayDate(timezone);

    try {
      await saveFoodEntries(db, userId, date, items);
      const savedMessage = formatSavedMessage(items);

      if (body.channel?.id && body.message?.ts) {
        await client.chat.update({
          channel: body.channel.id,
          ts: body.message.ts,
          ...savedMessage,
        });
      }

      logger.info(`[slack] Saved ${items.length} food entries for user ${userId}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[slack] Failed to save food entries: ${errorMessage}`);

      if (body.channel?.id && body.message?.ts) {
        await client.chat.update({
          channel: body.channel.id,
          ts: body.message.ts,
          text: `Failed to save: ${errorMessage}`,
          blocks: [],
        });
      }
    }
  });

  // Publish Home Tab when user opens the app
  app.event("app_home_opened", async ({ event, client }) => {
    try {
      await client.views.publish({
        user_id: event.user,
        view: {
          type: "home",
          blocks: [
            {
              type: "header",
              text: { type: "plain_text", text: "Dofek — Nutrition Tracker" },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "Track what you eat by sending me a message. I'll use AI to estimate the nutrition and let you confirm before saving.",
              },
            },
            { type: "divider" },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "*How it works:*\n\n1. Send me a DM describing what you ate\n2. I'll parse it into individual items with calorie and macro estimates\n3. Review and hit *Confirm* to save, or *Cancel* to discard",
              },
            },
            { type: "divider" },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: '*Examples:*\n\n• _"Two eggs, toast with butter, and a coffee with milk"_\n• _"Chicken salad with avocado for lunch"_\n• _"A slice of pepperoni pizza and a coke"_',
              },
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: "Tip: Be specific about portions and preparation for more accurate estimates.",
                },
              ],
            },
          ],
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[slack] Failed to publish Home Tab: ${errorMessage}`);
    }
  });

  // Handle "Cancel" button click
  app.action("cancel_food", async ({ ack, body, client }) => {
    await ack();

    if (body.channel?.id && body.type === "block_actions" && body.message?.ts) {
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: "Cancelled.",
        blocks: [],
      });
    }
  });
}

interface SlackBotResult {
  app: AppType;
  mode: "socket" | "http";
  /** Express router for HTTP mode — mount on your Express app at /slack */
  router?: express.Router;
}

/**
 * Create the Slack bot. Supports two modes:
 *
 * **Socket Mode** (single workspace): Set SLACK_BOT_TOKEN + SLACK_APP_TOKEN.
 *   Bot connects outbound via WebSocket, no public URL needed.
 *
 * **HTTP Mode** (multi-workspace): Set SLACK_SIGNING_SECRET.
 *   Events arrive via HTTP webhook. OAuth is handled by the main auth routes
 *   (/auth/provider/slack → /callback), not by Bolt's built-in installer.
 *   Mount the returned router on your Express app.
 */
export function createSlackBot(db: Database): SlackBotResult | null {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  // HTTP mode (multi-workspace) — OAuth handled externally via /auth/provider/slack
  if (signingSecret) {
    const receiver = new ExpressReceiver({
      signingSecret,
      // Router is mounted at /slack, so use /events here → full path /slack/events
      endpoints: "/events",
      // No clientId/clientSecret — OAuth is handled by the main auth routes
      processBeforeResponse: true,
    });

    const app = new App({
      receiver,
      authorize: async ({ teamId }) => {
        if (!teamId) throw new Error("Missing teamId in Slack event");
        const rows = await db.execute<{
          bot_token: string;
          bot_id: string | null;
          bot_user_id: string | null;
        }>(
          sql`SELECT bot_token, bot_id, bot_user_id
              FROM fitness.slack_installation
              WHERE team_id = ${teamId}
              LIMIT 1`,
        );
        const row = rows[0];
        if (rows.length === 0 || !row) {
          throw new Error(`No Slack installation found for team ${teamId}`);
        }
        return {
          botToken: row.bot_token,
          botId: row.bot_id ?? undefined,
          botUserId: row.bot_user_id ?? undefined,
        };
      },
    });
    registerHandlers(app, db);

    logger.info(
      "[slack] Configured in HTTP mode (multi-workspace, OAuth via /auth/provider/slack)",
    );
    return { app, mode: "http", router: receiver.router };
  }

  // Socket Mode (single workspace)
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;

  if (botToken && appToken) {
    const app = new App({
      token: botToken,
      appToken,
      socketMode: true,
    });

    registerHandlers(app, db);

    logger.info("[slack] Configured in Socket Mode (single workspace)");
    return { app, mode: "socket" };
  }

  logger.info(
    "[slack] No Slack credentials configured. Set SLACK_BOT_TOKEN+SLACK_APP_TOKEN for Socket Mode, or SLACK_SIGNING_SECRET for HTTP mode.",
  );
  return null;
}

/** Start the Slack bot. In HTTP mode, mount the router on Express instead of calling start(). */
export async function startSlackBot(db: Database, expressApp?: express.Express): Promise<void> {
  const result = createSlackBot(db);
  if (!result) return;

  try {
    if (result.mode === "http" && result.router && expressApp) {
      // Mount Slack event receiver — OAuth is handled by /auth/provider/slack
      expressApp.use("/slack", result.router);
      logger.info("[slack] Slack bot mounted at /slack/events (HTTP mode)");
    } else if (result.mode === "socket") {
      await result.app.start();
      logger.info("[slack] Slack bot connected (Socket Mode)");
    } else if (result.mode === "http") {
      logger.warn("[slack] HTTP mode requires Express app reference — pass it to startSlackBot()");
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[slack] Failed to start Slack bot: ${errorMessage}`);
  }
}
