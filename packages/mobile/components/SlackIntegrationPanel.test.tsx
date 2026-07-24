import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as WebBrowser from "expo-web-browser";
import { describe, expect, it, vi } from "vitest";

const mockSlackStatus = {
  data: undefined satisfies { configured: boolean; connected: boolean } | undefined,
  isLoading: true,
  refetch: vi.fn(),
};

vi.mock("../lib/trpc", () => ({
  trpc: {
    settings: {
      slackStatus: { useQuery: () => mockSlackStatus },
    },
  },
}));

vi.mock("../lib/auth-context", () => ({
  useAuth: () => ({ sessionToken: "test-session-token" }),
}));

vi.mock("../lib/server", () => ({
  SERVER_URL: "https://dofek.test",
}));

import { SlackIntegrationPanel } from "./SlackIntegrationPanel";

describe("SlackIntegrationPanel", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ code: "provider-handoff-code" }), { status: 200 }),
        ),
    );
  });

  it("shows loading state", () => {
    mockSlackStatus.data = undefined;
    mockSlackStatus.isLoading = true;

    render(<SlackIntegrationPanel />);
    expect(screen.getByText("Checking Slack status...")).toBeTruthy();
  });

  it("shows not configured when server has no Slack config", () => {
    mockSlackStatus.data = { configured: false, connected: false };
    mockSlackStatus.isLoading = false;

    render(<SlackIntegrationPanel />);
    expect(screen.getByText("Slack integration is not configured on this server.")).toBeTruthy();
  });

  it("shows connected state with green dot", () => {
    mockSlackStatus.data = { configured: true, connected: true };
    mockSlackStatus.isLoading = false;

    render(<SlackIntegrationPanel />);
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("DM the bot in Slack to log what you ate")).toBeTruthy();
  });

  it("shows Add to Slack button when configured but not connected", () => {
    mockSlackStatus.data = { configured: true, connected: false };
    mockSlackStatus.isLoading = false;

    render(<SlackIntegrationPanel />);
    expect(screen.getByText("Add to Slack")).toBeTruthy();
    expect(screen.getByText("Log food via Slack")).toBeTruthy();
  });

  it("opens browser and refetches on Add to Slack press", async () => {
    mockSlackStatus.data = { configured: true, connected: false };
    mockSlackStatus.isLoading = false;
    mockSlackStatus.refetch.mockClear();
    vi.mocked(WebBrowser.openBrowserAsync).mockResolvedValue({
      type: WebBrowser.WebBrowserResultType.CANCEL,
    });

    render(<SlackIntegrationPanel />);
    fireEvent.click(screen.getByText("Add to Slack"));

    await waitFor(() => {
      expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith(
        "https://dofek.test/auth/provider/slack?code=provider-handoff-code",
        expect.objectContaining({
          presentationStyle: "pageSheet",
        }),
      );
    });

    await waitFor(() => {
      expect(mockSlackStatus.refetch).toHaveBeenCalled();
    });
  });

  it("prevents duplicate Slack handoffs while connecting", async () => {
    let finishHandoff: (response: Response) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
          finishHandoff = resolve;
        }),
      ),
    );
    mockSlackStatus.data = { configured: true, connected: false };
    mockSlackStatus.isLoading = false;

    render(<SlackIntegrationPanel />);
    const connectButton = screen.getByRole("button", { name: "Add to Slack" });
    fireEvent.click(connectButton);

    await waitFor(() => {
      expect(connectButton.getAttribute("aria-busy")).toBe("true");
      expect(connectButton).toHaveProperty("disabled", true);
    });
    fireEvent.click(connectButton);
    expect(fetch).toHaveBeenCalledTimes(1);

    finishHandoff(new Response(JSON.stringify({ code: "provider-handoff-code" }), { status: 200 }));
  });
});
