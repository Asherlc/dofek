// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackIntegrationPanel } from "./SlackIntegrationPanel.tsx";

interface MockSlackStatus {
  data: { configured: boolean; connected: boolean } | undefined;
  error: Error | null;
  isLoading: boolean;
}

const mockSlackStatus = vi.hoisted(
  (): MockSlackStatus => ({
    data: undefined,
    error: null,
    isLoading: false,
  }),
);

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    settings: {
      slackStatus: { useQuery: () => mockSlackStatus },
    },
  },
}));

describe("SlackIntegrationPanel", () => {
  beforeEach(() => {
    mockSlackStatus.data = undefined;
    mockSlackStatus.error = null;
    mockSlackStatus.isLoading = false;
  });

  afterEach(cleanup);

  it("shows the initial status error without claiming Slack is unconfigured", () => {
    mockSlackStatus.error = new Error("Slack status is temporarily unavailable");

    render(<SlackIntegrationPanel />);

    expect(screen.getByText("Slack status is temporarily unavailable")).toBeTruthy();
    expect(screen.queryByText("Slack integration is not configured on this server.")).toBeNull();
    expect(screen.queryByRole("link", { name: "Add to Slack" })).toBeNull();
  });

  it("keeps cached connected status visible after a background refresh failure", () => {
    mockSlackStatus.data = { configured: true, connected: true };
    mockSlackStatus.error = new Error("Slack status refresh failed");

    render(<SlackIntegrationPanel />);

    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Slack status refresh failed")).toBeTruthy();
  });
});
