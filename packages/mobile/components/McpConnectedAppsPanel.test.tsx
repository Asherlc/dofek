import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpConnectedAppsPanel } from "./McpConnectedAppsPanel";

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn(),
  listConnectedApps: vi.fn(),
  revokeToken: vi.fn(),
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
      revokeToken: {
        useMutation: () => ({ mutateAsync: mocks.revokeToken, isPending: false }),
      },
    },
  },
}));

describe("McpConnectedAppsPanel", () => {
  beforeEach(() => {
    mocks.invalidate.mockReset();
    mocks.listConnectedApps.mockReset();
    mocks.revokeToken.mockReset().mockResolvedValue({});
  });

  it("shows OAuth connections and revokes the selected app", async () => {
    mocks.listConnectedApps.mockReturnValue({
      data: {
        items: [
          {
            id: "oauth-token-id",
            name: "Claude OAuth",
            scopes: ["health:read"],
            createdAt: "2026-05-20T12:00:00Z",
            lastUsedAt: "2026-05-20T12:30:00Z",
            expiresAt: "2020-01-01T00:00:00Z",
            revokedAt: null,
            oauthClientId: "https://claude.ai/oauth/client-metadata.json",
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
    expect(screen.getByText("Expired")).toBeTruthy();
    expect(screen.queryByText("Personal Codex")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Revoke access for Claude OAuth" }));

    await waitFor(() => {
      expect(mocks.revokeToken).toHaveBeenCalledWith({ tokenId: "oauth-token-id" });
    });
  });

  it("moves between connected-app pages", () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => ({
      id: `oauth-token-${index}`,
      name: `OAuth app ${index}`,
      scopes: ["health:read"],
      createdAt: "2026-05-20T12:00:00Z",
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      oauthClientId: "oauth-client",
    }));
    const secondPage = [
      {
        id: "oauth-token-last",
        name: "OAuth app last",
        scopes: ["health:read"],
        createdAt: "2026-05-19T12:00:00Z",
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
        oauthClientId: "oauth-client",
      },
    ];
    mocks.listConnectedApps.mockImplementation(({ cursor }: { cursor?: string }) => ({
      data: cursor
        ? { items: secondPage, nextCursor: null }
        : { items: firstPage, nextCursor: "oauth-token-19" },
      error: null,
      isLoading: false,
    }));

    render(<McpConnectedAppsPanel />);

    expect(screen.getByRole("button", { name: "Next connected apps page" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next connected apps page" }));
    expect(screen.getByText("OAuth app last")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous connected apps page" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous connected apps page" }));
    expect(screen.getByText("OAuth app 0")).toBeTruthy();
  });
});
