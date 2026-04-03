import { randomBytes } from "node:crypto";
import { getOAuthRedirectUri } from "dofek/auth/oauth";
import { sql } from "drizzle-orm";
import type { Router } from "express";
import { z } from "zod";
import { getSessionIdFromRequest } from "../../auth/cookies.ts";
import { validateSession } from "../../auth/session.ts";
import type { OAuthStateEntry } from "../../lib/oauth-state-store.ts";
import { executeWithSchema } from "../../lib/typed-sql.ts";
import { logger } from "../../logger.ts";
import {
  authRateLimiter,
  getDb,
  getOAuthStateStoreRef,
  oauthSuccessHtml,
  SLACK_SCOPES,
} from "./shared.ts";

export async function handleSlackCallback(
  req: import("express").Request,
  res: import("express").Response,
  code: string,
  state: string,
  slackState: OAuthStateEntry | null | undefined,
): Promise<void> {
  const db = getDb();
  const oauthStateStore = getOAuthStateStoreRef();
  await oauthStateStore.delete(state);
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    res.status(400).send("SLACK_CLIENT_ID and SLACK_CLIENT_SECRET must be set");
    return;
  }

  const redirectUri = getOAuthRedirectUri();
  logger.info("[auth] Exchanging Slack OAuth code for bot token...");

  // Exchange code for access token via Slack's oauth.v2.access
  const tokenResponse = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const tokenData: {
    ok: boolean;
    error?: string;
    team?: { id: string; name: string };
    access_token?: string;
    bot_user_id?: string;
    app_id?: string;
    authed_user?: { id: string };
  } = await tokenResponse.json();

  if (!tokenData.ok || !tokenData.access_token || !tokenData.team?.id) {
    res.status(400).send("Slack OAuth failed");
    return;
  }

  // Store the installation
  await db.execute(
    sql`INSERT INTO fitness.slack_installation (
          team_id, team_name, bot_token, bot_user_id, app_id,
          installer_slack_user_id, raw_installation
        ) VALUES (
          ${tokenData.team.id},
          ${tokenData.team.name ?? null},
          ${tokenData.access_token},
          ${tokenData.bot_user_id ?? null},
          ${tokenData.app_id ?? null},
          ${tokenData.authed_user?.id ?? null},
          ${JSON.stringify(tokenData)}::jsonb
        )
        ON CONFLICT (team_id) DO UPDATE SET
          team_name = EXCLUDED.team_name,
          bot_token = EXCLUDED.bot_token,
          bot_user_id = EXCLUDED.bot_user_id,
          app_id = EXCLUDED.app_id,
          installer_slack_user_id = EXCLUDED.installer_slack_user_id,
          raw_installation = EXCLUDED.raw_installation,
          updated_at = NOW()`,
  );

  // Link the installer's Slack identity to the logged-in dofek user
  // so the bot can immediately identify them when they send a message
  const installerSlackUserId = tokenData.authed_user?.id;
  if (installerSlackUserId && slackState) {
    // Check for existing orphaned auth_account pointing to wrong user
    const existingLink = await executeWithSchema(
      db,
      z.object({ user_id: z.string() }),
      sql`SELECT user_id FROM fitness.auth_account
          WHERE auth_provider = 'slack' AND provider_account_id = ${installerSlackUserId}
          LIMIT 1`,
    );
    const existingLinkRow = existingLink[0];
    const orphanUserId =
      existingLinkRow && existingLinkRow.user_id !== slackState.userId
        ? existingLinkRow.user_id
        : null;

    // Create or update the auth_account link
    await db.execute(
      sql`INSERT INTO fitness.auth_account (user_id, auth_provider, provider_account_id)
          VALUES (${slackState.userId}, 'slack', ${installerSlackUserId})
          ON CONFLICT (auth_provider, provider_account_id)
          DO UPDATE SET user_id = EXCLUDED.user_id`,
    );

    // Migrate food entries from orphan user if needed
    if (orphanUserId) {
      await db.execute(
        sql`UPDATE fitness.food_entry SET user_id = ${slackState.userId}
            WHERE user_id = ${orphanUserId}`,
      );
      logger.info(
        `[auth] Migrated food entries from orphan ${orphanUserId} to ${slackState.userId}`,
      );
    }

    logger.info(
      `[auth] Linked Slack user ${installerSlackUserId} to dofek user ${slackState.userId}`,
    );
  }

  logger.info(`[auth] Slack installed for team ${tokenData.team.id} (${tokenData.team.name})`);
  res.send(
    oauthSuccessHtml(
      "Slack",
      `Bot added to ${tokenData.team.name}. Send me a DM about what you ate!`,
    ),
  );
}

export function registerSlackOAuthRoutes(router: Router): void {
  // ── Slack OAuth (Add to Slack) ──
  router.get("/auth/provider/slack", authRateLimiter, async (req, res) => {
    const clientId = process.env.SLACK_CLIENT_ID;
    if (!clientId) {
      res.status(400).send("SLACK_CLIENT_ID is not configured");
      return;
    }

    // Resolve the logged-in user so we can link the Slack identity to them
    const sessionId = getSessionIdFromRequest(req);
    const db = getDb();
    const session = sessionId ? await validateSession(db, sessionId) : null;
    if (!session) {
      res.status(401).send("You must be logged in to connect Slack");
      return;
    }
    const userId = session.userId;

    const redirectUri = getOAuthRedirectUri();
    const stateToken = `slack:${randomBytes(16).toString("hex")}`;
    const oauthStateStore = getOAuthStateStoreRef();
    await oauthStateStore.save(stateToken, {
      providerId: "slack",
      intent: "data",
      userId,
    });
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("scope", SLACK_SCOPES.join(","));
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", stateToken);
    res.redirect(url.toString());
  });
}
