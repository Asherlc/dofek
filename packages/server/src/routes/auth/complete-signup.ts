import * as Sentry from "@sentry/node";
import type { Request, Response } from "express";
import { z } from "zod";
import { resolveOrCreateUser } from "../../auth/account-linking.ts";
import { isValidMobileScheme, setSessionCookie } from "../../auth/cookies.ts";
import { createSession } from "../../auth/session.ts";
import { logger } from "../../logger.ts";
import {
  completeSignupHtml,
  deletePendingEmailSignup,
  getDb,
  getPendingEmailSignup,
  persistProviderConnection,
  sanitizeReturnTo,
} from "./shared.ts";

export async function handleCompleteSignup(req: Request, res: Response): Promise<void> {
  try {
    const token = typeof req.body.token === "string" ? req.body.token : undefined;
    const rawEmail = typeof req.body.email === "string" ? req.body.email : "";
    if (!token) {
      res.status(400).type("text/plain").send("Missing signup token");
      return;
    }

    const pending = getPendingEmailSignup(token);
    if (!pending) {
      res.status(400).type("text/plain").send("Signup session expired — please try again");
      return;
    }

    const parsedEmail = z.string().trim().email().safeParse(rawEmail);
    if (!parsedEmail.success) {
      res
        .status(400)
        .send(
          completeSignupHtml(pending.providerName, token, rawEmail, "Enter a valid email address."),
        );
      return;
    }

    const db = getDb();
    const { userId } = await resolveOrCreateUser(db, pending.providerId, {
      providerAccountId: pending.identity.providerAccountId,
      email: parsedEmail.data,
      name: pending.identity.name,
    });
    const { getAllProviders } = await import("dofek/providers/registry");
    const provider = getAllProviders().find((candidate) => candidate.id === pending.providerId);
    if (!provider) {
      res.status(500).type("text/plain").send("Provider no longer available");
      return;
    }

    await persistProviderConnection({
      db,
      provider,
      providerName: pending.providerName,
      apiBaseUrl: pending.apiBaseUrl,
      tokens: pending.tokens,
      userId,
    });
    const sessionInfo = await createSession(db, userId);
    deletePendingEmailSignup(token);

    if (pending.mobileScheme && isValidMobileScheme(pending.mobileScheme)) {
      logger.info(`[auth] User ${userId} completed signup via ${pending.providerId} (mobile)`);
      res.redirect(`${pending.mobileScheme}://auth/callback?session=${sessionInfo.sessionId}`);
      return;
    }

    setSessionCookie(res, sessionInfo.sessionId, sessionInfo.expiresAt);
    logger.info(`[auth] User ${userId} completed signup via ${pending.providerId}`);
    res.redirect(sanitizeReturnTo(pending.returnTo) ?? "/");
  } catch (err: unknown) {
    Sentry.captureException(err);
    logger.error(`[auth] Completing signup failed: ${err}`);
    res.status(500).send("Signup failed — please try again");
  }
}
