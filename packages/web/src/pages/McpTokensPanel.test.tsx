/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpTokensPanel } from "./McpTokensPanel.tsx";

type MockMcpToken = {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
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
let createTokenMutationPending = false;
let revokeTokenMutationPending = false;

vi.mock("../lib/telemetry.ts", () => ({
  captureException: vi.fn(),
}));

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
          isPending: createTokenMutationPending,
        }),
      },
      revokeToken: {
        useMutation: () => ({
          mutateAsync: revokeTokenMutateAsync,
          error: null,
          isPending: revokeTokenMutationPending,
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
    createTokenMutationPending = false;
    revokeTokenMutationPending = false;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows an empty state when no MCP tokens exist", () => {
    render(<McpTokensPanel />);

    expect(screen.getByText("No MCP tokens yet.")).toBeTruthy();
  });

  it("renders without a browser window", () => {
    vi.stubGlobal("window", undefined);

    expect(() => renderToString(<McpTokensPanel />)).not.toThrow();
  });

  it("shows OAuth and manual token connection instructions", () => {
    render(<McpTokensPanel />);

    expect(screen.getByText("Connect with OAuth (Recommended)")).toBeTruthy();
    expect(screen.getByText(/For clients that support OAuth auto-discovery/)).toBeTruthy();
    expect(screen.getByText("Remote URL")).toBeTruthy();

    expect(screen.getByText("Connect with a manual token")).toBeTruthy();
    expect(screen.getByText(/For clients that support custom HTTP headers/)).toBeTruthy();
    expect(screen.getByText("Client settings JSON")).toBeTruthy();
    expect(screen.getByText(/"mcpServers"/)).toBeTruthy();
    expect(screen.getByText(/Bearer dofek_mcp_your_token/)).toBeTruthy();
  });

  it("creates a token and shows the raw value once", async () => {
    createTokenMutateAsync.mockResolvedValueOnce({
      token: "dofek_mcp_created",
      metadata: {
        id: "token-id",
        name: "Codex",
        scopes: ["health:read"],
        createdAt: "2026-05-20T12:00:00Z",
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
        scopes: ["health:read", "activity:read", "nutrition:read", "providers:read", "sync:write"],
        expiresAt: null,
      });
    });
    expect(await screen.findByDisplayValue("dofek_mcp_created")).toBeTruthy();
    expect(screen.getByText("Save this token now. It will not be shown again.")).toBeTruthy();
    expect(screen.getByText(/Bearer dofek_mcp_created/)).toBeTruthy();
    expect(invalidateMcp).toHaveBeenCalled();
  });

  it("revokes an active token", async () => {
    listTokensQuery.data = [
      {
        id: "00000000-0000-0000-0000-000000000001",
        name: "Codex",
        scopes: ["health:read"],
        createdAt: "2026-05-20T12:00:00Z",
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
      },
    ];
    revokeTokenMutateAsync.mockResolvedValueOnce({
      id: "00000000-0000-0000-0000-000000000001",
      name: "Codex",
      scopes: ["health:read"],
      createdAt: "2026-05-20T12:00:00Z",
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: "2026-05-20T12:30:00Z",
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

  it("rotates an active token with the same settings", async () => {
    listTokensQuery.data = [
      {
        id: "00000000-0000-0000-0000-000000000001",
        name: "Codex",
        scopes: ["health:read", "providers:read"],
        createdAt: "2026-05-20T12:00:00Z",
        lastUsedAt: null,
        expiresAt: "2026-06-01T00:00:00Z",
        revokedAt: null,
      },
    ];
    createTokenMutateAsync.mockResolvedValueOnce({
      token: "dofek_mcp_rotated",
      metadata: {
        id: "00000000-0000-0000-0000-000000000002",
        name: "Codex",
        scopes: ["health:read", "providers:read"],
        createdAt: "2026-05-21T12:00:00Z",
        lastUsedAt: null,
        expiresAt: "2026-06-01T00:00:00Z",
        revokedAt: null,
      },
    });
    revokeTokenMutateAsync.mockResolvedValueOnce({
      id: "00000000-0000-0000-0000-000000000001",
      name: "Codex",
      scopes: ["health:read", "providers:read"],
      createdAt: "2026-05-20T12:00:00Z",
      lastUsedAt: null,
      expiresAt: "2026-06-01T00:00:00Z",
      revokedAt: "2026-05-21T12:01:00Z",
    });

    render(<McpTokensPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Rotate Codex" }));

    await waitFor(() => {
      expect(createTokenMutateAsync).toHaveBeenCalledWith({
        name: "Codex",
        scopes: ["health:read", "providers:read"],
        expiresAt: "2026-06-01T00:00:00.000Z",
      });
      expect(revokeTokenMutateAsync).toHaveBeenCalledWith({
        tokenId: "00000000-0000-0000-0000-000000000001",
      });
    });
    expect(await screen.findByDisplayValue("dofek_mcp_rotated")).toBeTruthy();
    expect(screen.getByText(/Bearer dofek_mcp_rotated/)).toBeTruthy();
    expect(invalidateMcp).toHaveBeenCalled();
  });

  it("reports partial rotation failure and refreshes tokens", async () => {
    listTokensQuery.data = [
      {
        id: "00000000-0000-0000-0000-000000000001",
        name: "Codex",
        scopes: ["health:read", "providers:read"],
        createdAt: "2026-05-20T12:00:00Z",
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
      },
    ];
    createTokenMutateAsync.mockResolvedValueOnce({
      token: "dofek_mcp_created_before_revoke_failed",
      metadata: {
        id: "00000000-0000-0000-0000-000000000002",
        name: "Codex",
        scopes: ["health:read", "providers:read"],
        createdAt: "2026-05-21T12:00:00Z",
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
      },
    });
    revokeTokenMutateAsync.mockRejectedValueOnce(new Error("Revoke failed"));

    render(<McpTokensPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Rotate Codex" }));

    await waitFor(() => {
      expect(revokeTokenMutateAsync).toHaveBeenCalledWith({
        tokenId: "00000000-0000-0000-0000-000000000001",
      });
    });
    expect(await screen.findByDisplayValue("dofek_mcp_created_before_revoke_failed")).toBeTruthy();
    expect(
      screen.getByText(
        "New token created, but failed to revoke the old token. Revoke the old token manually.",
      ),
    ).toBeTruthy();
    expect(invalidateMcp).toHaveBeenCalled();
  });

  it("disables revoke while token creation is pending", () => {
    createTokenMutationPending = true;
    listTokensQuery.data = [
      {
        id: "00000000-0000-0000-0000-000000000001",
        name: "Codex",
        scopes: ["health:read"],
        createdAt: "2026-05-20T12:00:00Z",
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
      },
    ];

    render(<McpTokensPanel />);

    expect(screen.getByRole("button", { name: "Revoke Codex" }).getAttribute("disabled")).not.toBe(
      null,
    );
  });
});
