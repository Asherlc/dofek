import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Database } from "dofek/db";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getSessionIdFromRequest } from "../auth/cookies.ts";
import { validateSession } from "../auth/session.ts";
import { MCP_OAUTH_SCOPES } from "./oauth-provider.ts";
import {
  approvalFromBody,
  createMcpOAuthRouter,
  mcpAuthorizeUrlencodedOptions,
} from "./oauth-route.ts";

vi.mock("../auth/cookies.ts", () => ({
  getSessionIdFromRequest: vi.fn(),
}));

vi.mock("../auth/session.ts", () => ({
  validateSession: vi.fn(),
}));

const protectedResourceMetadataSchema = z.object({
  authorization_servers: z.array(z.string()),
  resource: z.string(),
  scopes_supported: z.array(z.string()),
});
const authorizationServerMetadataSchema = z.object({
  authorization_endpoint: z.string(),
  client_id_metadata_document_supported: z.boolean(),
  issuer: z.string(),
  scopes_supported: z.array(z.string()),
});

interface MountedApp {
  baseUrl: string;
  close: () => Promise<void>;
}

function mockDb(): Pick<Database, "execute"> {
  return { execute: vi.fn() };
}

function getPort(server: Server): number {
  const address = server.address();
  if (address !== null && typeof address === "object") {
    return (address satisfies AddressInfo).port;
  }
  throw new Error("Server address is not an object");
}

function mount(rateLimit: false | Record<string, unknown> = false): Promise<MountedApp> {
  const app = express();
  app.use(createMcpOAuthRouter(mockDb(), rateLimit));
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      resolve({
        baseUrl: `http://localhost:${getPort(server)}`,
        close: () =>
          new Promise((res, rej) => server.close((error) => (error ? rej(error) : res()))),
      });
    });
    server.on("error", reject);
  });
}

describe("createMcpOAuthRouter", () => {
  let app: MountedApp;

  beforeEach(() => {
    vi.mocked(getSessionIdFromRequest).mockReset();
    vi.mocked(validateSession).mockReset();
  });

  afterEach(async () => {
    await app?.close();
  });

  it("parses authorize form bodies without qs extended parsing", () => {
    expect(mcpAuthorizeUrlencodedOptions).toEqual({ extended: false });
  });

  it("reads a string approval value from the authorize form body", () => {
    expect(approvalFromBody({ approval: "approve" })).toBe("approve");
    expect(approvalFromBody({ approval: "deny" })).toBe("deny");
    expect(approvalFromBody({})).toBeUndefined();
    expect(approvalFromBody({ approval: 1 })).toBeUndefined();
  });

  describe("OAuth discovery metadata", () => {
    it("advertises every supported scope from the protected-resource metadata", async () => {
      app = await mount();
      const response = await fetch(`${app.baseUrl}/.well-known/oauth-protected-resource/api/mcp`);
      const metadata = protectedResourceMetadataSchema.parse(await response.json());
      for (const scope of MCP_OAUTH_SCOPES) {
        expect(metadata.scopes_supported).toContain(scope);
      }
    });

    it("advertises every supported scope from the authorization-server metadata", async () => {
      app = await mount();
      const response = await fetch(`${app.baseUrl}/.well-known/oauth-authorization-server`);
      const metadata = authorizationServerMetadataSchema.parse(await response.json());
      expect(metadata.client_id_metadata_document_supported).toBe(true);
      expect(metadata.scopes_supported).toEqual([...MCP_OAUTH_SCOPES]);
    });

    it("publishes the Dofek resource and issuer URLs in the metadata", async () => {
      app = await mount();
      const [protectedResource, authorizationServer] = await Promise.all([
        fetch(`${app.baseUrl}/.well-known/oauth-protected-resource/api/mcp`).then(
          async (response) => protectedResourceMetadataSchema.parse(await response.json()),
        ),
        fetch(`${app.baseUrl}/.well-known/oauth-authorization-server`).then(async (response) =>
          authorizationServerMetadataSchema.parse(await response.json()),
        ),
      ]);

      expect(protectedResource.resource).toBe("https://app.example.test/api/mcp");
      expect(protectedResource.authorization_servers).toEqual(["https://app.example.test/"]);
      expect(authorizationServer.issuer).toBe("https://app.example.test/");
      expect(authorizationServer.authorization_endpoint).toBe("https://app.example.test/authorize");
    });
  });

  describe("authorize middleware", () => {
    it("redirects unauthenticated users to login with the original returnTo URL", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      app = await mount();

      const response = await fetch(`${app.baseUrl}/authorize?client_id=test`, {
        redirect: "manual",
      });

      expect(response.status).toBe(302);
      const location = response.headers.get("location") ?? "";
      expect(location).toContain("/login?");
      expect(location).toContain("returnTo=");
      expect(decodeURIComponent(location)).toContain("/authorize?client_id=test");
    });

    it("sets CSP frame-ancestors and X-Frame-Options headers before requiring a session", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      app = await mount();

      const response = await fetch(`${app.baseUrl}/authorize`, { redirect: "manual" });

      expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    });

    it("propagates approval from the urlencoded body for authenticated sessions", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("session-1");
      vi.mocked(validateSession).mockResolvedValue({
        sessionId: "session-1",
        userId: "user-1",
      });
      app = await mount();

      // Unknown client_id fails after the authorize middleware has accepted the session.
      const response = await fetch(`${app.baseUrl}/authorize`, {
        body: "approval=deny&client_id=missing",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
        redirect: "manual",
      });

      expect(validateSession).toHaveBeenCalledWith(expect.anything(), "session-1");
      // Middleware ran (not a login redirect) and the auth router rejected the unknown client.
      expect(response.status).not.toBe(302);
      expect(response.url).not.toContain("/login");
    });
  });

  describe("rate limiting", () => {
    it("applies rate limiting to authorization-server metadata when configured with a limit", async () => {
      app = await mount({ max: 1, windowMs: 60_000 });

      const first = await fetch(`${app.baseUrl}/.well-known/oauth-authorization-server`);
      const second = await fetch(`${app.baseUrl}/.well-known/oauth-authorization-server`);

      expect(first.status).toBe(200);
      expect(second.status).toBe(429);
    });

    it("does not rate limit authorization-server metadata when rate limiting is disabled", async () => {
      app = await mount(false);

      const responses = await Promise.all(
        Array.from({ length: 6 }, () =>
          fetch(`${app.baseUrl}/.well-known/oauth-authorization-server`),
        ),
      );

      expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200]);
    });

    it("applies rate limiting to client registration when configured with a limit", async () => {
      app = await mount({ max: 1, windowMs: 60_000 });

      const first = await fetch(`${app.baseUrl}/register`, {
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const second = await fetch(`${app.baseUrl}/register`, {
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      expect(first.status).toBe(400);
      expect(second.status).toBe(429);
    });

    it("does not rate limit client registration when rate limiting is disabled", async () => {
      app = await mount(false);

      const first = await fetch(`${app.baseUrl}/register`, {
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const second = await fetch(`${app.baseUrl}/register`, {
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      expect(first.status).toBe(400);
      expect(second.status).toBe(400);
    });
  });
});
