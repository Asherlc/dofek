import { PasswordLoginRequestSchema } from "@dofek/auth/auth";
import * as Sentry from "@sentry/node";
import type { Database } from "dofek/db";
import {
  AccountErasureUserFencedError,
  withAccountErasureUserWriteFence,
} from "dofek/db/account-erasure";
import express, { Router } from "express";
import { authenticatePasswordUser, InvalidCredentialsError } from "../auth/password-credential.ts";
import { regenerateCompanionTokenInTransaction } from "../companion/token-repository.ts";
import { logger } from "../logger.ts";

function sendJson(res: import("express").Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

export function createCompanionTokenHttpRouter(deps: { db: Database }): Router {
  const router = Router();

  router.post("/password-login", express.json(), async (req, res) => {
    const parsed = PasswordLoginRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendJson(res, 400, { error: "Invalid login details" });
      return;
    }

    try {
      const { userId } = await authenticatePasswordUser(
        deps.db,
        parsed.data.email,
        parsed.data.password,
      );
      const companionToken = await withAccountErasureUserWriteFence(
        deps.db,
        userId,
        (transaction) => regenerateCompanionTokenInTransaction(transaction, userId),
      );
      if (!companionToken.token) {
        throw new Error("Companion token was regenerated without returning a token");
      }
      sendJson(res, 200, companionToken);
    } catch (error: unknown) {
      if (error instanceof InvalidCredentialsError) {
        sendJson(res, 401, { error: error.message });
        return;
      }
      if (error instanceof AccountErasureUserFencedError) {
        sendJson(res, 409, { error: error.message });
        return;
      }
      Sentry.captureException(error);
      logger.error(`[companion-token] Password login failed: ${error}`);
      sendJson(res, 500, { error: "Failed to create Dofek connection." });
    }
  });

  return router;
}
