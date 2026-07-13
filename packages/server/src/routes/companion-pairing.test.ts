import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { InMemoryCompanionPairingStore } from "../lib/companion-pairing-store.ts";
import { createCompanionPairingRouter } from "./companion-pairing.ts";

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
}));

vi.mock("../logger.ts", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const originalPublicAppUrl = process.env.PUBLIC_APP_URL;
const pairingStartResponseSchema = z.object({
  pairingId: z.string(),
  shortCode: z.string(),
});

function createTestApp(store: InMemoryCompanionPairingStore) {
  const app = express();
  const db = {} satisfies import("dofek/db").Database;
  app.use("/api/companion-pairing", createCompanionPairingRouter({ db, store }));
  return app;
}

async function request(
  app: express.Express,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; text: string; json: () => Promise<unknown>; contentType: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      const address = server.address();
      if (address === null || typeof address !== "object") {
        reject(new Error("Test server did not bind to a port"));
        return;
      }

      try {
        const response = await fetch(`http://localhost:${address.port}${path}`, {
          method,
          headers: body ? { "Content-Type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        const text = await response.text();
        resolve({
          status: response.status,
          text,
          json: async () => JSON.parse(text),
          contentType: response.headers.get("content-type") ?? "",
        });
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}

describe("createCompanionPairingRouter", () => {
  beforeEach(() => {
    process.env.PUBLIC_APP_URL = "https://app.example.test";
  });

  afterEach(() => {
    if (originalPublicAppUrl === undefined) {
      delete process.env.PUBLIC_APP_URL;
    } else {
      process.env.PUBLIC_APP_URL = originalPublicAppUrl;
    }
  });

  it("starts a pairing challenge with a verification URL and QR image URL", async () => {
    const app = createTestApp(new InMemoryCompanionPairingStore());

    const response = await request(app, "POST", "/api/companion-pairing/start", {});
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      verificationUrl: expect.stringContaining("https://app.example.test/settings?zeppPair="),
      qrImageUrl: expect.stringContaining("https://app.example.test/api/companion-pairing/qr/"),
    });
  });

  it("returns pending status before the code is claimed", async () => {
    const store = new InMemoryCompanionPairingStore();
    const app = createTestApp(store);
    const startResponse = await request(app, "POST", "/api/companion-pairing/start", {});
    const startBody = pairingStartResponseSchema.parse(await startResponse.json());

    const statusResponse = await request(
      app,
      "GET",
      `/api/companion-pairing/status/${startBody.pairingId}`,
    );

    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({
      state: "pending",
      shortCode: startBody.shortCode,
    });
  });

  it("returns the companion token after the code is claimed", async () => {
    const store = new InMemoryCompanionPairingStore();
    const app = createTestApp(store);
    const challenge = await store.createChallenge();
    await store.claimChallenge({
      shortCode: challenge.shortCode,
      userId: "user-1",
      companionToken: "dofek_companion_test",
    });

    const statusResponse = await request(
      app,
      "GET",
      `/api/companion-pairing/status/${challenge.id}`,
    );

    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({
      state: "claimed",
      companionToken: "dofek_companion_test",
    });
  });

  it("renders a QR SVG for an active pairing", async () => {
    const store = new InMemoryCompanionPairingStore();
    const app = createTestApp(store);
    const challenge = await store.createChallenge();

    const response = await request(app, "GET", `/api/companion-pairing/qr/${challenge.id}.svg`);

    expect(response.status).toBe(200);
    expect(response.contentType).toContain("image/svg+xml");
    expect(response.text).toContain("<svg");
  });
});
