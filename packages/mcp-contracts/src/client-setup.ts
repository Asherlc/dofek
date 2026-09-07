export type McpClientInstruction = {
  id: "claude-code" | "codex" | "gemini-cli" | "windsurf";
  name: string;
  instruction: string;
};

export function buildClaudeConnectorUrl(endpoint: string): string {
  const url = new URL("https://claude.ai/customize/connectors");
  url.searchParams.set("modal", "add-custom-connector");
  url.searchParams.set("connectorName", "Dofek");
  url.searchParams.set("connectorUrl", endpoint);
  return url.toString();
}

export function buildCursorInstallUrl(endpoint: string): string {
  const configuration = btoa(JSON.stringify({ url: endpoint }));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=Dofek&config=${encodeURIComponent(configuration)}`;
}

export function buildVsCodeInstallUrl(endpoint: string): string {
  const configuration = JSON.stringify({ name: "dofek", type: "http", url: endpoint });
  return `vscode:mcp/install?${encodeURIComponent(configuration)}`;
}

export function buildMcpClientInstructions(endpoint: string): McpClientInstruction[] {
  return [
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
  ];
}
