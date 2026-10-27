import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Database } from "dofek/db";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MCP_OAUTH_SCOPES } from "./oauth-provider.ts";
import { createMcpOAuthRouter } from "./oauth-route.ts";

const oidcMocks = vi.hoisted(() => ({
  create: vi.fn(() => ({
    provider: {
      callback: () => (_req: unknown, res: { statusCode: number; end: () => void }) => {
        res.statusCode = 404;
        res.end();
      },
    },
  })),
}));

vi.mock("./oidc/config.ts", () => ({
  createOidcProvider: oidcMocks.create,
}));

vi.mock("./oidc/interactions.ts", () => ({
  createInteractionHandler: () => (_req: unknown, res: { statusCode: number; end: () => void }) => {
    res.statusCode = 200;
    res.end();
  },
}));

const protectedResourceMetadataSchema = z.object({
  authorization_servers: z.array(z.string()),
  resource: z.string(),
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
  app.use(createMcpOAuthRouter(mockDb(), rateLimit, ["test-key"]).router);
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
    oidcMocks.create.mockClear();
  });

  afterEach(async () => {
    await app?.close();
  });

  describe("interaction cookie key", () => {
    it("derives a local key from the issuer outside production", () => {
      const previousNodeEnv = process.env.NODE_ENV;
      const previousKey = process.env.MCP_OIDC_COOKIE_KEY;
      process.env.NODE_ENV = "test";
      delete process.env.MCP_OIDC_COOKIE_KEY;
      try {
        createMcpOAuthRouter(mockDb());

        expect(oidcMocks.create).toHaveBeenCalledWith(expect.anything(), {
          cookiesKeys: ["https://app.example.test/"],
        });
      } finally {
        process.env.NODE_ENV = previousNodeEnv;
        if (previousKey === undefined) delete process.env.MCP_OIDC_COOKIE_KEY;
        else process.env.MCP_OIDC_COOKIE_KEY = previousKey;
      }
    });

    it("uses a trimmed configured key", () => {
      const previousNodeEnv = process.env.NODE_ENV;
      const previousKey = process.env.MCP_OIDC_COOKIE_KEY;
      process.env.NODE_ENV = "test";
      process.env.MCP_OIDC_COOKIE_KEY = "  durable-test-key  ";
      try {
        createMcpOAuthRouter(mockDb());

        expect(oidcMocks.create).toHaveBeenCalledWith(expect.anything(), {
          cookiesKeys: ["durable-test-key"],
        });
      } finally {
        process.env.NODE_ENV = previousNodeEnv;
        if (previousKey === undefined) delete process.env.MCP_OIDC_COOKIE_KEY;
        else process.env.MCP_OIDC_COOKIE_KEY = previousKey;
      }
    });

    it("hard-fails in production when MCP_OIDC_COOKIE_KEY is not set", () => {
      const previousNodeEnv = process.env.NODE_ENV;
      const previousKey = process.env.MCP_OIDC_COOKIE_KEY;
      process.env.NODE_ENV = "production";
      delete process.env.MCP_OIDC_COOKIE_KEY;
      try {
        expect(() => createMcpOAuthRouter(mockDb())).toThrow(
          "MCP_OIDC_COOKIE_KEY environment variable is required in production",
        );
      } finally {
        process.env.NODE_ENV = previousNodeEnv;
        if (previousKey === undefined) {
          delete process.env.MCP_OIDC_COOKIE_KEY;
        } else {
          process.env.MCP_OIDC_COOKIE_KEY = previousKey;
        }
      }
    });
  });

  describe("OAuth protected-resource metadata", () => {
    it("advertises every supported scope from the protected-resource metadata", async () => {
      app = await mount();
      const response = await fetch(`${app.baseUrl}/.well-known/oauth-protected-resource/api/mcp`);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      const metadata = protectedResourceMetadataSchema.parse(await response.json());
      for (const scope of MCP_OAUTH_SCOPES) {
        expect(metadata.scopes_supported).toContain(scope);
      }
      expect(metadata.scopes_supported).toContain("nutrition:write");
    });

    it("publishes the Dofek resource and issuer URLs in the protected-resource metadata", async () => {
      app = await mount();
      const response = await fetch(`${app.baseUrl}/.well-known/oauth-protected-resource/api/mcp`);
      const metadata = protectedResourceMetadataSchema.parse(await response.json());

      expect(metadata.resource).toBe("https://app.example.test/api/mcp");
      expect(metadata.authorization_servers).toEqual(["https://app.example.test/"]);
    });
  });

  describe("OIDC route protections", () => {
    it("rate limits nested authorization-server paths", async () => {
      app = await mount({ max: 1, windowMs: 60_000 });

      const first = await fetch(`${app.baseUrl}/authorize/nested`, { method: "POST" });
      const second = await fetch(`${app.baseUrl}/authorize/nested`, { method: "POST" });

      expect(first.status).toBe(404);
      expect(second.status).toBe(429);
    });

    it("rate limits interaction requests", async () => {
      app = await mount({ max: 1, windowMs: 60_000 });

      const first = await fetch(`${app.baseUrl}/interaction/test-uid`);
      const second = await fetch(`${app.baseUrl}/interaction/test-uid`);

      expect(first.status).toBe(200);
      expect(second.status).toBe(429);
    });

    it("does not rate limit interaction requests when rate limiting is disabled", async () => {
      app = await mount(false);

      const responses = await Promise.all(
        Array.from({ length: 6 }, () => fetch(`${app.baseUrl}/interaction/test-uid`)),
      );

      expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200]);
    });

    it("prevents the consent page from being framed", async () => {
      app = await mount();

      const response = await fetch(`${app.baseUrl}/interaction/test-uid`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    });
  });

  describe("rate limiting", () => {
    it("applies rate limiting to protected-resource metadata when configured with a limit", async () => {
      app = await mount({ max: 1, windowMs: 60_000 });

      const first = await fetch(`${app.baseUrl}/.well-known/oauth-protected-resource/api/mcp`);
      const second = await fetch(`${app.baseUrl}/.well-known/oauth-protected-resource/api/mcp`);

      expect(first.status).toBe(200);
      expect(second.status).toBe(429);
    });

    it("does not rate limit protected-resource metadata when rate limiting is disabled", async () => {
      app = await mount(false);

      const responses = await Promise.all(
        Array.from({ length: 6 }, () =>
          fetch(`${app.baseUrl}/.well-known/oauth-protected-resource/api/mcp`),
        ),
      );

      expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200]);
    });
  });
});
