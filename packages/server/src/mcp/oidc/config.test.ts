import type { Database } from "dofek/db";
import { errors } from "oidc-provider";
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

  it("negotiates ChatGPT's CIMD authentication choices to public PKCE", () => {
    const db: Pick<Database, "execute"> = { execute: vi.fn() };
    const { provider } = createOidcProvider(db, { cookiesKeys: ["test-key"] });
    const client = new provider.Client(
      {
        client_id: "https://chatgpt.com/oauth/client.json",
        redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "private_key_jwt",
        token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
        jwks_uri: "https://chatgpt.com/oauth/jwks.json",
      },
      undefined,
      { cimd: true },
    );

    expect(client.clientAuthMethod).toBe("none");
  });

  it("accepts Claude's public CIMD client metadata", () => {
    const db: Pick<Database, "execute"> = { execute: vi.fn() };
    const { provider } = createOidcProvider(db, { cookiesKeys: ["test-key"] });
    const client = new provider.Client(
      {
        client_id: "https://claude.ai/oauth/client-metadata",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      undefined,
      { cimd: true },
    );

    expect(client.clientAuthMethod).toBe("none");
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
      error_cause: "JWSSignatureVerificationFailed",
      http_status: 401,
      oauth_error: "invalid_client",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(assertion);
  });

  it("logs a real oidc-provider client authentication detail", () => {
    const db: Pick<Database, "execute"> = { execute: vi.fn() };
    const { provider } = createOidcProvider(db, { cookiesKeys: ["test-key"] });

    provider.emit("grant.error", {}, new errors.InvalidClientAuth("client not found"));

    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      error_name: "InvalidClientAuth",
      error_detail: "client not found",
    });
  });

  it("records only the presented and registered client authentication methods", () => {
    const db: Pick<Database, "execute"> = { execute: vi.fn() };
    const { provider } = createOidcProvider(db, { cookiesKeys: ["test-key"] });
    const assertion = "private-assertion-material";

    provider.emit(
      "grant.error",
      {
        headers: { authorization: undefined },
        oidc: {
          client: { clientAuthMethod: "private_key_jwt" },
          params: { client_assertion: assertion, client_id: "private-client-id" },
        },
      },
      new errors.InvalidClientAuth("authentication method mismatch"),
    );

    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      presented_client_auth: "client_assertion",
      registered_client_auth: "private_key_jwt",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(assertion);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-client-id");
  });

  it("identifies a public token request without recording request parameters", () => {
    const db: Pick<Database, "execute"> = { execute: vi.fn() };
    const { provider } = createOidcProvider(db, { cookiesKeys: ["test-key"] });

    provider.emit(
      "grant.error",
      {
        headers: {},
        oidc: {
          client: { clientAuthMethod: "private_key_jwt" },
          params: { client_id: "private-client-id", code: "private-authorization-code" },
        },
      },
      new errors.InvalidClientAuth("authentication method mismatch"),
    );

    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      presented_client_auth: "none",
      registered_client_auth: "private_key_jwt",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-authorization-code");
  });

  it.each([
    ["client_secret_post", { client_secret: "private-secret" }, {}, "client_secret_post"],
    [
      "client_secret_basic",
      {},
      { authorization: `Basic ${Buffer.from("fixture:fixture").toString("base64")}` },
      "client_secret_basic",
    ],
    ["other authorization header", {}, { authorization: "Digest fixture" }, "authorization_header"],
  ])("classifies %s without logging credentials", (_name, params, headers, presented) => {
    const db: Pick<Database, "execute"> = { execute: vi.fn() };
    const { provider } = createOidcProvider(db, { cookiesKeys: ["test-key"] });

    provider.emit(
      "grant.error",
      {
        headers,
        oidc: { client: { clientAuthMethod: "private_key_jwt" }, params },
      },
      new errors.InvalidClientAuth("authentication method mismatch"),
    );

    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      presented_client_auth: presented,
      registered_client_auth: "private_key_jwt",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-secret");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Digest fixture");
  });

  it("omits method labels for malformed or incomplete event context", () => {
    const db: Pick<Database, "execute"> = { execute: vi.fn() };
    const { provider } = createOidcProvider(db, { cookiesKeys: ["test-key"] });
    const error = new errors.InvalidClientAuth("authentication method mismatch");

    provider.emit("grant.error", null, error);
    provider.emit("grant.error", { oidc: { params: {} } }, error);
    provider.emit(
      "grant.error",
      { oidc: { client: { clientAuthMethod: "private_key_jwt" } } },
      error,
    );

    expect(warn.mock.calls[0]?.[1]).not.toHaveProperty("presented_client_auth");
    expect(warn.mock.calls[1]?.[1]).toMatchObject({ presented_client_auth: "none" });
    expect(warn.mock.calls[1]?.[1]).not.toHaveProperty("registered_client_auth");
    expect(warn.mock.calls[2]?.[1]).toMatchObject({ registered_client_auth: "private_key_jwt" });
    expect(warn.mock.calls[2]?.[1]).not.toHaveProperty("presented_client_auth");
  });

  it("omits provider details containing parameter values", () => {
    const db: Pick<Database, "execute"> = { execute: vi.fn() };
    const { provider } = createOidcProvider(db, { cookiesKeys: ["test-key"] });

    provider.emit("grant.error", {}, { error_detail: "client_secret=alpha,beta" });

    expect(warn.mock.calls[0]?.[1]).not.toHaveProperty("error_detail");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("alpha,beta");
  });

  it("redacts standalone assertions, URLs, and opaque keys in provider details", () => {
    const db: Pick<Database, "execute"> = { execute: vi.fn() };
    const { provider } = createOidcProvider(db, { cookiesKeys: ["test-key"] });
    const assertion = ["eyJhbGciOiJSUzI1NiJ9", "eyJzdWIiOiJjaGF0Z3B0In0", "signature"].join(".");
    const opaqueKey = "abcdefghijklmnopqrstuvwx";

    provider.emit(
      "grant.error",
      {},
      {
        error_detail: `JWT ${assertion}; http://auth.example/token https://auth.example/token ${opaqueKey}`,
      },
    );

    const logged = warn.mock.calls[0]?.[1];
    expect(logged.error_detail).toBe("JWT [redacted]; [redacted URL] [redacted URL] [redacted]");
    expect(JSON.stringify(logged)).not.toContain(opaqueKey);
  });

  it("omits provider details containing quoted values instead of logging partial credentials", () => {
    const db: Pick<Database, "execute"> = { execute: vi.fn() };
    const { provider } = createOidcProvider(db, { cookiesKeys: ["test-key"] });

    for (const detail of [
      'client authentication failed; client_secret="alpha,beta"',
      "client authentication failed; client_secret='alpha,beta'",
    ]) {
      warn.mockReset();
      provider.emit("grant.error", {}, { error_detail: detail });
      expect(warn.mock.calls[0]?.[1]).not.toHaveProperty("error_detail");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("alpha,beta");
    }
  });

  it("bounds provider detail length without cutting short details", () => {
    const db: Pick<Database, "execute"> = { execute: vi.fn() };
    const { provider } = createOidcProvider(db, { cookiesKeys: ["test-key"] });

    provider.emit("grant.error", {}, { error_detail: "safe ".repeat(33) });
    expect(warn.mock.calls[0]?.[1].error_detail).toBe(`${"safe ".repeat(32)}`);

    warn.mockReset();
    provider.emit("grant.error", {}, { error_detail: "signature verification failed" });
    expect(warn.mock.calls[0]?.[1].error_detail).toBe("signature verification failed");
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
