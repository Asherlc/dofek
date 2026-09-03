import { describe, expect, it } from "vitest";
import {
  buildClaudeConnectorUrl,
  buildCursorInstallUrl,
  buildMcpClientInstructions,
  buildVsCodeInstallUrl,
} from "./client-setup.ts";

const endpoint = "https://dofek.fit/api/mcp";

describe("MCP client setup", () => {
  it("builds the official Claude custom connector URL", () => {
    const url = new URL(buildClaudeConnectorUrl(endpoint));

    expect(url.origin).toBe("https://claude.ai");
    expect(url.pathname).toBe("/customize/connectors");
    expect(url.searchParams.get("modal")).toBe("add-custom-connector");
    expect(url.searchParams.get("connectorName")).toBe("Dofek");
    expect(url.searchParams.get("connectorUrl")).toBe(endpoint);
  });

  it("builds a Cursor deeplink containing the remote server configuration", () => {
    const url = new URL(buildCursorInstallUrl(endpoint));

    expect(url.protocol).toBe("cursor:");
    expect(url.hostname).toBe("anysphere.cursor-deeplink");
    expect(url.pathname).toBe("/mcp/install");
    expect(url.searchParams.get("name")).toBe("Dofek");
    expect(JSON.parse(atob(url.searchParams.get("config") ?? ""))).toEqual({ url: endpoint });
  });

  it("builds a VS Code install URL containing an HTTP server definition", () => {
    const url = new URL(buildVsCodeInstallUrl(endpoint));
    const configuration = JSON.parse(decodeURIComponent(url.search.slice(1)));

    expect(url.protocol).toBe("vscode:");
    expect(url.pathname).toBe("mcp/install");
    expect(configuration).toEqual({ name: "dofek", type: "http", url: endpoint });
  });

  it("provides copyable instructions for clients without install deep links", () => {
    expect(buildMcpClientInstructions(endpoint)).toEqual([
      {
        id: "claude-code",
        name: "Claude Code",
        instruction: `claude mcp add --transport http --scope user dofek ${endpoint}`,
      },
      {
        id: "codex",
        name: "Codex",
        instruction: `codex mcp add dofek --url ${endpoint}\ncodex mcp login dofek`,
      },
      {
        id: "gemini-cli",
        name: "Gemini CLI",
        instruction: `gemini mcp add dofek ${endpoint} --transport http --scope user`,
      },
      {
        id: "windsurf",
        name: "Windsurf",
        instruction: JSON.stringify({ mcpServers: { dofek: { serverUrl: endpoint } } }, null, 2),
      },
    ]);
  });
});
