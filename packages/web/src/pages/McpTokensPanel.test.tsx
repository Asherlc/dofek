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

  it("shows query loading and error states", () => {
    listTokensQuery.isLoading = true;
    const { rerender } = render(<McpTokensPanel />);

    expect(screen.getByText("Loading MCP tokens...")).toBeTruthy();

    listTokensQuery.isLoading = false;
    listTokensQuery.error = new Error("MCP token service is unavailable");
    rerender(<McpTokensPanel />);

    expect(screen.getByText("MCP token service is unavailable")).toBeTruthy();
  });

  it("renders without a browser window", () => {
    vi.stubGlobal("window", undefined);

    expect(() => renderToString(<McpTokensPanel />)).not.toThrow();
  });

  it("keeps remote client setup and manual tokens off insecure origins", () => {
    render(<McpTokensPanel />);

    expect(screen.queryByText("Connect an AI client")).toBeNull();
    expect(screen.queryByText("Connect with a manual token")).toBeNull();
  });

  it("shows manual token configuration for an HTTPS origin", async () => {
    vi.stubGlobal("window", {
      location: { origin: "https://dofek.example", protocol: "https:" },
    });

    render(<McpTokensPanel />);

    expect(await screen.findByText("Connect an AI client")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Connect Claude" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy for ChatGPT" })).toBeTruthy();
    expect(await screen.findByText("Connect with a manual token")).toBeTruthy();
    expect(screen.getByText(/"url": "https:\/\/dofek\.example\/api\/mcp"/)).toBeTruthy();
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
    expect(invalidateMcp).toHaveBeenCalled();
  });

  it("requires at least one scope before creating a token", () => {
    render(<McpTokensPanel />);

    for (const label of [
      "Health summaries",
      "Activity history",
      "Nutrition summaries",
      "Provider status",
      "Start sync jobs",
    ]) {
      fireEvent.click(screen.getByLabelText(label));
    }

    expect(screen.getByRole("button", { name: "Create Token" }).getAttribute("disabled")).not.toBe(
      null,
    );

    fireEvent.click(screen.getByLabelText("Health summaries"));

    expect(screen.getByRole("button", { name: "Create Token" }).getAttribute("disabled")).toBe(
      null,
    );
  });

  it("shows the create-token error returned by the server", async () => {
    createTokenMutateAsync.mockRejectedValueOnce(new Error("Token name is already in use"));

    render(<McpTokensPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Create Token" }));

    expect(await screen.findByText("Token name is already in use")).toBeTruthy();
  });

  it("uses a generic create-token error for unexpected failures", async () => {
    createTokenMutateAsync.mockRejectedValueOnce("unexpected failure");

    render(<McpTokensPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Create Token" }));

    expect(await screen.findByText("Failed to create MCP token.")).toBeTruthy();
  });

  it("creates an expiring token", async () => {
    createTokenMutateAsync.mockResolvedValueOnce({
      token: "dofek_mcp_expiring",
      metadata: {},
    });

    render(<McpTokensPanel />);

    fireEvent.change(screen.getByLabelText("Expires"), { target: { value: "2026-06-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Token" }));

    await waitFor(() => {
      expect(createTokenMutateAsync).toHaveBeenCalledWith({
        name: "Codex",
        scopes: ["health:read", "activity:read", "nutrition:read", "providers:read", "sync:write"],
        expiresAt: "2026-06-01T23:59:59.999Z",
      });
    });
  });

  it("copies a newly-created token", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    createTokenMutateAsync.mockResolvedValueOnce({
      token: "dofek_mcp_copyable",
      metadata: {},
    });

    render(<McpTokensPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Create Token" }));
    await screen.findByDisplayValue("dofek_mcp_copyable");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("dofek_mcp_copyable");
    });
    expect(screen.getByText("Copied")).toBeTruthy();
  });

  it("explains how to copy a token when clipboard access fails", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("Clipboard unavailable")) },
    });
    createTokenMutateAsync.mockResolvedValueOnce({
      token: "dofek_mcp_not_copyable",
      metadata: {},
    });

    render(<McpTokensPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Create Token" }));
    await screen.findByDisplayValue("dofek_mcp_not_copyable");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect(
      await screen.findByText("Copy failed. Select the token and copy it manually."),
    ).toBeTruthy();
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

  it("shows a revoke error returned by the server", async () => {
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
    revokeTokenMutateAsync.mockRejectedValueOnce(new Error("Token has already been revoked"));

    render(<McpTokensPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Revoke Codex" }));

    expect(await screen.findByText("Token has already been revoked")).toBeTruthy();
  });

  it("shows revoked tokens without active-token actions", () => {
    listTokensQuery.data = [
      {
        id: "00000000-0000-0000-0000-000000000001",
        name: "Retired Codex",
        scopes: ["health:read"],
        createdAt: "2026-05-20T12:00:00Z",
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: "2026-05-21T12:00:00Z",
      },
    ];

    render(<McpTokensPanel />);

    expect(screen.getByText("Revoked")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rotate Retired Codex" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke Retired Codex" })).toBeNull();
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

  it("reports a rotation error when a replacement token cannot be created", async () => {
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
    createTokenMutateAsync.mockRejectedValueOnce(new Error("Token limit reached"));

    render(<McpTokensPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Rotate Codex" }));

    expect(await screen.findByText("Token limit reached")).toBeTruthy();
    expect(revokeTokenMutateAsync).not.toHaveBeenCalled();
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
