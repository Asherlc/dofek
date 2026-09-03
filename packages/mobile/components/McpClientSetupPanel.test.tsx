/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureException } from "../lib/telemetry";
import { McpClientSetupPanel } from "./McpClientSetupPanel";

const mocks = vi.hoisted(() => ({
  openExternalUrl: vi.fn(),
  setStringAsync: vi.fn(),
}));

vi.mock("expo-clipboard", () => ({ setStringAsync: mocks.setStringAsync }));
vi.mock("../lib/open-external-url", () => ({ openExternalUrl: mocks.openExternalUrl }));
vi.mock("../lib/telemetry", () => ({ captureException: vi.fn() }));

const endpoint = "https://dofek.fit/api/mcp";

describe("McpClientSetupPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.openExternalUrl.mockResolvedValue(true);
    mocks.setStringAsync.mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  it("opens provider-specific setup links", async () => {
    render(<McpClientSetupPanel endpoint={endpoint} />);

    fireEvent.click(screen.getByRole("button", { name: "Connect Claude" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to Cursor" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to VS Code" }));

    await waitFor(() => expect(mocks.openExternalUrl).toHaveBeenCalledTimes(3));
    expect(mocks.openExternalUrl.mock.calls[0]?.[0]).toContain("claude.ai/customize/connectors");
    expect(mocks.openExternalUrl.mock.calls[1]?.[0]).toMatch(/^cursor:\/\//);
    expect(mocks.openExternalUrl.mock.calls[2]?.[0]).toMatch(/^vscode:mcp\/install\?/);
  });

  it("copies ChatGPT and command-line setup instructions", async () => {
    render(<McpClientSetupPanel endpoint={endpoint} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy for ChatGPT" }));
    await waitFor(() => expect(mocks.setStringAsync).toHaveBeenCalledWith(endpoint));
    expect(screen.getByText(/In ChatGPT desktop, open Settings/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Other MCP clients" }));
    expect(screen.getByText(/codex mcp add dofek --url/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy Codex setup" }));
    await waitFor(() =>
      expect(mocks.setStringAsync).toHaveBeenCalledWith(
        `codex mcp add dofek --url ${endpoint}\ncodex mcp login dofek`,
      ),
    );
  });

  it("surfaces and reports clipboard failures", async () => {
    const clipboardError = new Error("Clipboard permission denied");
    mocks.setStringAsync.mockRejectedValue(clipboardError);
    render(<McpClientSetupPanel endpoint={endpoint} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy for ChatGPT" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Copy failed. Select the MCP URL and copy it manually.",
    );
    expect(captureException).toHaveBeenCalledWith(clipboardError, {
      source: "mcp-client-setup-copy",
      client: "ChatGPT",
    });
  });

  it("directs command-copy failures to the visible setup text", async () => {
    mocks.setStringAsync.mockRejectedValue(new Error("Clipboard permission denied"));
    render(<McpClientSetupPanel endpoint={endpoint} />);

    fireEvent.click(screen.getByRole("button", { name: "Other MCP clients" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy Codex setup" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Copy failed. Select the setup text and copy it manually.",
    );
  });
});
