import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import {
  dayNutritionResourceUri,
  healthExplorerResourceUri,
  registerDofekAppResources,
} from "./app-resource.ts";

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
  it("registers the analytics explorer and day nutrition apps with a restrictive CSP", () => {
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
    expect(mockRegisterAppResource).toHaveBeenCalledWith(
      server,
      "Dofek Day Nutrition",
      dayNutritionResourceUri,
      expect.objectContaining({
        mimeType: "text/html;profile=mcp-app",
        _meta: {
          ui: { csp: { connectDomains: [], resourceDomains: [] } },
        },
      }),
      expect.any(Function),
    );
  });

  it("serves the self-contained explorer and day nutrition resources", async () => {
    mockReadFile.mockResolvedValue("<html>dofek mcp app</html>");
    const server = { registerResource: vi.fn() } satisfies Pick<McpServer, "registerResource">;

    registerDofekAppResources(server);

    const explorerHandler = mockRegisterAppResource.mock.calls[0]?.[4];
    const dayNutritionHandler = mockRegisterAppResource.mock.calls[1]?.[4];
    if (typeof explorerHandler !== "function" || typeof dayNutritionHandler !== "function") {
      throw new Error("Expected the registered resource handlers to be functions");
    }
    await expect(explorerHandler()).resolves.toEqual({
      contents: [
        {
          uri: healthExplorerResourceUri,
          mimeType: "text/html;profile=mcp-app",
          text: "<html>dofek mcp app</html>",
          _meta: {
            ui: { csp: { connectDomains: [], resourceDomains: [] } },
          },
        },
      ],
    });
    await expect(dayNutritionHandler()).resolves.toEqual({
      contents: [
        {
          uri: dayNutritionResourceUri,
          mimeType: "text/html;profile=mcp-app",
          text: "<html>dofek mcp app</html>",
          _meta: {
            ui: { csp: { connectDomains: [], resourceDomains: [] } },
          },
        },
      ],
    });
  });
});
