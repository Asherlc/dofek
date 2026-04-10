import type { App as AppType } from "@slack/bolt";
import bolt from "@slack/bolt";

const { App, ExpressReceiver, SocketModeReceiver } = bolt;

import * as Sentry from "@sentry/node";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import type express from "express";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";
import { FoodEntryRepository } from "./food-entry-repository.ts";
import { registerSocketModeDiagnostics, verifyBotConfiguration } from "./slack-diagnostics.ts";
import { registerHandlers } from "./slack-handlers.ts";

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
  const repository = new FoodEntryRepository(db);
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  // HTTP mode (multi-workspace) — OAuth handled externally via /auth/provider/slack
  if (signingSecret) {
    const receiver = new ExpressReceiver({
      signingSecret,
      // Router is mounted at /slack, so use /events here → full path /slack/events
      endpoints: "/events",
      // No clientId/clientSecret — OAuth is handled by the main auth routes
      processBeforeResponse: false,
    });

    const app = new App({
      receiver,
      authorize: async ({ teamId }) => {
        if (!teamId) {
          logger.error("[slack] authorize: missing teamId in event");
          throw new Error("Missing teamId in Slack event");
        }
        logger.info(`[slack] authorize: looking up installation for team ${teamId}`);
        const rows = await executeWithSchema(
          db,
          z.object({
            bot_token: z.string(),
            bot_id: z.string().nullable(),
            bot_user_id: z.string().nullable(),
          }),
          sql`SELECT bot_token, bot_id, bot_user_id
              FROM fitness.slack_installation
              WHERE team_id = ${teamId}
              LIMIT 1`,
        );
        const row = rows[0];
        if (rows.length === 0 || !row) {
          logger.error(`[slack] authorize: no installation found for team ${teamId}`);
          throw new Error(`No Slack installation found for team ${teamId}`);
        }
        logger.info(`[slack] authorize: found installation for team ${teamId}`);
        return {
          botToken: row.bot_token,
          botId: row.bot_id ?? undefined,
          botUserId: row.bot_user_id ?? undefined,
        };
      },
    });
    app.error(async (error) => {
      logger.error(`[slack] Unhandled Bolt error: ${error.message ?? error}`);
      Sentry.captureException(error);
    });
    registerHandlers(app, repository);

    logger.info(
      "[slack] Configured in HTTP mode (multi-workspace, OAuth via /auth/provider/slack)",
    );
    return { app, mode: "http", router: receiver.router };
  }

  // Socket Mode (single workspace)
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;

  if (botToken && appToken) {
    const receiver = new SocketModeReceiver({
      appToken,
      // Bolt's default processEventErrorHandler logs to Bolt's internal ConsoleLogger
      // which isn't captured by our Axiom pipeline. Override to log to our logger + Sentry
      // so we can see when event processing fails.
      processEventErrorHandler: async ({ error }) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`[slack] Bolt processEvent error: ${errorMessage}`);
        Sentry.captureException(error instanceof Error ? error : new Error(errorMessage));
        return true; // ack the event so Slack doesn't retry indefinitely
      },
    });
    // Increase pong timeout from default 5s — small servers can't always
    // respond in time, causing frequent disconnects and lost action events.
    // SocketModeReceiver doesn't expose clientPingTimeout, and the property
    // is TS-private (but runtime-writable), so we use Object.assign.
    Object.assign(receiver.client, { clientPingTimeoutMS: 30_000 });
    registerSocketModeDiagnostics(receiver.client);

    const app = new App({
      token: botToken,
      receiver,
    });

    app.error(async (error) => {
      logger.error(`[slack] Unhandled Bolt error: ${error.message ?? error}`);
      Sentry.captureException(error);
    });

    registerHandlers(app, repository);

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

      // Verify bot configuration in the background — don't block startup
      const botToken = process.env.SLACK_BOT_TOKEN;
      if (botToken) {
        verifyBotConfiguration(botToken).catch((error) => {
          const msg = error instanceof Error ? error.message : String(error);
          logger.warn(`[slack] Background bot verification failed: ${msg}`);
        });
      }

      // Graceful shutdown: close the Socket Mode WebSocket before the process
      // exits so Slack immediately cleans up this connection.  Without this,
      // container restarts (e.g. Watchtower) leave stale connections and Slack
      // may route events to dead sockets, causing dropped messages.
      process.once("SIGTERM", async () => {
        logger.info("[slack] Shutting down Socket Mode connection (SIGTERM)");
        try {
          await result.app.stop();
        } catch (stopError) {
          const msg = stopError instanceof Error ? stopError.message : String(stopError);
          logger.error(`[slack] Error stopping Slack bot: ${msg}`);
        }
      });
    } else if (result.mode === "http") {
      logger.warn("[slack] HTTP mode requires Express app reference — pass it to startSlackBot()");
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[slack] Failed to start Slack bot: ${errorMessage}`);
  }
}
