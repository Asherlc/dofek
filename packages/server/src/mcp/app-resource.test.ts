import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { healthExplorerResourceUri, registerDofekAppResources } from "./app-resource.ts";

const mockRegisterAppResource = vi.fn();
const mockReadFile = vi.fn();

vi.mock("@modelcontextprotocol/ext-apps/server", () => ({
  RESOURCE_MIME_TYPE: "text/html;profile=mcp-app",
  registerAppResource: (...args: unknown[]) => mockRegisterAppResource(...args),
}));

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
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

  it("serves the self-contained explorer resource", async () => {
    mockReadFile.mockResolvedValue("<html>analytics explorer</html>");
    const server = { registerResource: vi.fn() } satisfies Pick<McpServer, "registerResource">;

    registerDofekAppResources(server);

    const resourceHandler = mockRegisterAppResource.mock.calls.at(-1)?.[4];
    if (typeof resourceHandler !== "function") {
      throw new Error("Expected the registered resource handler to be a function");
    }
    await expect(resourceHandler()).resolves.toEqual({
      contents: [
        {
          uri: healthExplorerResourceUri,
          mimeType: "text/html;profile=mcp-app",
          text: "<html>analytics explorer</html>",
          _meta: {
            ui: { csp: { connectDomains: [], resourceDomains: [] } },
          },
        },
      ],
    });
  });
});
