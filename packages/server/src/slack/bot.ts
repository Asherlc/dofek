import { App, ExpressReceiver, type ExpressReceiverOptions } from "@slack/bolt";
import type { GenericMessageEvent } from "@slack/types";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import type express from "express";
import { analyzeNutritionItems, type NutritionItemWithMeal } from "../lib/ai-nutrition.ts";
import { logger } from "../logger.ts";
import { formatConfirmationMessage, formatSavedMessage } from "./formatting.ts";
import { createInstallationStore } from "./installation-store.ts";

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

/** Register message and action handlers on a Bolt app */
function registerHandlers(app: App, db: Database) {
  // Handle direct messages
  app.message(async ({ message, say }) => {
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
}

interface SlackBotResult {
  app: App;
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
 * **HTTP/OAuth Mode** (multi-workspace): Set SLACK_CLIENT_ID + SLACK_CLIENT_SECRET + SLACK_SIGNING_SECRET.
 *   Enables "Add to Slack" OAuth flow. Events arrive via HTTP webhook.
 *   Mount the returned router on your Express app.
 */
export function createSlackBot(db: Database): SlackBotResult | null {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  // HTTP/OAuth mode (multi-workspace distribution)
  if (clientId && clientSecret && signingSecret) {
    const installationStore = createInstallationStore(db);

    const receiverOptions: ExpressReceiverOptions = {
      signingSecret,
      clientId,
      clientSecret,
      stateSecret: process.env.SLACK_STATE_SECRET ?? "dofek-slack-state",
      scopes: ["chat:write", "im:history", "im:read", "im:write"],
      installationStore,
      installerOptions: {
        directInstall: true,
      },
    };

    const receiver = new ExpressReceiver(receiverOptions);

    const app = new App({ receiver });
    registerHandlers(app, db);

    logger.info("[slack] Configured in HTTP/OAuth mode (multi-workspace)");
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
    "[slack] No Slack credentials configured. Set SLACK_BOT_TOKEN+SLACK_APP_TOKEN for Socket Mode, or SLACK_CLIENT_ID+SLACK_CLIENT_SECRET+SLACK_SIGNING_SECRET for OAuth mode.",
  );
  return null;
}

/** Start the Slack bot. In HTTP mode, mount the router on Express instead of calling start(). */
export async function startSlackBot(db: Database, expressApp?: express.Express): Promise<void> {
  const result = createSlackBot(db);
  if (!result) return;

  try {
    if (result.mode === "http" && result.router && expressApp) {
      // Mount Slack routes on Express — Bolt handles /slack/events, /slack/install, /slack/oauth_redirect
      expressApp.use("/slack", result.router);
      logger.info("[slack] Slack bot mounted at /slack (HTTP mode)");
      logger.info("[slack] Install URL: /slack/install");
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
