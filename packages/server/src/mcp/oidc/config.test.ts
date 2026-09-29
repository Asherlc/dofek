import type { Database } from "dofek/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../logger.ts", () => ({ logger: { warn } }));

import { createOidcProvider } from "./config.ts";

describe("MCP OIDC token exchange diagnostics", () => {
  beforeEach(() => {
    warn.mockReset();
  });

  it("trusts forwarded proxy headers for external OIDC URLs", () => {
    const db: Pick<Database, "execute"> = { execute: vi.fn() };
    const { provider } = createOidcProvider(db, { cookiesKeys: ["test-key"] });

    expect(provider.proxy).toBe(true);
  });

  it("logs the token endpoint rejection reason without assertion material", () => {
    const db: Pick<Database, "execute"> = { execute: vi.fn() };
    const { provider } = createOidcProvider(db, { cookiesKeys: ["test-key"] });
    const assertion = ["eyJhbGciOiJSUzI1NiJ9", "eyJzdWIiOiJjaGF0Z3B0In0", "signature"].join(".");
    const error = Object.assign(new Error("invalid_client"), {
      error: "invalid_client",
      error_description:
        `Client assertion rejected: ${assertion}; code=authorization-code-fixture; ` +
        "client_secret=client-secret-fixture; " +
        "issuer=https://issuer.example/token?secret=fixture-secret;state=fixture-state; " +
        "legacy=http://legacy.example/callback?key=fixture-key",
      name: "InvalidClientAuth",
      status: 401,
    });

    provider.emit("grant.error", {}, error);

    expect(warn).toHaveBeenCalledWith("mcp.oidc.token_exchange_failed", {
      error_name: "InvalidClientAuth",
      error_description:
        "Client assertion rejected: [redacted]; code=[redacted]; " +
        "client_secret=[redacted]; " +
        "issuer=https://issuer.example/token?[redacted] " +
        "legacy=http://legacy.example/callback?[redacted]",
      http_status: 401,
      oauth_error: "invalid_client",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(assertion);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("authorization-code-fixture");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("client-secret-fixture");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("fixture-secret");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("fixture-state");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("fixture-key");
  });

  it("records the specific client-auth rejection while redacting credentials", () => {
    const db: Pick<Database, "execute"> = { execute: vi.fn() };
    const { provider } = createOidcProvider(db, { cookiesKeys: ["test-key"] });
    const assertion = ["eyJhbGciOiJSUzI1NiJ9", "eyJzdWIiOiJjaGF0Z3B0In0", "signature"].join(".");
    const error = Object.assign(new Error("invalid_client"), {
      name: "InvalidClientAuth",
      error: "invalid_client",
      error_description: "client authentication failed",
      error_detail: `signature verification failed; client_assertion=${assertion}`,
      cause: Object.assign(new Error("signature verification failed"), {
        name: "JWSSignatureVerificationFailed",
      }),
      status: 401,
    });

    provider.emit("grant.error", {}, error);

    expect(warn).toHaveBeenCalledWith("mcp.oidc.token_exchange_failed", {
      error_name: "InvalidClientAuth",
      error_description: "client authentication failed",
      error_detail: "signature verification failed; client_assertion=[redacted]",
      error_cause: "JWSSignatureVerificationFailed",
      http_status: 401,
      oauth_error: "invalid_client",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(assertion);
  });

  it("uses safe fallbacks for malformed error fields", () => {
    const db: Pick<Database, "execute"> = { execute: vi.fn() };
    const { provider } = createOidcProvider(db, { cookiesKeys: ["test-key"] });
    const errors = [
      Object.assign(new Error("fallback message"), {
        error: 401,
        error_description: null,
        message: "fallback message",
        name: new String("InvalidClientAuth"),
        status: "401",
        statusCode: 400,
      }),
      {
        error: null,
        error_description: null,
        message: { detail: "not a string" },
        name: "Invalid Name!",
        statusCode: 403,
      },
      {
        error: "invalid_grant",
        error_description: null,
        message: "!InvalidPrefix",
        name: "!InvalidPrefix",
      },
      { error_description: "no status" },
      null,
    ];

    for (const error of errors) provider.emit("grant.error", {}, error);

    expect(warn.mock.calls.map((call) => call[1])).toEqual([
      {
        error_name: "Error",
        error_description: "fallback message",
        http_status: 400,
      },
      {
        error_name: "Error",
        error_description: "Unknown OAuth error",
        http_status: 403,
      },
      {
        error_name: "Error",
        error_description: "!InvalidPrefix",
        oauth_error: "invalid_grant",
      },
      { error_name: "Error", error_description: "no status" },
      { error_name: "Error", error_description: "Unknown OAuth error" },
    ]);
    expect(warn.mock.calls[3]?.[1]).not.toHaveProperty("http_status");
  });

  it("truncates error descriptions to a bounded length", () => {
    const db: Pick<Database, "execute"> = { execute: vi.fn() };
    const { provider } = createOidcProvider(db, { cookiesKeys: ["test-key"] });

    provider.emit("grant.error", {}, { error_description: "x".repeat(500) });

    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      error_description: "x".repeat(300),
    });
  });
});
