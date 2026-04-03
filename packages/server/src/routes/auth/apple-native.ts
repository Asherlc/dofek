import * as Sentry from "@sentry/node";
import type { Request, Response } from "express";
import { resolveOrCreateUser } from "../../auth/account-linking.ts";
import { getIdentityProvider, isProviderConfigured } from "../../auth/providers.ts";
import { createSession } from "../../auth/session.ts";
import { logger } from "../../logger.ts";
import { getDb } from "./shared.ts";

// ── Native Apple Sign In (iOS) ──
// iOS uses ASAuthorizationController which returns an authorization code + identity token directly.
// This endpoint exchanges the code for tokens and creates a session.
export async function handleAppleNativeSignIn(req: Request, res: Response): Promise<void> {
  try {
    if (!isProviderConfigured("apple")) {
      res.status(400).send("Apple Sign In is not configured");
      return;
    }

    const authorizationCode =
      typeof req.body.authorizationCode === "string" ? req.body.authorizationCode : undefined;
    if (!authorizationCode) {
      res.status(400).send("Missing authorizationCode");
      return;
    }

    // Apple only provides name on first sign-in; the native SDK returns it separately
    const givenName = typeof req.body.givenName === "string" ? req.body.givenName : undefined;
    const familyName = typeof req.body.familyName === "string" ? req.body.familyName : undefined;
    const fullName = [givenName, familyName].filter(Boolean).join(" ") || null;

    const provider = getIdentityProvider("apple");
    // Apple doesn't use PKCE, so pass empty string as codeVerifier
    const { user: identityUser } = await provider.validateCallback(authorizationCode, "");

    // Use the name from the native SDK if the identity token didn't include it
    const userName = identityUser.name ?? fullName;

    const db = getDb();
    const { userId } = await resolveOrCreateUser(db, "apple", {
      providerAccountId: identityUser.sub,
      email: identityUser.email,
      name: userName,
      groups: identityUser.groups,
    });

    const sessionInfo = await createSession(db, userId);
    logger.info(`[auth] User ${userId} logged in via native Apple Sign In`);
    res.json({ session: sessionInfo.sessionId });
  } catch (err: unknown) {
    Sentry.captureException(err);
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[auth] Native Apple Sign In failed: ${message}`);
    res.status(500).send("Apple Sign In failed — please try again");
  }
}
