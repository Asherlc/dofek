/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpTokensPanel } from "./McpTokensPanel.tsx";

type MockMcpToken = {
  id: string;
  name: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
};

const listTokensQuery: {
  data: MockMcpToken[];
  error: Error | null;
  isLoading: boolean;
  refetch: ReturnType<typeof vi.fn>;
} = {
  data: [],
  error: null,
  isLoading: false,
  refetch: vi.fn(),
};
const createTokenMutateAsync = vi.fn();
const revokeTokenMutateAsync = vi.fn();
const invalidateMcp = vi.fn();

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    useUtils: () => ({
      mcp: {
        listTokens: {
          invalidate: invalidateMcp,
        },
      },
    }),
    mcp: {
      listTokens: { useQuery: () => listTokensQuery },
      createToken: {
        useMutation: () => ({
          mutateAsync: createTokenMutateAsync,
          error: null,
          isPending: false,
        }),
      },
      revokeToken: {
        useMutation: () => ({
          mutateAsync: revokeTokenMutateAsync,
          error: null,
          isPending: false,
        }),
      },
    },
  },
}));

describe("McpTokensPanel", () => {
  beforeEach(() => {
    listTokensQuery.data = [];
    listTokensQuery.error = null;
    listTokensQuery.isLoading = false;
    listTokensQuery.refetch.mockReset();
    createTokenMutateAsync.mockReset();
    revokeTokenMutateAsync.mockReset();
    invalidateMcp.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows an empty state when no MCP tokens exist", () => {
    render(<McpTokensPanel />);

    expect(screen.getByText("No MCP tokens yet.")).toBeTruthy();
  });

  it("creates a token and shows the raw value once", async () => {
    createTokenMutateAsync.mockResolvedValueOnce({
      token: "dofek_mcp_created",
      metadata: {
        id: "token-id",
        name: "Codex",
        scopes: ["health:read"],
        createdAt: new Date("2026-05-20T12:00:00Z"),
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
      },
    });

    render(<McpTokensPanel />);

    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: "Codex" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Token" }));

    await waitFor(() => {
      expect(createTokenMutateAsync).toHaveBeenCalledWith({
        name: "Codex",
        scopes: ["health:read", "activity:read", "nutrition:write", "providers:read", "sync:write"],
        expiresAt: null,
      });
    });
    expect(await screen.findByDisplayValue("dofek_mcp_created")).toBeTruthy();
    expect(screen.getByText("Save this token now. It will not be shown again.")).toBeTruthy();
    expect(invalidateMcp).toHaveBeenCalled();
  });

  it("revokes an active token", async () => {
    listTokensQuery.data = [
      {
        id: "00000000-0000-0000-0000-000000000001",
        name: "Codex",
        scopes: ["health:read"],
        createdAt: new Date("2026-05-20T12:00:00Z"),
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
      },
    ];
    revokeTokenMutateAsync.mockResolvedValueOnce({
      id: "00000000-0000-0000-0000-000000000001",
      name: "Codex",
      scopes: ["health:read"],
      createdAt: new Date("2026-05-20T12:00:00Z"),
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: new Date("2026-05-20T12:30:00Z"),
    });

    render(<McpTokensPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Revoke Codex" }));

    await waitFor(() => {
      expect(revokeTokenMutateAsync).toHaveBeenCalledWith({
        tokenId: "00000000-0000-0000-0000-000000000001",
      });
    });
    expect(invalidateMcp).toHaveBeenCalled();
  });
});
