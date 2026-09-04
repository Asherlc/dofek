import type { Database } from "dofek/db";
import { captureException } from "dofek/lib/error-reporting";
import express, { Router } from "express";
import QRCode from "qrcode";
import { z } from "zod";
import { companionConnectionTypeSchema } from "../companion/connection-type.ts";
import {
  type CompanionPairingStore,
  getCompanionPairingStore,
} from "../lib/companion-pairing-store.ts";
import { getPublicUrlOrigin } from "../lib/public-url.ts";
import { logger } from "../logger.ts";

const pairingStartSchema = z.object({
  connectionType: companionConnectionTypeSchema,
});

function sendJson(res: import("express").Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

function buildVerificationUrl(origin: string, shortCode: string): string {
  const url = new URL("/zepp-pairing", origin);
  url.searchParams.set("code", shortCode);
  return url.toString();
}

function buildQrImageUrl(origin: string, pairingId: string): string {
  const url = new URL(`/api/companion-pairing/qr/${encodeURIComponent(pairingId)}.svg`, origin);
  return url.toString();
}

function requireSecureProductionOrigin(origin: string): void {
  if (process.env.NODE_ENV === "production" && new URL(origin).protocol !== "https:") {
    throw new Error("PUBLIC_URL environment variable must use https in production");
  }
}

export function createCompanionPairingRouter(deps: {
  db: Database;
  store?: CompanionPairingStore;
}): Router {
  const router = Router();
  const store = deps.store ?? getCompanionPairingStore();
  const publicOrigin = getPublicUrlOrigin();
  requireSecureProductionOrigin(publicOrigin);

  router.post("/start", express.json(), async (req, res) => {
    const parsed = pairingStartSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const missingConnectionType =
        !Array.isArray(req.body) && !Object.hasOwn(req.body ?? {}, "connectionType");
      sendJson(res, 400, {
        error: missingConnectionType
          ? "Update the Zepp package before connecting to Dofek."
          : "Invalid pairing request",
      });
      return;
    }

    try {
      const connectionType = parsed.data.connectionType;
      const challenge = await store.createChallenge(undefined, connectionType);
      sendJson(res, 200, {
        pairingId: challenge.id,
        shortCode: challenge.shortCode,
        connectionType: challenge.connectionType,
        verificationUrl: buildVerificationUrl(publicOrigin, challenge.shortCode),
        qrImageUrl: buildQrImageUrl(publicOrigin, challenge.id),
        expiresAt: challenge.expiresAt,
      });
    } catch (error) {
      captureException(error);
      logger.error(`[companion-pairing] Failed to start pairing: ${error}`);
      sendJson(res, 500, { error: "Failed to start companion pairing." });
    }
  });

  router.get("/status/:pairingId", async (req, res) => {
    const pairingId =
      typeof req.params.pairingId === "string" ? req.params.pairingId.trim() : undefined;
    if (!pairingId) {
      res.set("Cache-Control", "no-store");
      sendJson(res, 400, { error: "Pairing ID is required." });
      return;
    }

    try {
      res.set("Cache-Control", "no-store");
      const challenge = await store.getById(pairingId);
      if (!challenge) {
        sendJson(res, 404, { state: "expired" });
        return;
      }

      if (challenge.claimedAt && challenge.companionToken) {
        sendJson(res, 200, {
          state: "claimed",
          connectionType: challenge.connectionType,
          companionToken: challenge.companionToken,
          claimedAt: challenge.claimedAt,
          expiresAt: challenge.expiresAt,
        });
        return;
      }

      sendJson(res, 200, {
        state: "pending",
        connectionType: challenge.connectionType,
        shortCode: challenge.shortCode,
        expiresAt: challenge.expiresAt,
      });
    } catch (error) {
      captureException(error);
      logger.error(`[companion-pairing] Failed to read pairing status: ${error}`);
      res.set("Cache-Control", "no-store");
      sendJson(res, 500, { error: "Failed to read companion pairing status." });
    }
  });

  router.get("/qr/:pairingId.svg", async (req, res) => {
    const pairingId =
      typeof req.params.pairingId === "string" ? req.params.pairingId.trim() : undefined;
    res.set("Cache-Control", "no-store");
    if (!pairingId) {
      res.status(400).type("text/plain").send("Pairing ID is required.");
      return;
    }

    try {
      const challenge = await store.getById(pairingId);
      if (!challenge) {
        res.status(404).type("text/plain").send("Pairing code expired.");
        return;
      }
      const svg = await QRCode.toString(buildVerificationUrl(publicOrigin, challenge.shortCode), {
        type: "svg",
        errorCorrectionLevel: "M",
        margin: 2,
        width: 320,
      });
      res.type("image/svg+xml").send(svg);
    } catch (error) {
      captureException(error);
      logger.error(`[companion-pairing] Failed to render QR code: ${error}`);
      res.status(500).type("text/plain").send("Failed to render pairing QR code.");
    }
  });

  return router;
}
