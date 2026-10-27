import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/node";
import { revokeAppleCredential } from "dofek/auth/apple-credential-revocation";
import {
  AccountErasureIdentityFencedError,
  AccountErasureUserFencedError,
  withAccountErasureUserAndIdentityWriteFence,
} from "dofek/db/account-erasure";
import { captureException } from "dofek/lib/error-reporting";
import type { Request, Response } from "express";
import { findExistingUserId, resolveOrCreateUser } from "../../auth/account-linking.ts";
import { isNativeAppleConfigured, validateNativeAppleCallback } from "../../auth/providers.ts";
import { createSession } from "../../auth/session.ts";
import { logger } from "../../logger.ts";
import { getDb } from "./shared.ts";

// ── Native Apple Sign In (iOS) ──
// iOS uses ASAuthorizationController which returns an authorization code + identity token directly.
// This endpoint exchanges the code for tokens and creates a session.
export async function handleAppleNativeSignIn(req: Request, res: Response): Promise<void> {
  try {
    if (!isNativeAppleConfigured()) {
      res.status(400).send("Native Apple Sign In is not configured");
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

    // Native auth codes use the app's Bundle ID, not the web Services ID,
    // and must be exchanged without a redirect_uri
    const { revocationCredential, user: identityUser } =
      await validateNativeAppleCallback(authorizationCode);

    // Use the name from the native SDK if the identity token didn't include it
    const userName = identityUser.name ?? fullName;

    const identity = {
      providerAccountId: identityUser.sub,
      email: identityUser.email,
      emailVerified: identityUser.emailVerified,
      name: userName,
      groups: identityUser.groups,
      revocationCredential,
    };
    const externalIdentities: Parameters<
      typeof withAccountErasureUserAndIdentityWriteFence
    >[2][number][] = [
      {
        authProvider: "apple",
        kind: "provider_account",
        providerAccountId: identity.providerAccountId,
      },
    ];
    if (identity.emailVerified && identity.email) {
      externalIdentities.push({ email: identity.email, kind: "email" });
    }
    const db = getDb();
    let result: {
      isNewUser: boolean;
      sessionInfo: Awaited<ReturnType<typeof createSession>>;
      userId: string;
    };
    try {
      const targetUserId = (await findExistingUserId(db, "apple", identity)) ?? randomUUID();
      result = await withAccountErasureUserAndIdentityWriteFence(
        db,
        targetUserId,
        externalIdentities,
        async (transaction) => {
          const { userId, isNewUser } = await resolveOrCreateUser(
            transaction,
            "apple",
            identity,
            undefined,
            { newUserId: targetUserId },
          );
          if (userId !== targetUserId) {
            throw new Error(`Apple identity resolution changed from ${targetUserId} to ${userId}`);
          }
          return {
            userId,
            isNewUser,
            sessionInfo: await createSession(transaction, userId),
          };
        },
      );
    } catch (persistenceError: unknown) {
      try {
        await revokeAppleCredential(revocationCredential);
      } catch (cleanupError: unknown) {
        Sentry.captureException(cleanupError, {
          tags: {
            source: "apple-native-callback",
            operation: "revoke-orphan-credentials",
          },
        });
      }
      throw persistenceError;
    }

    const { userId, isNewUser, sessionInfo } = result;
    logger.info(`[auth] User ${userId} logged in via native Apple Sign In`);
    res.json({ session: sessionInfo.sessionId, isNewUser });
  } catch (err: unknown) {
    if (
      err instanceof AccountErasureIdentityFencedError ||
      err instanceof AccountErasureUserFencedError
    ) {
      res
        .status(409)
        .type("text/plain")
        .send(
          err instanceof AccountErasureIdentityFencedError
            ? "This identity belongs to an account that is currently being deleted. Try again after deletion completes."
            : "Account deletion is active for this user.",
        );
      return;
    }
    captureException(err);
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[auth] Native Apple Sign In failed: ${message}`);
    res.status(500).send("Apple Sign In failed — please try again");
  }
}
