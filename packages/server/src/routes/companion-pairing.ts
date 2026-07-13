import * as Sentry from "@sentry/node";
import type { Database } from "dofek/db";
import express, { Router } from "express";
import QRCode from "qrcode";
import { z } from "zod";
import {
  type CompanionPairingStore,
  getCompanionPairingStore,
} from "../lib/companion-pairing-store.ts";
import { logger } from "../logger.ts";

const pairingStartSchema = z.object({
  deviceName: z.string().trim().min(1).optional(),
});

function sendJson(res: import("express").Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

function getFirstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") {
    return value.split(",")[0]?.trim();
  }
  return value?.[0]?.trim();
}

function getPublicOrigin(req: import("express").Request): string {
  const envOrigin = process.env.PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  if (envOrigin) {
    try {
      return new URL(envOrigin).origin;
    } catch {
      throw new Error("PUBLIC_APP_URL environment variable must be a valid URL");
    }
  }

  const forwardedProto = getFirstHeaderValue(req.headers["x-forwarded-proto"]);
  const forwardedHost = getFirstHeaderValue(req.headers["x-forwarded-host"]);
  const proto = forwardedProto ?? req.protocol;
  const host = forwardedHost ?? req.headers.host;
  if (host) {
    return `${proto}://${host}`;
  }
  return "http://localhost:3000";
}

function buildVerificationUrl(origin: string, shortCode: string): string {
  const url = new URL("/settings", origin);
  url.searchParams.set("zeppPair", shortCode);
  return url.toString();
}

function buildQrImageUrl(origin: string, pairingId: string): string {
  const url = new URL(`/api/companion-pairing/qr/${encodeURIComponent(pairingId)}.svg`, origin);
  return url.toString();
}

export function createCompanionPairingRouter(deps: {
  db: Database;
  store?: CompanionPairingStore;
}): Router {
  const router = Router();
  const store = deps.store ?? getCompanionPairingStore();

  router.post("/start", express.json(), async (req, res) => {
    const parsed = pairingStartSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendJson(res, 400, { error: "Invalid pairing request" });
      return;
    }

    try {
      const challenge = await store.createChallenge();
      const origin = getPublicOrigin(req);
      sendJson(res, 200, {
        pairingId: challenge.id,
        shortCode: challenge.shortCode,
        verificationUrl: buildVerificationUrl(origin, challenge.shortCode),
        qrImageUrl: buildQrImageUrl(origin, challenge.id),
        expiresAt: challenge.expiresAt,
      });
    } catch (error) {
      Sentry.captureException(error);
      logger.error(`[companion-pairing] Failed to start pairing: ${error}`);
      sendJson(res, 500, { error: "Failed to start companion pairing." });
    }
  });

  router.get("/status/:pairingId", async (req, res) => {
    const pairingId =
      typeof req.params.pairingId === "string" ? req.params.pairingId.trim() : undefined;
    if (!pairingId) {
      sendJson(res, 400, { error: "Pairing ID is required." });
      return;
    }

    try {
      const challenge = await store.getById(pairingId);
      if (!challenge) {
        sendJson(res, 404, { state: "expired" });
        return;
      }

      if (challenge.claimedAt && challenge.companionToken) {
        sendJson(res, 200, {
          state: "claimed",
          companionToken: challenge.companionToken,
          claimedAt: challenge.claimedAt,
          expiresAt: challenge.expiresAt,
        });
        return;
      }

      sendJson(res, 200, {
        state: "pending",
        shortCode: challenge.shortCode,
        expiresAt: challenge.expiresAt,
      });
    } catch (error) {
      Sentry.captureException(error);
      logger.error(`[companion-pairing] Failed to read pairing status: ${error}`);
      sendJson(res, 500, { error: "Failed to read companion pairing status." });
    }
  });

  router.get("/qr/:pairingId.svg", async (req, res) => {
    const pairingId =
      typeof req.params.pairingId === "string" ? req.params.pairingId.trim() : undefined;
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
      const origin = getPublicOrigin(req);
      const svg = await QRCode.toString(buildVerificationUrl(origin, challenge.shortCode), {
        type: "svg",
        errorCorrectionLevel: "M",
        margin: 2,
        width: 320,
      });
      res.set("Cache-Control", "no-store");
      res.type("image/svg+xml").send(svg);
    } catch (error) {
      Sentry.captureException(error);
      logger.error(`[companion-pairing] Failed to render QR code: ${error}`);
      res.status(500).type("text/plain").send("Failed to render pairing QR code.");
    }
  });

  return router;
}
