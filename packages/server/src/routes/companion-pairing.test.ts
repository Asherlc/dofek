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

const originalPublicUrl = process.env.PUBLIC_URL;
const originalNodeEnv = process.env.NODE_ENV;
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
  body?: unknown,
): Promise<{
  status: number;
  text: string;
  json: () => Promise<unknown>;
  contentType: string;
  cacheControl: string;
}> {
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
          cacheControl: response.headers.get("cache-control") ?? "",
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
    process.env.NODE_ENV = "test";
    process.env.PUBLIC_URL = "https://app.example.test";
  });

  afterEach(() => {
    if (originalPublicUrl === undefined) {
      delete process.env.PUBLIC_URL;
    } else {
      process.env.PUBLIC_URL = originalPublicUrl;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("starts a pairing challenge with a verification URL and QR image URL", async () => {
    const app = createTestApp(new InMemoryCompanionPairingStore());

    const response = await request(app, "POST", "/api/companion-pairing/start", {
      connectionType: "zepp-main",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      verificationUrl: expect.stringContaining("https://app.example.test/zepp-pairing?code="),
      qrImageUrl: expect.stringContaining("https://app.example.test/api/companion-pairing/qr/"),
    });
  });

  it("requires legacy clients to identify their Zepp package", async () => {
    const app = createTestApp(new InMemoryCompanionPairingStore());

    const response = await request(app, "POST", "/api/companion-pairing/start", {});

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Update the Zepp package before connecting to Dofek.",
    });
  });

  it.each([[{ connectionType: "zepp-unknown" }], [[]]])(
    "rejects an invalid pairing body without treating it as a legacy client",
    async (body) => {
      const app = createTestApp(new InMemoryCompanionPairingStore());

      const response = await request(app, "POST", "/api/companion-pairing/start", body);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid pairing request" });
    },
  );

  it("preserves the requested companion connection type", async () => {
    const app = createTestApp(new InMemoryCompanionPairingStore());

    const response = await request(app, "POST", "/api/companion-pairing/start", {
      connectionType: "zepp-workout",
    });

    expect(response.status).toBe(200);
    const body = pairingStartResponseSchema
      .extend({ connectionType: z.literal("zepp-workout") })
      .parse(await response.json());
    expect(body.connectionType).toBe("zepp-workout");
  });

  it("starts pairing from an HTTP public app URL", async () => {
    process.env.PUBLIC_URL = "http://app.example.test";
    const app = createTestApp(new InMemoryCompanionPairingStore());

    const response = await request(app, "POST", "/api/companion-pairing/start", {
      connectionType: "zepp-main",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      verificationUrl: expect.stringContaining("http://app.example.test/zepp-pairing?code="),
    });
  });

  it("rejects an HTTP public app URL in production", () => {
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_URL = "http://app.example.test";

    expect(() => createTestApp(new InMemoryCompanionPairingStore())).toThrow(
      "PUBLIC_URL environment variable must use https in production",
    );
  });

  it("fails loudly when PUBLIC_URL is missing", async () => {
    delete process.env.PUBLIC_URL;

    expect(() => createTestApp(new InMemoryCompanionPairingStore())).toThrow(
      "PUBLIC_URL environment variable is required",
    );
  });

  it("fails loudly when PUBLIC_URL is blank", async () => {
    process.env.PUBLIC_URL = "   ";

    expect(() => createTestApp(new InMemoryCompanionPairingStore())).toThrow(
      "PUBLIC_URL environment variable is required",
    );
  });

  it("fails loudly when PUBLIC_URL does not use HTTP", async () => {
    process.env.PUBLIC_URL = "file:///tmp/dofek";

    expect(() => createTestApp(new InMemoryCompanionPairingStore())).toThrow(
      "PUBLIC_URL environment variable must use http or https",
    );
  });

  it("returns pending status before the code is claimed", async () => {
    const store = new InMemoryCompanionPairingStore();
    const app = createTestApp(store);
    const startResponse = await request(app, "POST", "/api/companion-pairing/start", {
      connectionType: "zepp-main",
    });
    const startBody = pairingStartResponseSchema.parse(await startResponse.json());

    const statusResponse = await request(
      app,
      "GET",
      `/api/companion-pairing/status/${startBody.pairingId}`,
    );

    expect(statusResponse.status).toBe(200);
    expect(statusResponse.cacheControl).toBe("no-store");
    expect(await statusResponse.json()).toMatchObject({
      state: "pending",
      shortCode: startBody.shortCode,
    });
  });

  it("rejects invalid start request bodies", async () => {
    const app = createTestApp(new InMemoryCompanionPairingStore());

    const response = await request(app, "POST", "/api/companion-pairing/start", []);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Invalid pairing request" });
  });

  it("rejects blank status pairing IDs", async () => {
    const app = createTestApp(new InMemoryCompanionPairingStore());

    const response = await request(app, "GET", "/api/companion-pairing/status/%20");

    expect(response.status).toBe(400);
    expect(response.cacheControl).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: "Pairing ID is required." });
  });

  it("returns the companion token after the code is claimed", async () => {
    const store = new InMemoryCompanionPairingStore();
    const app = createTestApp(store);
    const challenge = await store.createChallenge();
    await store.claimChallenge({
      shortCode: challenge.shortCode,
      userId: "user-1",
    });
    await store.setClaimedChallengeToken({
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
    expect(statusResponse.cacheControl).toBe("no-store");
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
    expect(response.cacheControl).toBe("no-store");
    expect(response.contentType).toContain("image/svg+xml");
    expect(response.text).toContain("<svg");
  });

  it("sets no-store on QR errors", async () => {
    const store = new InMemoryCompanionPairingStore();
    const app = createTestApp(store);

    const response = await request(app, "GET", "/api/companion-pairing/qr/missing.svg");

    expect(response.status).toBe(404);
    expect(response.cacheControl).toBe("no-store");
    expect(response.text).toBe("Pairing code expired.");
  });
});
