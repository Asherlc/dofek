/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureException } from "../lib/telemetry.ts";
import { McpClientSetupPanel } from "./McpClientSetupPanel.tsx";

vi.mock("../lib/telemetry.ts", () => ({ captureException: vi.fn() }));

const endpoint = "https://dofek.fit/api/mcp";

describe("McpClientSetupPanel", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("offers one-click setup for Claude, Cursor, and VS Code", () => {
    render(<McpClientSetupPanel endpoint={endpoint} />);

    expect(screen.getByRole("link", { name: "Connect Claude" }).getAttribute("href")).toContain(
      "claude.ai/customize/connectors",
    );
    expect(screen.getByRole("link", { name: "Add to Cursor" }).getAttribute("href")).toMatch(
      /^cursor:\/\//,
    );
    expect(screen.getByRole("link", { name: "Add to VS Code" }).getAttribute("href")).toMatch(
      /^vscode:mcp\/install\?/,
    );
  });

  it("copies the endpoint for ChatGPT and explains the remaining confirmation", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<McpClientSetupPanel endpoint={endpoint} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy for ChatGPT" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(endpoint));
    expect(screen.getByRole("status").textContent).toContain(
      "In ChatGPT desktop, open Settings → MCP servers → Add server",
    );
  });

  it("shows and copies setup instructions for other clients", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<McpClientSetupPanel endpoint={endpoint} />);

    fireEvent.click(screen.getByText("Other MCP clients"));
    expect(screen.getByText(/claude mcp add --transport http/)).toBeTruthy();
    expect(screen.getByText(/codex mcp add dofek --url/)).toBeTruthy();
    expect(screen.getByText(/gemini mcp add dofek/)).toBeTruthy();
    expect(screen.getByText(/"serverUrl": "https:\/\/dofek\.fit\/api\/mcp"/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Copy Codex setup" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        `codex mcp add dofek --url ${endpoint}\ncodex mcp login dofek`,
      ),
    );
  });

  it("reports clipboard failures without hiding the endpoint", async () => {
    const clipboardError = new Error("Clipboard unavailable");
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(clipboardError) },
    });
    render(<McpClientSetupPanel endpoint={endpoint} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy for ChatGPT" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Copy failed. Select the MCP URL and copy it manually.",
    );
    expect(screen.getByText(endpoint)).toBeTruthy();
    expect(captureException).toHaveBeenCalledWith(clipboardError, {
      context: "copy-mcp-client-setup",
      client: "ChatGPT",
    });
  });

  it("directs command-copy failures to the visible setup text", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("Clipboard unavailable")) },
    });
    render(<McpClientSetupPanel endpoint={endpoint} />);

    fireEvent.click(screen.getByText("Other MCP clients"));
    fireEvent.click(screen.getByRole("button", { name: "Copy Codex setup" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Copy failed. Select the setup text and copy it manually.",
    );
  });
});
