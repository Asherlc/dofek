import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RESOURCE_MIME_TYPE, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";

export const healthExplorerResourceUri = "ui://dofek/health-explorer.html";
export const dayNutritionResourceUri = "ui://dofek/day-nutrition.html";

const resourceMeta = {
  ui: {
    csp: {
      connectDomains: [],
      resourceDomains: [],
    },
  },
};

export function registerDofekAppResources(server: Pick<McpServer, "registerResource">): void {
  registerAppResource(
    server,
    "Dofek Analytics Explorer",
    healthExplorerResourceUri,
    {
      description: "Interactive read-only Dofek health analytics explorer.",
      mimeType: RESOURCE_MIME_TYPE,
      _meta: resourceMeta,
    },
    async () => ({
      contents: [
        {
          uri: healthExplorerResourceUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: await readFile(resolve(process.cwd(), "packages/mcp-app/dist/index.html"), "utf8"),
          _meta: resourceMeta,
        },
      ],
    }),
  );
  registerAppResource(
    server,
    "Dofek Day Nutrition",
    dayNutritionResourceUri,
    {
      description: "Compact calorie and macro preview after food logging.",
      mimeType: RESOURCE_MIME_TYPE,
      _meta: resourceMeta,
    },
    async () => ({
      contents: [
        {
          uri: dayNutritionResourceUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: await readFile(resolve(process.cwd(), "packages/mcp-app/dist/index.html"), "utf8"),
          _meta: resourceMeta,
        },
      ],
    }),
  );
}
