import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/node";
import {
  AccountErasureIdentityFencedError,
  AccountErasureUserFencedError,
  withAccountErasureUserAndIdentityWriteFence,
} from "dofek/db/account-erasure";
import { captureException } from "dofek/lib/error-reporting";
import type { Request, Response } from "express";
import { z } from "zod";
import { findExistingUserId, resolveOrCreateUser } from "../../auth/account-linking.ts";
import { isValidMobileScheme, setSessionCookie } from "../../auth/cookies.ts";
import { revokeProviderCredentials } from "../../auth/provider-credential-revocation.ts";
import { createSession } from "../../auth/session.ts";
import type {
  PendingEmailSignupClaim,
  PendingEmailSignupStore,
} from "../../lib/pending-email-signup-store.ts";
import { logger } from "../../logger.ts";
import {
  completeSignupHtml,
  getDb,
  getMobileAuthExchangeStoreRef,
  getPendingEmailSignupStoreRef,
  getPostLoginRedirect,
  persistProviderConnection,
} from "./shared.ts";

const CLAIM_RENEWAL_INTERVAL_MS = 20 * 1000;

class PendingEmailSignupClaimRenewalError extends Error {
  constructor() {
    super("Pending email signup claim renewal failed");
    this.name = "PendingEmailSignupClaimRenewalError";
  }
}

class PendingEmailSignupClaimRenewal {
  readonly #store: PendingEmailSignupStore;
  readonly #claim: PendingEmailSignupClaim;
  #timer: ReturnType<typeof setInterval> | null;
  #inFlight: Promise<void> | null = null;
  #failure: PendingEmailSignupClaimRenewalError | null = null;

  constructor(store: PendingEmailSignupStore, claim: PendingEmailSignupClaim) {
    this.#store = store;
    this.#claim = claim;
    this.#timer = setInterval(() => this.#renew(), CLAIM_RENEWAL_INTERVAL_MS);
  }

  async stop(): Promise<PendingEmailSignupClaimRenewalError | null> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#inFlight;
    return this.#failure;
  }

  async throwIfFailed(): Promise<void> {
    const inFlight = this.#inFlight;
    await inFlight;
    if (this.#failure) throw this.#failure;
  }

  #renew(): void {
    if (this.#inFlight || this.#failure) return;
    this.#inFlight = Promise.resolve()
      .then(() => this.#store.renew(this.#claim))
      .catch((_error: unknown) => {
        const renewalFailure = new PendingEmailSignupClaimRenewalError();
        captureException(renewalFailure, {
          tags: { context: "pending-email-signup-renewal" },
        });
        this.#failure = renewalFailure;
      })
      .finally(() => {
        this.#inFlight = null;
      });
  }
}

export async function handleCompleteSignup(req: Request, res: Response): Promise<void> {
  let pendingClaim: PendingEmailSignupClaim | null = null;
  let pendingClaimRenewal: PendingEmailSignupClaimRenewal | null = null;
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
    pendingClaimRenewal = new PendingEmailSignupClaimRenewal(pendingStore, pendingClaim);
    const claimedPending = pendingClaim.entry;

    const db = getDb();
    const identity = {
      providerAccountId: claimedPending.identity.providerAccountId,
      email: parsedEmail.data,
      emailVerified: false,
      name: claimedPending.identity.name,
    };
    const { getAllProviders } = await import("dofek/providers/registry");
    await pendingClaimRenewal.throwIfFailed();
    const provider = getAllProviders().find(
      (candidate) => candidate.id === claimedPending.providerId,
    );
    if (!provider) {
      const renewal = pendingClaimRenewal;
      pendingClaimRenewal = null;
      const renewalFailure = await renewal.stop();
      if (renewalFailure) throw renewalFailure;
      await pendingStore.release(pendingClaim);
      pendingClaim = null;
      res.status(500).type("text/plain").send("Provider no longer available");
      return;
    }

    const targetUserId =
      (await findExistingUserId(db, claimedPending.providerId, identity)) ?? randomUUID();
    const activePendingClaimRenewal = pendingClaimRenewal;
    const result = await withAccountErasureUserAndIdentityWriteFence(
      db,
      targetUserId,
      [
        {
          authProvider: claimedPending.providerId,
          kind: "provider_account",
          providerAccountId: identity.providerAccountId,
        },
        { email: parsedEmail.data, kind: "email" },
      ],
      async (transaction) => {
        const resolution = await resolveOrCreateUser(
          transaction,
          claimedPending.providerId,
          identity,
          undefined,
          { newUserId: targetUserId },
        );
        if (resolution.userId !== targetUserId) {
          throw new Error(
            `Pending identity resolution changed from ${targetUserId} to ${resolution.userId}`,
          );
        }
        await activePendingClaimRenewal.throwIfFailed();
        await persistProviderConnection({
          db: transaction,
          provider,
          providerName: claimedPending.providerName,
          apiBaseUrl: claimedPending.apiBaseUrl,
          tokens: claimedPending.tokens,
          userId: resolution.userId,
        });
        await activePendingClaimRenewal.throwIfFailed();
        return {
          ...resolution,
          sessionInfo: await createSession(transaction, resolution.userId),
        };
      },
    );
    const { userId, isNewUser, sessionInfo } = result;
    await pendingClaimRenewal.throwIfFailed();

    if (claimedPending.mobileScheme && isValidMobileScheme(claimedPending.mobileScheme)) {
      const exchangeCode = await getMobileAuthExchangeStoreRef().issue({
        kind: "session",
        sessionId: sessionInfo.sessionId,
        isNewUser,
      });
      await pendingClaimRenewal.throwIfFailed();
      const renewal = pendingClaimRenewal;
      pendingClaimRenewal = null;
      const renewalFailure = await renewal.stop();
      if (renewalFailure) throw renewalFailure;
      await pendingStore.complete(pendingClaim);
      pendingClaim = null;
      logger.info(
        `[auth] User ${userId} completed signup via ${claimedPending.providerId} (mobile)`,
      );
      res.redirect(`${claimedPending.mobileScheme}://auth/callback?code=${exchangeCode}`);
      return;
    }

    const renewal = pendingClaimRenewal;
    pendingClaimRenewal = null;
    const renewalFailure = await renewal.stop();
    if (renewalFailure) throw renewalFailure;
    await pendingStore.complete(pendingClaim);
    pendingClaim = null;
    setSessionCookie(res, sessionInfo.sessionId, sessionInfo.expiresAt);
    logger.info(`[auth] User ${userId} completed signup via ${claimedPending.providerId}`);
    res.redirect(getPostLoginRedirect(claimedPending.returnTo, isNewUser));
  } catch (err: unknown) {
    if (pendingClaimRenewal) {
      const renewalFailure = await pendingClaimRenewal.stop();
      pendingClaimRenewal = null;
      if (renewalFailure && renewalFailure !== err) {
        logger.error("[auth] Pending signup claim renewal failed");
      }
    }
    if (
      (err instanceof AccountErasureIdentityFencedError ||
        err instanceof AccountErasureUserFencedError) &&
      pendingClaim
    ) {
      const fencedClaim = pendingClaim;
      try {
        const { getAllProviders } = await import("dofek/providers/registry");
        const provider = getAllProviders().find(
          (candidate) => candidate.id === fencedClaim.entry.providerId,
        );
        if (!provider) {
          throw new Error(
            `Provider ${fencedClaim.entry.providerId} is unavailable for pending credential revocation`,
          );
        }
        const setup = provider.authSetup?.({ host: req.get("host") });
        await revokeProviderCredentials({
          oauthConfig: setup?.oauthConfig,
          providerId: provider.id,
          revokeExistingTokens: setup?.revokeExistingTokens,
          tokens: fencedClaim.entry.tokens,
        });
        await getPendingEmailSignupStoreRef().complete(fencedClaim);
        pendingClaim = null;
      } catch (cleanupError: unknown) {
        Sentry.captureException(cleanupError, {
          tags: {
            context: "pending-email-signup-fenced-cleanup",
            providerId: fencedClaim.entry.providerId,
          },
        });
        logger.error(`[auth] Fenced pending signup credential cleanup failed: ${cleanupError}`);
        res
          .status(500)
          .type("text/plain")
          .send("Signup credential cleanup failed — please try again");
        return;
      }
      res.status(409).type("text/plain").send(err.message);
      return;
    }
    if (pendingClaim) {
      try {
        await getPendingEmailSignupStoreRef().release(pendingClaim);
      } catch (releaseError: unknown) {
        captureException(releaseError, {
          tags: { context: "pending-email-signup-release" },
        });
        logger.error(`[auth] Releasing pending signup claim failed: ${releaseError}`);
      }
    }
    if (err instanceof PendingEmailSignupClaimRenewalError) {
      logger.error("[auth] Pending signup claim renewal failed");
    } else {
      captureException(err);
      logger.error(`[auth] Completing signup failed: ${err}`);
    }
    res.status(500).send("Signup failed — please try again");
  }
}
