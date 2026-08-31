import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { healthExplorerResourceUri, registerDofekAppResources } from "./app-resource.ts";

const mockRegisterAppResource = vi.fn();

vi.mock("@modelcontextprotocol/ext-apps/server", () => ({
  RESOURCE_MIME_TYPE: "text/html;profile=mcp-app",
  registerAppResource: (...args: unknown[]) => mockRegisterAppResource(...args),
}));

describe("registerDofekAppResources", () => {
  it("registers the analytics explorer with a restrictive CSP", () => {
    const server = { registerResource: vi.fn() } satisfies Pick<McpServer, "registerResource">;

    registerDofekAppResources(server);

    expect(mockRegisterAppResource).toHaveBeenCalledWith(
      server,
      "Dofek Analytics Explorer",
      healthExplorerResourceUri,
      expect.objectContaining({
        mimeType: "text/html;profile=mcp-app",
        _meta: {
          ui: { csp: { connectDomains: [], resourceDomains: [] } },
        },
      }),
      expect.any(Function),
    );
  });
});
