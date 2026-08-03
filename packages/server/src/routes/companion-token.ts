import { PasswordLoginRequestSchema } from "@dofek/auth/auth";
import type { Database } from "dofek/db";
import {
  AccountErasureUserFencedError,
  withAccountErasureUserWriteFence,
} from "dofek/db/account-erasure";
import { captureException } from "dofek/lib/error-reporting";
import express, { Router } from "express";
import { z } from "zod";
import { authenticatePasswordUser, InvalidCredentialsError } from "../auth/password-credential.ts";
import { companionConnectionTypeSchema } from "../companion/connection-type.ts";
import {
  getActiveCompanionTokenByToken,
  regenerateCompanionTokenInTransaction,
  revokeCompanionTokenByToken,
} from "../companion/token-repository.ts";
import { companionConnectionOperationsTotal } from "../lib/metrics.ts";
import { logger } from "../logger.ts";

const companionPasswordLoginSchema = PasswordLoginRequestSchema.and(
  z.object({ connectionType: companionConnectionTypeSchema }),
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
      const missingConnectionType =
        typeof req.body === "object" &&
        req.body !== null &&
        !Array.isArray(req.body) &&
        !("connectionType" in req.body);
      sendJson(res, 400, {
        error: missingConnectionType
          ? "Update the Zepp package before connecting to Dofek."
          : "Invalid login details",
      });
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
        (transaction) =>
          regenerateCompanionTokenInTransaction(transaction, userId, parsed.data.connectionType),
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
      captureException(error);
      logger.error(`[companion-token] Password login failed: ${error}`);
      sendJson(res, 500, { error: "Failed to create Dofek connection." });
    }
  });

  router.get("/current", async (req, res) => {
    const token = readBearerToken(req);
    if (!token) {
      companionConnectionOperationsTotal.inc({
        operation: "verify",
        outcome: "missing_credentials",
      });
      sendJson(res, 401, { error: "Dofek connection is required." });
      return;
    }
    try {
      const connection = await getActiveCompanionTokenByToken(deps.db, token);
      if (!connection) {
        companionConnectionOperationsTotal.inc({
          operation: "verify",
          outcome: "invalid_credentials",
        });
        sendJson(res, 401, { error: "Invalid or revoked Dofek connection." });
        return;
      }
      companionConnectionOperationsTotal.inc({ operation: "verify", outcome: "success" });
      sendJson(res, 200, {
        state: "connected",
        connectionType: connection.connectionType,
      });
    } catch (error) {
      companionConnectionOperationsTotal.inc({ operation: "verify", outcome: "error" });
      captureException(error);
      logger.error(`[companion-token] Connection validation failed: ${error}`);
      sendJson(res, 500, { error: "Failed to validate Dofek connection." });
    }
  });

  router.delete("/current", async (req, res) => {
    const token = readBearerToken(req);
    if (!token) {
      companionConnectionOperationsTotal.inc({
        operation: "revoke",
        outcome: "missing_credentials",
      });
      sendJson(res, 401, { error: "Dofek connection is required." });
      return;
    }
    try {
      const revoked = await revokeCompanionTokenByToken(deps.db, token);
      if (!revoked) {
        companionConnectionOperationsTotal.inc({
          operation: "revoke",
          outcome: "invalid_credentials",
        });
        sendJson(res, 401, { error: "Invalid or revoked Dofek connection." });
        return;
      }
      companionConnectionOperationsTotal.inc({ operation: "revoke", outcome: "success" });
      sendJson(res, 200, { state: "disconnected" });
    } catch (error) {
      companionConnectionOperationsTotal.inc({ operation: "revoke", outcome: "error" });
      captureException(error);
      logger.error(`[companion-token] Connection revocation failed: ${error}`);
      sendJson(res, 500, { error: "Failed to disconnect Dofek." });
    }
  });

  return router;
}
