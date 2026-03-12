import { App } from "@slack/bolt";
import type { GenericMessageEvent } from "@slack/types";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { analyzeNutritionItems, type NutritionItemWithMeal } from "../lib/ai-nutrition.ts";
import { logger } from "../logger.ts";
import { formatConfirmationMessage, formatSavedMessage } from "./formatting.ts";

const DOFEK_PROVIDER_ID = "dofek";

/** Look up the dofek user ID for a Slack user via auth_account */
async function lookupUserId(db: Database, slackUserId: string): Promise<string | null> {
  const rows = await db.execute<{ user_id: string }>(
    sql`SELECT user_id FROM fitness.auth_account
        WHERE auth_provider = 'slack' AND provider_account_id = ${slackUserId}
        LIMIT 1`,
  );
  return rows.length > 0 ? rows[0].user_id : null;
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
            saturated_fat_g, sugar_g, sodium_mg
          ) VALUES (
            ${userId}, ${DOFEK_PROVIDER_ID}, ${date}::date,
            ${item.meal}, ${item.foodName}, ${item.foodDescription},
            ${item.category}, ${item.calories}, ${item.proteinG},
            ${item.carbsG}, ${item.fatG}, ${item.fiberG},
            ${item.saturatedFatG}, ${item.sugarG}, ${item.sodiumMg}
          )`,
    );
  }
}

/** Get today's date in YYYY-MM-DD format */
function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function createSlackBot(db: Database): App | null {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;

  if (!botToken || !appToken) {
    logger.info("[slack] SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set, skipping Slack bot");
    return null;
  }

  const app = new App({
    token: botToken,
    appToken,
    socketMode: true,
  });

  // Handle direct messages
  app.message(async ({ message, say }) => {
    // Only respond to regular user messages (not bot messages, edits, etc.)
    const msg = message as GenericMessageEvent;
    if (msg.subtype || !msg.text || msg.bot_id) return;

    const userId = await lookupUserId(db, msg.user);
    if (!userId) {
      await say(
        `I don't recognize your Slack account. Ask an admin to link your Slack ID (\`${msg.user}\`) to your dofek account.`,
      );
      return;
    }

    logger.info(`[slack] Parsing food from ${msg.user}: "${msg.text}"`);

    try {
      const result = await analyzeNutritionItems(msg.text);
      const confirmation = formatConfirmationMessage(result.items);
      await say(confirmation);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[slack] AI analysis failed: ${errorMessage}`);
      await say(
        `Sorry, I couldn't parse that. Try describing what you ate more specifically.\n\`${errorMessage}\``,
      );
    }
  });

  // Handle "Confirm" button click
  app.action("confirm_food", async ({ ack, body, client }) => {
    await ack();

    if (body.type !== "block_actions" || !body.actions[0]) return;

    const slackUserId = body.user.id;
    const userId = await lookupUserId(db, slackUserId);
    if (!userId) {
      logger.error(`[slack] Confirm clicked by unlinked user ${slackUserId}`);
      return;
    }

    const action = body.actions[0];
    if (!("value" in action) || !action.value) return;

    const items: NutritionItemWithMeal[] = JSON.parse(action.value);
    const date = todayDate();

    try {
      await saveFoodEntries(db, userId, date, items);
      const savedMessage = formatSavedMessage(items);

      // Update the original message to show saved confirmation (remove buttons)
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

  return app;
}

/** Start the Slack bot (fire-and-forget, logs errors) */
export async function startSlackBot(db: Database): Promise<void> {
  const app = createSlackBot(db);
  if (!app) return;

  try {
    await app.start();
    logger.info("[slack] Slack bot connected (Socket Mode)");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[slack] Failed to start Slack bot: ${errorMessage}`);
  }
}
