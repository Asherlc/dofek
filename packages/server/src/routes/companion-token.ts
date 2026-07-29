import { PasswordLoginRequestSchema } from "@dofek/auth/auth";
import * as Sentry from "@sentry/node";
import type { Database } from "dofek/db";
import express, { Router } from "express";
import { z } from "zod";
import { authenticatePasswordUser, InvalidCredentialsError } from "../auth/password-credential.ts";
import {
  companionConnectionTypeSchema,
  DEFAULT_COMPANION_CONNECTION_TYPE,
} from "../companion/connection-type.ts";
import {
  getActiveCompanionTokenByToken,
  regenerateCompanionToken,
  revokeCompanionTokenByToken,
} from "../companion/token-repository.ts";
import { logger } from "../logger.ts";

const companionPasswordLoginSchema = PasswordLoginRequestSchema.and(
  z.object({ connectionType: companionConnectionTypeSchema.optional() }),
);

function sendJson(res: import("express").Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

function readBearerToken(req: import("express").Request): string | null {
  const authorization = req.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token || null;
}

export function createCompanionTokenHttpRouter(deps: { db: Database }): Router {
  const router = Router();

  router.post("/password-login", express.json(), async (req, res) => {
    const parsed = companionPasswordLoginSchema.safeParse(req.body);
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
      const companionToken = await regenerateCompanionToken(
        deps.db,
        userId,
        parsed.data.connectionType ?? DEFAULT_COMPANION_CONNECTION_TYPE,
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
      Sentry.captureException(error);
      logger.error(`[companion-token] Password login failed: ${error}`);
      sendJson(res, 500, { error: "Failed to create Dofek connection." });
    }
  });

  router.get("/current", async (req, res) => {
    const token = readBearerToken(req);
    if (!token) {
      sendJson(res, 401, { error: "Dofek connection is required." });
      return;
    }
    try {
      const connection = await getActiveCompanionTokenByToken(deps.db, token);
      if (!connection) {
        sendJson(res, 401, { error: "Invalid or revoked Dofek connection." });
        return;
      }
      sendJson(res, 200, {
        state: "connected",
        connectionType: connection.connectionType,
      });
    } catch (error) {
      Sentry.captureException(error);
      logger.error(`[companion-token] Connection validation failed: ${error}`);
      sendJson(res, 500, { error: "Failed to validate Dofek connection." });
    }
  });

  router.delete("/current", async (req, res) => {
    const token = readBearerToken(req);
    if (!token) {
      sendJson(res, 401, { error: "Dofek connection is required." });
      return;
    }
    try {
      const revoked = await revokeCompanionTokenByToken(deps.db, token);
      if (!revoked) {
        sendJson(res, 401, { error: "Invalid or revoked Dofek connection." });
        return;
      }
      sendJson(res, 200, { state: "disconnected" });
    } catch (error) {
      Sentry.captureException(error);
      logger.error(`[companion-token] Connection revocation failed: ${error}`);
      sendJson(res, 500, { error: "Failed to disconnect Dofek." });
    }
  });

  return router;
}
