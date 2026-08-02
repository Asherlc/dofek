import { randomBytes } from "node:crypto";
import * as Sentry from "@sentry/node";
import { getOAuthRedirectUri } from "dofek/auth/oauth";
import {
  AccountErasureIdentityFencedError,
  AccountErasureUserFencedError,
  lockAndAssertAccountErasureIdentityWriteFence,
  withAccountErasureUserWriteFence,
} from "dofek/db/account-erasure";
import { invalidateAllUserQueries } from "dofek/lib/cache";
import { sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { z } from "zod";
import { getSessionIdFromRequest } from "../../auth/cookies.ts";
import { validateSession } from "../../auth/session.ts";
import type { OAuthStateEntry } from "../../lib/oauth-state-store.ts";
import { executeWithSchema } from "../../lib/typed-sql.ts";
import { logger } from "../../logger.ts";
import { SlackInstallationRepository } from "../../repositories/slack-installation-repository.ts";
import {
  getDb,
  getMobileAuthExchangeStoreRef,
  getOAuthStateStoreRef,
  oauthSuccessHtml,
  SLACK_SCOPES,
} from "./shared.ts";

const slackTokenResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  team: z.object({ id: z.string(), name: z.string().optional() }).optional(),
  access_token: z.string().optional(),
  bot_user_id: z.string().optional(),
  app_id: z.string().optional(),
  authed_user: z.object({ id: z.string() }).optional(),
});
const slackRevokeResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});

async function revokeSlackBotToken(token: string): Promise<void> {
  const response = await fetch("https://slack.com/api/auth.revoke", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const result = slackRevokeResponseSchema.parse(await response.json());
  if (!response.ok || !result.ok) {
    throw new Error("Slack token revocation failed");
  }
}

export async function handleSlackCallback(
  _req: Request,
  res: Response,
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
  if (!slackState) {
    res.status(400).send("Unknown or expired Slack OAuth state");
    return;
  }

  const redirectUri = getOAuthRedirectUri();
  let issuedBotToken: string | null = null;
  const usersWithInvalidatedCaches = new Set<string>();
  let tokenData: z.infer<typeof slackTokenResponseSchema> | null;
  try {
    tokenData = await withAccountErasureUserWriteFence(
      db,
      slackState.userId,
      async (transaction) => {
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
        const parsedTokenData = slackTokenResponseSchema.parse(await tokenResponse.json());
        issuedBotToken = parsedTokenData.access_token ?? null;

        if (
          !parsedTokenData.ok ||
          !parsedTokenData.access_token ||
          !parsedTokenData.team?.id ||
          !parsedTokenData.authed_user?.id
        ) {
          return null;
        }

        const installerSlackUserId = parsedTokenData.authed_user.id;
        await lockAndAssertAccountErasureIdentityWriteFence(transaction, [
          {
            authProvider: "slack",
            kind: "provider_account",
            providerAccountId: installerSlackUserId,
          },
        ]);
        const slackInstallationRepository = new SlackInstallationRepository(transaction);

        await slackInstallationRepository.upsertMemberInstallation({
          teamId: parsedTokenData.team.id,
          teamName: parsedTokenData.team.name ?? null,
          botToken: parsedTokenData.access_token,
          botId: null,
          botUserId: parsedTokenData.bot_user_id ?? null,
          appId: parsedTokenData.app_id ?? null,
          installerSlackUserId: parsedTokenData.authed_user?.id ?? null,
          rawInstallation: parsedTokenData,
          slackUserId: installerSlackUserId,
          userId: slackState.userId,
        });

        // Link the installer's Slack identity to the logged-in dofek user
        // so the bot can immediately identify them when they send a message
        // Check for existing orphaned auth_account pointing to wrong user
        const existingLink = await executeWithSchema(
          transaction,
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
        await transaction.execute(
          sql`INSERT INTO fitness.auth_account (user_id, auth_provider, provider_account_id)
              VALUES (${slackState.userId}, 'slack', ${installerSlackUserId})
              ON CONFLICT (auth_provider, provider_account_id)
              DO UPDATE SET user_id = EXCLUDED.user_id`,
        );

        // Migrate food entries from orphan user if needed
        if (orphanUserId) {
          await transaction.execute(
            sql`UPDATE fitness.food_entry SET user_id = ${slackState.userId}
                WHERE user_id = ${orphanUserId}`,
          );
          usersWithInvalidatedCaches.add(orphanUserId);
          logger.info("[auth] Migrated orphaned Slack food entries to the linked account");
        }

        usersWithInvalidatedCaches.add(slackState.userId);
        logger.info("[auth] Linked Slack identity to the authenticated account");
        return parsedTokenData;
      },
    );
  } catch (persistenceError: unknown) {
    const isFenceRejection =
      persistenceError instanceof AccountErasureUserFencedError ||
      persistenceError instanceof AccountErasureIdentityFencedError;
    if (isFenceRejection) {
      logger.warn("[auth] Slack OAuth rejected by account-erasure fence");
    } else {
      Sentry.captureException(persistenceError, {
        tags: { source: "slack-oauth", operation: "persist-installation" },
      });
    }
    if (issuedBotToken) {
      try {
        await revokeSlackBotToken(issuedBotToken);
      } catch (cleanupError: unknown) {
        Sentry.captureException(cleanupError, {
          tags: { source: "slack-oauth", operation: "revoke-orphan-bot-token" },
        });
      }
    }
    throw persistenceError;
  }

  await Promise.all(
    [...usersWithInvalidatedCaches].map((userId) => invalidateAllUserQueries(userId)),
  );

  if (!tokenData) {
    if (issuedBotToken) {
      try {
        await revokeSlackBotToken(issuedBotToken);
      } catch (cleanupError: unknown) {
        Sentry.captureException(cleanupError, {
          tags: { source: "slack-oauth", operation: "revoke-invalid-response-token" },
        });
      }
    }
    res.status(400).send("Slack OAuth failed");
    return;
  }
  const installedTeam = tokenData.team;
  if (!installedTeam) {
    throw new Error("Slack OAuth response lost its validated team");
  }

  logger.info("[auth] Slack installation persisted");
  res.send(
    oauthSuccessHtml(
      "Slack",
      `Bot added to ${installedTeam.name}. Send me a DM about what you ate!`,
    ),
  );
}

// ── Slack OAuth (Add to Slack) ──
export async function handleSlackOAuthStart(req: Request, res: Response): Promise<void> {
  const clientId = process.env.SLACK_CLIENT_ID;
  if (!clientId) {
    res.status(400).send("SLACK_CLIENT_ID is not configured");
    return;
  }

  // Resolve the logged-in user so we can link the Slack identity to them
  const handoffCode = typeof req.query.code === "string" ? req.query.code : undefined;
  const handoff = handoffCode ? await getMobileAuthExchangeStoreRef().consume(handoffCode) : null;
  if (handoffCode && (!handoff || handoff.kind !== "provider" || handoff.providerId !== "slack")) {
    res.status(401).send("Invalid Slack handoff code");
    return;
  }
  const sessionId = handoff?.kind === "provider" ? undefined : getSessionIdFromRequest(req);
  const db = getDb();
  const session =
    handoff?.kind === "provider"
      ? { userId: handoff.userId }
      : sessionId
        ? await validateSession(db, sessionId)
        : null;
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
}
