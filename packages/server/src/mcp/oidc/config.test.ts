import type { Database } from "dofek/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../logger.ts", () => ({ logger: { warn } }));

import { createOidcProvider } from "./config.ts";

describe("MCP OIDC token exchange diagnostics", () => {
  beforeEach(() => {
    warn.mockReset();
  });

  it("logs the token endpoint rejection reason without assertion material", () => {
    const db: Pick<Database, "execute"> = { execute: vi.fn() };
    const { provider } = createOidcProvider(db, { cookiesKeys: ["test-key"] });
    const assertion = ["eyJhbGciOiJSUzI1NiJ9", "eyJzdWIiOiJjaGF0Z3B0In0", "signature"].join(".");
    const error = Object.assign(new Error("invalid_client"), {
      error: "invalid_client",
      error_description: `Client assertion rejected: ${assertion}`,
      name: "InvalidClientAuth",
      status: 401,
    });

    provider.emit("grant.error", {}, error);

    expect(warn).toHaveBeenCalledWith("mcp.oidc.token_exchange_failed", {
      error_name: "InvalidClientAuth",
      error_description: "Client assertion rejected: [redacted]",
      http_status: 401,
      oauth_error: "invalid_client",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(assertion);
  });
});
