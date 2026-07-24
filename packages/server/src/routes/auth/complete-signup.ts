import * as Sentry from "@sentry/node";
import type { Request, Response } from "express";
import { z } from "zod";
import { resolveOrCreateUser } from "../../auth/account-linking.ts";
import { isValidMobileScheme, setSessionCookie } from "../../auth/cookies.ts";
import { createSession } from "../../auth/session.ts";
import type { PendingEmailSignupClaim } from "../../lib/pending-email-signup-store.ts";
import { logger } from "../../logger.ts";
import {
  completeSignupHtml,
  getDb,
  getMobileAuthExchangeStoreRef,
  getPendingEmailSignupStoreRef,
  getPostLoginRedirect,
  persistProviderConnection,
} from "./shared.ts";

export async function handleCompleteSignup(req: Request, res: Response): Promise<void> {
  let pendingClaim: PendingEmailSignupClaim | null = null;
  try {
    const token = typeof req.body.token === "string" ? req.body.token : undefined;
    const rawEmail = typeof req.body.email === "string" ? req.body.email : "";
    if (!token) {
      res.status(400).type("text/plain").send("Missing signup token");
      return;
    }

    const pendingStore = getPendingEmailSignupStoreRef();
    const pending = await pendingStore.get(token);
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

    pendingClaim = await pendingStore.claim(token);
    if (!pendingClaim) {
      if (!(await pendingStore.get(token))) {
        res.status(400).type("text/plain").send("Signup session expired — please try again");
        return;
      }
      res
        .status(409)
        .type("text/plain")
        .send("Signup is already being completed — please try again");
      return;
    }
    const claimedPending = pendingClaim.entry;

    const db = getDb();
    const { userId, isNewUser } = await resolveOrCreateUser(db, claimedPending.providerId, {
      providerAccountId: claimedPending.identity.providerAccountId,
      email: parsedEmail.data,
      emailVerified: false,
      name: claimedPending.identity.name,
    });
    const { getAllProviders } = await import("dofek/providers/registry");
    const provider = getAllProviders().find(
      (candidate) => candidate.id === claimedPending.providerId,
    );
    if (!provider) {
      await pendingStore.release(pendingClaim);
      pendingClaim = null;
      res.status(500).type("text/plain").send("Provider no longer available");
      return;
    }

    await persistProviderConnection({
      db,
      provider,
      providerName: claimedPending.providerName,
      apiBaseUrl: claimedPending.apiBaseUrl,
      tokens: claimedPending.tokens,
      userId,
    });
    const sessionInfo = await createSession(db, userId);

    if (claimedPending.mobileScheme && isValidMobileScheme(claimedPending.mobileScheme)) {
      const exchangeCode = await getMobileAuthExchangeStoreRef().issue({
        kind: "session",
        sessionId: sessionInfo.sessionId,
        isNewUser,
      });
      await pendingStore.complete(pendingClaim);
      pendingClaim = null;
      logger.info(
        `[auth] User ${userId} completed signup via ${claimedPending.providerId} (mobile)`,
      );
      res.redirect(`${claimedPending.mobileScheme}://auth/callback?code=${exchangeCode}`);
      return;
    }

    await pendingStore.complete(pendingClaim);
    pendingClaim = null;
    setSessionCookie(res, sessionInfo.sessionId, sessionInfo.expiresAt);
    logger.info(`[auth] User ${userId} completed signup via ${claimedPending.providerId}`);
    res.redirect(getPostLoginRedirect(claimedPending.returnTo, isNewUser));
  } catch (err: unknown) {
    if (pendingClaim) {
      try {
        await getPendingEmailSignupStoreRef().release(pendingClaim);
      } catch (releaseError: unknown) {
        Sentry.captureException(releaseError, {
          tags: { context: "pending-email-signup-release" },
        });
        logger.error(`[auth] Releasing pending signup claim failed: ${releaseError}`);
      }
    }
    Sentry.captureException(err);
    logger.error(`[auth] Completing signup failed: ${err}`);
    res.status(500).send("Signup failed — please try again");
  }
}
