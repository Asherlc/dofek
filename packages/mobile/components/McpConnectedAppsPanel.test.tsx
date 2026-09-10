import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpConnectedAppsPanel } from "./McpConnectedAppsPanel";

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn(),
  listConnectedApps: vi.fn(),
  revokeConnectedApp: vi.fn(),
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      mcp: {
        listConnectedApps: { invalidate: mocks.invalidate },
      },
    }),
    mcp: {
      listConnectedApps: { useQuery: mocks.listConnectedApps },
      revokeConnectedApp: {
        useMutation: () => ({ mutateAsync: mocks.revokeConnectedApp, isPending: false }),
      },
    },
  },
}));

describe("McpConnectedAppsPanel", () => {
  beforeEach(() => {
    mocks.invalidate.mockReset();
    mocks.listConnectedApps.mockReset();
    mocks.revokeConnectedApp.mockReset().mockResolvedValue({});
  });

  it("shows OAuth connections and revokes the selected app", async () => {
    mocks.listConnectedApps.mockReturnValue({
      data: {
        items: [
          {
            name: "Claude OAuth",
            scopes: ["health:read"],
            connectedAt: "2026-05-20T12:00:00Z",
            lastUsedAt: "2026-05-20T12:30:00Z",
            oauthClientId: "https://claude.ai/oauth/client-metadata.json",
            oauthResource: "https://dofek.example/api/mcp",
            isActive: true,
          },
        ],
        nextCursor: null,
      },
      error: null,
      isLoading: false,
    });

    render(<McpConnectedAppsPanel />);

    expect(screen.getByText("Connected apps")).toBeTruthy();
    expect(screen.getByText("Claude OAuth")).toBeTruthy();
    expect(screen.queryByText("Access expires")).toBeNull();
    expect(screen.queryByText("Personal Codex")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect Claude OAuth" }));

    await waitFor(() => {
      expect(mocks.revokeConnectedApp).toHaveBeenCalledWith({
        oauthClientId: "https://claude.ai/oauth/client-metadata.json",
        oauthResource: "https://dofek.example/api/mcp",
      });
    });
  });

  it("moves between connected-app pages", () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => ({
      name: `OAuth app ${index}`,
      scopes: ["health:read"],
      connectedAt: "2026-05-20T12:00:00Z",
      lastUsedAt: null,
      oauthClientId: `oauth-client-${index}`,
      oauthResource: "https://dofek.example/api/mcp",
      isActive: true,
    }));
    mocks.listConnectedApps.mockImplementation(({ cursor }: { cursor?: string }) => ({
      data: cursor
        ? { items: [], nextCursor: null }
        : { items: firstPage, nextCursor: "oauth-client-19" },
      error: null,
      isLoading: false,
    }));

    render(<McpConnectedAppsPanel />);

    expect(screen.getByRole("button", { name: "Next connected apps page" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next connected apps page" }));
    expect(screen.getByRole("button", { name: "Previous connected apps page" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous connected apps page" }));
    expect(screen.getByText("OAuth app 0")).toBeTruthy();
  });

  it("shows refetch errors while retaining cached connected apps", () => {
    mocks.listConnectedApps.mockReturnValue({
      data: {
        items: [
          {
            name: "Claude OAuth",
            scopes: ["health:read"],
            connectedAt: "2026-05-20T12:00:00Z",
            lastUsedAt: null,
            oauthClientId: "oauth-client",
            oauthResource: "https://dofek.example/api/mcp",
            isActive: true,
          },
        ],
        nextCursor: null,
      },
      error: new Error("Connected apps request failed"),
      isLoading: false,
    });

    render(<McpConnectedAppsPanel />);

    expect(screen.getByText("Claude OAuth")).toBeTruthy();
    expect(screen.getByText("Connected apps request failed")).toBeTruthy();
  });
});
