import {
  buildClaudeConnectorUrl,
  buildCursorInstallUrl,
  buildMcpClientInstructions,
  buildVsCodeInstallUrl,
} from "@dofek/mcp-contracts/client-setup";
import { useState } from "react";
import { captureException } from "../lib/telemetry.ts";

type CopyMessage = { kind: "error" | "success"; text: string } | null;

export function McpClientSetupPanel({ endpoint }: { endpoint: string }) {
  const [copyMessage, setCopyMessage] = useState<CopyMessage>(null);
  const instructions = buildMcpClientInstructions(endpoint);
  const actionClassName =
    "rounded border border-border-strong px-3 py-2 text-center text-sm font-medium text-foreground transition-colors hover:bg-surface-hover";

  async function copy(
    value: string,
    client: string,
    successText: string,
    fallbackTarget: "MCP URL" | "setup text",
  ): Promise<void> {
    setCopyMessage(null);
    try {
      await navigator.clipboard.writeText(value);
      setCopyMessage({ kind: "success", text: successText });
    } catch (error: unknown) {
      captureException(error, { context: "copy-mcp-client-setup", client });
      setCopyMessage({
        kind: "error",
        text: `Copy failed. Select the ${fallbackTarget} and copy it manually.`,
      });
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-border bg-surface-solid p-3">
      <div>
        <p className="text-sm font-medium text-foreground">Connect an AI client</p>
        <p className="mt-1 text-sm text-subtle">
          Choose a client, review the connection, then sign in to Dofek when prompted.
        </p>
      </div>
      <div className="space-y-1">
        <p className="text-xs font-medium text-subtle">Remote MCP URL</p>
        <code className="block overflow-x-auto rounded bg-surface px-3 py-2 text-xs text-foreground">
          {endpoint}
        </code>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <a
          href={buildClaudeConnectorUrl(endpoint)}
          className={actionClassName}
          target="_blank"
          rel="noreferrer"
        >
          Connect Claude
        </a>
        <button
          type="button"
          className={actionClassName}
          onClick={() =>
            void copy(
              endpoint,
              "ChatGPT",
              "Copied. In ChatGPT desktop, open Settings → MCP servers → Add server, then paste the URL.",
              "MCP URL",
            )
          }
        >
          Copy for ChatGPT
        </button>
        <a href={buildCursorInstallUrl(endpoint)} className={actionClassName}>
          Add to Cursor
        </a>
        <a href={buildVsCodeInstallUrl(endpoint)} className={actionClassName}>
          Add to VS Code
        </a>
      </div>
      <p className="text-xs text-dim">
        Claude, Cursor, and VS Code open a prefilled connection. ChatGPT requires pasting the copied
        URL and confirming it manually.
      </p>
      {copyMessage ? (
        <p
          className={copyMessage.kind === "error" ? "text-xs text-red-400" : "text-xs text-subtle"}
          role={copyMessage.kind === "error" ? "alert" : "status"}
        >
          {copyMessage.text}
        </p>
      ) : null}
      <details className="rounded border border-border bg-surface/70 px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium text-foreground">
          Other MCP clients
        </summary>
        <div className="mt-3 space-y-3">
          {instructions.map((client) => (
            <div key={client.id} className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-subtle">{client.name}</p>
                <button
                  type="button"
                  className="rounded border border-border-strong px-2 py-1 text-xs text-foreground hover:bg-surface-hover"
                  aria-label={`Copy ${client.name} setup`}
                  onClick={() =>
                    void copy(
                      client.instruction,
                      client.name,
                      `${client.name} setup copied.`,
                      "setup text",
                    )
                  }
                >
                  Copy
                </button>
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-surface p-3 text-xs text-foreground">
                <code>{client.instruction}</code>
              </pre>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
