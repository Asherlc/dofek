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

const pairingStartSchema = z.object({});

function sendJson(res: import("express").Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

function getPublicOrigin(): string {
  const envOrigin = process.env.PUBLIC_URL?.trim();
  if (!envOrigin) {
    throw new Error("PUBLIC_URL environment variable is required");
  }
  let url: URL;
  try {
    url = new URL(envOrigin);
  } catch {
    throw new Error("PUBLIC_URL environment variable must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PUBLIC_URL environment variable must use http or https");
  }
  return url.origin;
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
  const publicOrigin = getPublicOrigin();

  router.post("/start", express.json(), async (req, res) => {
    const parsed = pairingStartSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendJson(res, 400, { error: "Invalid pairing request" });
      return;
    }

    try {
      const challenge = await store.createChallenge();
      sendJson(res, 200, {
        pairingId: challenge.id,
        shortCode: challenge.shortCode,
        verificationUrl: buildVerificationUrl(publicOrigin, challenge.shortCode),
        qrImageUrl: buildQrImageUrl(publicOrigin, challenge.id),
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
      Sentry.captureException(error);
      logger.error(`[companion-pairing] Failed to render QR code: ${error}`);
      res.status(500).type("text/plain").send("Failed to render pairing QR code.");
    }
  });

  return router;
}
