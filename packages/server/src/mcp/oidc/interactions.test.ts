import type { AddressInfo } from "node:net";
import type { Database } from "dofek/db";
import express from "express";
import { Provider } from "oidc-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionMocks = vi.hoisted<{
  sessionId: string | null;
  session: { userId: string } | null;
}>(() => ({
  sessionId: "session-id",
  session: { userId: "123e4567-e89b-12d3-a456-426614174000" },
}));
const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("dofek/lib/error-reporting", () => ({ captureException }));
vi.mock("../../auth/cookies.ts", () => ({
  getSessionIdFromRequest: () => sessionMocks.sessionId,
}));
vi.mock("../../auth/session.ts", () => ({
  validateSession: async () => sessionMocks.session,
}));

import { createInteractionHandler, escapeHtml, interactionUrl } from "./interactions.ts";

const issuer = "https://app.example.test/";

describe("MCP OIDC interaction handler", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;
  let baseUrl: string;

  beforeEach(() => {
    captureException.mockReset();
    sessionMocks.sessionId = "session-id";
    sessionMocks.session = { userId: "123e4567-e89b-12d3-a456-426614174000" };
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

  it("builds interaction URLs from a valid issuer context and falls back for invalid context", async () => {
    await expect(
      interactionUrl({ oidc: { issuer: "https://issuer.example/" } }, { uid: "abc" }),
    ).resolves.toBe("https://issuer.example/interaction/abc");
    await expect(interactionUrl({ oidc: { issuer: 3 } }, { uid: "abc" })).resolves.toBe(
      "https://app.example.test/interaction/abc",
    );
  });

  it("escapes every HTML-sensitive character", () => {
    expect(escapeHtml(`&"'< >`)).toBe("&amp;&quot;&#039;&lt; &gt;");
  });

  it("redirects an unauthenticated login interaction back to its requested URL", async () => {
    sessionMocks.sessionId = null;
    sessionMocks.session = null;
    const provider = new Provider(issuer, { features: { devInteractions: { enabled: false } } });
    vi.spyOn(provider, "interactionDetails").mockResolvedValue({
      uid: "interaction-uid",
      prompt: { name: "login", details: {} },
      params: {},
    });
    const finished = vi.spyOn(provider, "interactionFinished");
    await mount(provider);

    const response = await fetch(`${baseUrl}/interaction/interaction-uid?next=account`, {
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    expect(decodeURIComponent(response.headers.get("location") ?? "")).toBe(
      "/login?returnTo=/interaction/interaction-uid?next=account",
    );
    expect(finished).not.toHaveBeenCalled();
  });

  it("finishes an authenticated login interaction with the session account", async () => {
    const provider = new Provider(issuer, { features: { devInteractions: { enabled: false } } });
    vi.spyOn(provider, "interactionDetails").mockResolvedValue({
      uid: "interaction-uid",
      prompt: { name: "login", details: {} },
      params: {},
    });
    vi.spyOn(provider, "interactionFinished").mockImplementation(
      async (_request, response, result) => {
        response.setHeader("x-interaction-result", JSON.stringify(result));
        response.end();
      },
    );
    await mount(provider);

    const response = await fetch(`${baseUrl}/interaction/interaction-uid`);

    expect(response.headers.get("x-interaction-result")).toBe(
      JSON.stringify({ login: { accountId: "123e4567-e89b-12d3-a456-426614174000" } }),
    );
  });

  it("denies unsupported interaction prompts", async () => {
    const provider = new Provider(issuer, { features: { devInteractions: { enabled: false } } });
    vi.spyOn(provider, "interactionDetails").mockResolvedValue({
      uid: "interaction-uid",
      prompt: { name: "unknown", details: {} },
      params: {},
    });
    const finished = vi
      .spyOn(provider, "interactionFinished")
      .mockImplementation(async (_request, response) => response.end());
    await mount(provider);

    await fetch(`${baseUrl}/interaction/interaction-uid`);

    expect(finished).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      error: "access_denied",
      error_description: "Unsupported interaction prompt",
    });
  });

  it("redirects unauthenticated consent interactions to login", async () => {
    sessionMocks.session = null;
    const provider = new Provider(issuer, { features: { devInteractions: { enabled: false } } });
    vi.spyOn(provider, "interactionDetails").mockResolvedValue({
      uid: "interaction-uid",
      prompt: { name: "consent", details: {} },
      params: {},
    });
    await mount(provider);

    const response = await fetch(`${baseUrl}/interaction/interaction-uid`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "approval=approve",
    });

    expect(response.status).toBe(302);
    expect(decodeURIComponent(response.headers.get("location") ?? "")).toBe(
      "/login?returnTo=/interaction/interaction-uid",
    );
  });

  it("finishes a denied consent interaction with access_denied", async () => {
    const provider = new Provider(issuer, { features: { devInteractions: { enabled: false } } });
    vi.spyOn(provider, "interactionDetails").mockResolvedValue({
      uid: "interaction-uid",
      prompt: { name: "consent", details: {} },
      params: {},
    });
    const finished = vi
      .spyOn(provider, "interactionFinished")
      .mockImplementation(async (_request, response) => response.end());
    await mount(provider);

    await fetch(`${baseUrl}/interaction/interaction-uid`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "approval=deny",
    });

    expect(finished).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      error: "access_denied",
      error_description: "End-user denied the request",
    });
  });

  it("renders safely escaped client and scope text when consent is not approved", async () => {
    const provider = new Provider(issuer, { features: { devInteractions: { enabled: false } } });
    vi.spyOn(provider, "interactionDetails").mockResolvedValue({
      uid: `uid"><script>alert(1)</script>`,
      prompt: {
        name: "consent",
        details: { missingOIDCScope: ["offline_access", "custom&scope"] },
      },
      params: { client_id: `client"><script>alert(1)</script>` },
    });
    await mount(provider);

    const response = await fetch(`${baseUrl}/interaction/interaction-uid`);
    const html = await response.text();

    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("custom&amp;scope");
    expect(html).not.toContain(`<script>alert(1)</script>`);
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

  it("merges existing resource and OIDC grants when approving consent", async () => {
    const provider = new Provider(issuer, { features: { devInteractions: { enabled: false } } });
    const grant = new provider.Grant({ accountId: "123e4567-e89b-12d3-a456-426614174000" });
    const addResourceScope = vi.spyOn(grant, "addResourceScope");
    const addOIDCScope = vi.spyOn(grant, "addOIDCScope");
    const save = vi.spyOn(grant, "save").mockResolvedValue("saved-grant");
    vi.spyOn(provider.Grant, "find").mockResolvedValue(grant);
    vi.spyOn(provider, "interactionDetails").mockResolvedValue({
      uid: "interaction-uid",
      prompt: {
        name: "consent",
        details: {
          missingResourceScopes: {
            "https://api.example/resource": ["health:read", "activity:read"],
          },
          missingOIDCScope: ["offline_access"],
        },
      },
      params: { client_id: "mcp-client" },
      grantId: "existing-grant",
    });
    const finished = vi
      .spyOn(provider, "interactionFinished")
      .mockImplementation(async (_request, response) => response.end());
    await mount(provider);

    await fetch(`${baseUrl}/interaction/interaction-uid`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "approval=approve",
    });

    expect(provider.Grant.find).toHaveBeenCalledWith("existing-grant");
    expect(addResourceScope).toHaveBeenCalledWith(
      "https://api.example/resource",
      "health:read activity:read",
    );
    expect(addOIDCScope).toHaveBeenCalledWith("offline_access");
    expect(save).toHaveBeenCalledOnce();
    expect(finished).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { consent: { grantId: "saved-grant" } },
      { mergeWithLastSubmission: true },
    );
  });

  it("creates a grant when the previous grant id no longer resolves", async () => {
    const provider = new Provider(issuer, { features: { devInteractions: { enabled: false } } });
    const addResourceScope = vi.spyOn(provider.Grant.prototype, "addResourceScope");
    vi.spyOn(provider.Grant, "find").mockResolvedValue(undefined);
    vi.spyOn(provider.Grant.prototype, "save").mockResolvedValue("new-grant");
    vi.spyOn(provider, "interactionDetails").mockResolvedValue({
      uid: "interaction-uid",
      prompt: { name: "consent", details: {} },
      params: { client_id: "mcp-client", scope: "unknown:scope health:read" },
      grantId: "expired-grant",
    });
    const finished = vi
      .spyOn(provider, "interactionFinished")
      .mockImplementation(async (_request, response) => response.end());
    await mount(provider);

    await fetch(`${baseUrl}/interaction/interaction-uid`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "approval=approve",
    });

    expect(provider.Grant.find).toHaveBeenCalledWith("expired-grant");
    expect(addResourceScope).toHaveBeenCalledWith(
      "https://app.example.test/api/mcp",
      "health:read",
    );
    expect(finished).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { consent: { grantId: "new-grant" } },
      { mergeWithLastSubmission: true },
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
