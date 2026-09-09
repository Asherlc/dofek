import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpConnectedAppsPanel } from "./McpConnectedAppsPanel";

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn(),
  listTokens: vi.fn(),
  revokeToken: vi.fn(),
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      mcp: { listTokens: { invalidate: mocks.invalidate } },
    }),
    mcp: {
      listTokens: { useQuery: mocks.listTokens },
      revokeToken: {
        useMutation: () => ({ mutateAsync: mocks.revokeToken, isPending: false }),
      },
    },
  },
}));

describe("McpConnectedAppsPanel", () => {
  beforeEach(() => {
    mocks.invalidate.mockReset();
    mocks.listTokens.mockReset();
    mocks.revokeToken.mockReset().mockResolvedValue({});
  });

  it("shows OAuth connections and revokes the selected app", async () => {
    mocks.listTokens.mockReturnValue({
      data: [
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
        {
          id: "personal-token-id",
          name: "Personal Codex",
          scopes: ["health:read"],
          createdAt: "2026-05-20T12:00:00Z",
          lastUsedAt: null,
          expiresAt: null,
          revokedAt: null,
          oauthClientId: null,
        },
      ],
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
});
