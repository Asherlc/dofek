import type { AddressInfo } from "node:net";
import type { Database } from "dofek/db";
import express from "express";
import { Provider } from "oidc-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("dofek/lib/error-reporting", () => ({ captureException }));
vi.mock("../../auth/cookies.ts", () => ({ getSessionIdFromRequest: () => "session-id" }));
vi.mock("../../auth/session.ts", () => ({
  validateSession: async () => ({ userId: "123e4567-e89b-12d3-a456-426614174000" }),
}));

import { createInteractionHandler } from "./interactions.ts";

const issuer = "https://app.example.test/";

describe("MCP OIDC interaction handler", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;
  let baseUrl: string;

  beforeEach(() => {
    captureException.mockReset();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
  });

  async function mount(provider: Provider): Promise<void> {
    const app = express();
    const db: Pick<Database, "execute"> = { execute: vi.fn() };
    app.use(express.urlencoded({ extended: false }));
    app.all("/interaction/:uid", createInteractionHandler(db, provider));
    server = app.listen(0);
    await new Promise<void>((resolve) => server?.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("Server did not bind a port");
    baseUrl = `http://localhost:${(address satisfies AddressInfo).port}`;
  }

  it("shows offline access on the consent page", async () => {
    const provider = new Provider(issuer, { features: { devInteractions: { enabled: false } } });
    vi.spyOn(provider, "interactionDetails").mockResolvedValue({
      uid: "interaction-uid",
      prompt: { name: "consent", details: { missingOIDCScope: ["offline_access"] } },
      params: { client_id: "mcp-client", scope: "offline_access health:read" },
    });
    await mount(provider);

    const response = await fetch(`${baseUrl}/interaction/interaction-uid`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).not.toContain("offline_access");
    expect(html).toContain("Continue access with refresh tokens when you are offline");
    expect(captureException).not.toHaveBeenCalled();
  });

  it("attaches requested MCP scopes to the default resource when no resource scopes are listed", async () => {
    const provider = new Provider(issuer, { features: { devInteractions: { enabled: false } } });
    const addResourceScope = vi.spyOn(provider.Grant.prototype, "addResourceScope");
    vi.spyOn(provider, "interactionDetails").mockResolvedValue({
      uid: "interaction-uid",
      prompt: { name: "consent", details: {} },
      params: { client_id: "mcp-client", scope: "health:read offline_access" },
    });
    vi.spyOn(provider, "interactionFinished").mockImplementation(async (_request, response) => {
      response.end();
    });
    vi.spyOn(provider.Grant.prototype, "save").mockResolvedValue("grant-id");
    await mount(provider);

    await fetch(`${baseUrl}/interaction/interaction-uid`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "approval=approve",
    });

    expect(addResourceScope).toHaveBeenCalledWith(
      "https://app.example.test/api/mcp",
      "health:read",
    );
  });

  it("reports unexpected interaction lookup failures", async () => {
    const provider = new Provider(issuer, { features: { devInteractions: { enabled: false } } });
    const failure = new Error("adapter lookup failed");
    vi.spyOn(provider, "interactionDetails").mockRejectedValue(failure);
    await mount(provider);

    const response = await fetch(`${baseUrl}/interaction/interaction-uid`);

    expect(response.status).toBe(400);
    expect(captureException).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({ tags: { source: "mcp-oidc-interaction-details" } }),
    );
  });
});
