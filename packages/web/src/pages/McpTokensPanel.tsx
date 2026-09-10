import { formatDateTime } from "@dofek/format/format";
import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import { useEffect, useState } from "react";
import { McpClientSetupPanel } from "../components/McpClientSetupPanel.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { locallyReportedErrorMeta } from "../lib/query-client.ts";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";

type McpScope =
  | "health:read"
  | "health:write"
  | "activity:read"
  | "nutrition:read"
  | "nutrition:write"
  | "providers:read"
  | "sync:write";

const mcpScopeOptions: Array<{ value: McpScope; label: string }> = [
  { value: "health:read", label: "Health summaries" },
  { value: "health:write", label: "Log health observations" },
  { value: "activity:read", label: "Activity history" },
  { value: "nutrition:read", label: "Nutrition summaries" },
  { value: "nutrition:write", label: "Modify food records" },
  { value: "providers:read", label: "Provider status" },
  { value: "sync:write", label: "Start sync jobs" },
];

const mcpScopeValues = mcpScopeOptions.map((option) => option.value);
const defaultMcpScopeValues = mcpScopeValues.filter(
  (scope) => scope !== "health:write" && scope !== "nutrition:write",
);

function formatTimestamp(value: Date | string | null): string {
  if (!value) return "Never";
  const formatted = formatDateTime(value);
  return formatted === "--" ? "Unknown" : formatted;
}

export function McpTokensPanel() {
  const trpcUtils = trpc.useUtils();
  const personalTokensQuery = trpc.mcp.listPersonalTokens.useQuery();
  const [connectedAppCursors, setConnectedAppCursors] = useState<Array<string | undefined>>([
    undefined,
  ]);
  const connectedAppsQuery = trpc.mcp.listConnectedApps.useQuery({
    cursor: connectedAppCursors.at(-1),
  });
  const createTokenMutation = trpc.mcp.createToken.useMutation({
    meta: locallyReportedErrorMeta,
  });
  const revokeTokenMutation = trpc.mcp.revokeToken.useMutation({
    meta: locallyReportedErrorMeta,
  });
  const updateScopesMutation = trpc.mcp.updateScopes.useMutation({
    meta: locallyReportedErrorMeta,
  });
  const [name, setName] = useState("Codex");
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [selectedScopes, setSelectedScopes] = useState<Set<McpScope>>(
    () => new Set(defaultMcpScopeValues),
  );
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [editingTokenId, setEditingTokenId] = useState<string | null>(null);
  const [editingScopes, setEditingScopes] = useState<Set<McpScope>>(() => new Set());
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [mcpEndpoint, setMcpEndpoint] = useState("/api/mcp");
  const [isSecureOrigin, setIsSecureOrigin] = useState<boolean | null>(null);
  const tokenForInstall = createdToken ?? "dofek_mcp_your_token";
  const oauthTokens = connectedAppsQuery.data?.items ?? [];
  const personalTokens = personalTokensQuery.data ?? [];

  const invalidateTokenLists = async () => {
    await Promise.all([
      trpcUtils.mcp.listPersonalTokens.invalidate(),
      trpcUtils.mcp.listConnectedApps.invalidate(),
    ]);
  };

  useEffect(() => {
    const secure = window.location.protocol === "https:";
    setIsSecureOrigin(secure);
    if (secure) setMcpEndpoint(`${window.location.origin}/api/mcp`);
  }, []);

  const activeScopeCount = selectedScopes.size;
  const canCreate =
    name.trim().length > 0 && activeScopeCount > 0 && !createTokenMutation.isPending;
  const tokenMutationPending =
    createTokenMutation.isPending ||
    revokeTokenMutation.isPending ||
    updateScopesMutation.isPending;

  const toggleScopeSet = (current: Set<McpScope>, scope: McpScope): Set<McpScope> => {
    const next = new Set(current);
    if (scope === "nutrition:write" && !next.has(scope)) {
      next.add("nutrition:read");
      next.add(scope);
      return next;
    }
    if (scope === "nutrition:read" && next.has("nutrition:write")) {
      return next;
    }
    if (next.has(scope)) {
      next.delete(scope);
    } else {
      next.add(scope);
    }
    return next;
  };

  const toggleScope = (scope: McpScope) => {
    setSelectedScopes((current) => toggleScopeSet(current, scope));
  };

  const beginEditScopes = (token: NonNullable<typeof personalTokensQuery.data>[number]) => {
    setErrorMessage(null);
    setEditingTokenId(token.id);
    const nextScopes = new Set(token.scopes);
    if (nextScopes.has("nutrition:write")) nextScopes.add("nutrition:read");
    setEditingScopes(nextScopes);
  };

  const cancelEditScopes = () => {
    setEditingTokenId(null);
    setEditingScopes(new Set());
  };

  const saveScopes = async (tokenId: string) => {
    setErrorMessage(null);
    const scopes = mcpScopeValues.filter((scope) => editingScopes.has(scope));
    try {
      await updateScopesMutation.mutateAsync({ tokenId, scopes });
      cancelEditScopes();
      await invalidateTokenLists();
    } catch (error: unknown) {
      captureException(error, { context: "update-mcp-token-scopes" });
      setErrorMessage(userFacingErrorMessage(error, "Failed to update MCP token scopes."));
    }
  };

  const createToken = async () => {
    setErrorMessage(null);
    setCopyStatus(null);
    const scopes = mcpScopeValues.filter((scope) => selectedScopes.has(scope));
    try {
      const result = await createTokenMutation.mutateAsync({
        name: name.trim(),
        scopes,
        expiresAt: expiresAt ? `${expiresAt}T23:59:59.999Z` : null,
      });
      setCreatedToken(result.token);
      await invalidateTokenLists();
    } catch (error: unknown) {
      captureException(error, { context: "create-mcp-token" });
      setErrorMessage(userFacingErrorMessage(error, "Failed to create MCP token."));
    }
  };

  const copyToken = async () => {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(createdToken);
      setCopyStatus("Copied");
    } catch (error: unknown) {
      captureException(error, { context: "copy-mcp-token" });
      setCopyStatus("Copy failed. Select the token and copy it manually.");
    }
  };

  const revokeToken = async (tokenId: string) => {
    setErrorMessage(null);
    try {
      await revokeTokenMutation.mutateAsync({ tokenId });
      setConnectedAppCursors([undefined]);
      await invalidateTokenLists();
    } catch (error: unknown) {
      captureException(error, { context: "revoke-mcp-token" });
      setErrorMessage(userFacingErrorMessage(error, "Failed to revoke MCP token."));
    }
  };

  const rotateToken = async (token: NonNullable<typeof personalTokensQuery.data>[number]) => {
    setErrorMessage(null);
    setCopyStatus(null);
    let createdReplacement = false;
    try {
      const result = await createTokenMutation.mutateAsync({
        name: token.name,
        scopes: token.scopes,
        expiresAt: token.expiresAt ? new Date(token.expiresAt).toISOString() : null,
      });
      createdReplacement = true;
      setCreatedToken(result.token);
      await revokeTokenMutation.mutateAsync({ tokenId: token.id });
    } catch (error: unknown) {
      captureException(error, { context: "rotate-mcp-token" });
      if (createdReplacement) {
        setErrorMessage(
          "New token created, but failed to revoke the old token. Revoke the old token manually.",
        );
      } else {
        setErrorMessage(userFacingErrorMessage(error, "Failed to rotate MCP token."));
      }
    } finally {
      await invalidateTokenLists();
    }
  };

  if (personalTokensQuery.isLoading || connectedAppsQuery.isLoading) {
    return <QueryStatePanel variant="loading" message="Loading MCP tokens..." height={96} />;
  }

  if (personalTokensQuery.error || connectedAppsQuery.error) {
    return (
      <QueryStatePanel
        error={personalTokensQuery.error ?? connectedAppsQuery.error}
        contextLabel="MCP tokens"
        height={96}
      />
    );
  }

  return (
    <div className="space-y-5">
      {isSecureOrigin === true ? <McpClientSetupPanel endpoint={mcpEndpoint} /> : null}

      {isSecureOrigin === true ? (
        <div className="space-y-3 rounded-md border border-border bg-surface-solid p-3">
          <div>
            <p className="text-sm font-medium text-foreground">Connect with a manual token</p>
            <p className="mt-1 text-sm text-subtle">
              For clients that support custom HTTP headers, such as Codex. Create a token below,
              then configure your client.
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium text-subtle">Client settings JSON</p>
            <pre className="overflow-x-auto rounded bg-surface p-3 text-xs text-foreground">
              <code>{`{
  "mcpServers": {
    "dofek": {
      "url": "${mcpEndpoint}",
      "headers": {
        "Authorization": "Bearer ${tokenForInstall}"
      }
    }
  }
}`}</code>
            </pre>
          </div>
          <p className="text-xs text-dim">
            Some clients call this screen Settings, MCP Servers, or Connectors.
          </p>
        </div>
      ) : null}

      {oauthTokens.length > 0 ? (
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-medium text-foreground">Connected apps</h2>
            <p className="mt-1 text-sm text-subtle">
              OAuth clients manage their own access tokens. Revoke access here to disconnect the
              client.
            </p>
          </div>
          <ul className="space-y-2">
            {oauthTokens.map((token) => {
              const isRevoked = token.revokedAt !== null;
              const isExpired = token.expiresAt !== null && new Date(token.expiresAt) <= new Date();
              return (
                <li
                  key={token.id}
                  className="flex flex-col gap-3 rounded bg-surface-hover px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-foreground">{token.name}</p>
                      {isRevoked ? (
                        <span className="rounded border border-red-900/40 px-2 py-0.5 text-xs text-red-500">
                          Revoked
                        </span>
                      ) : null}
                      {isExpired ? (
                        <span className="rounded border border-amber-900/40 px-2 py-0.5 text-xs text-amber-500">
                          Expired
                        </span>
                      ) : null}
                    </div>
                    <p className="text-xs text-subtle">
                      Connected {formatTimestamp(token.createdAt)} · Last used{" "}
                      {formatTimestamp(token.lastUsedAt)} · Access expires{" "}
                      {formatTimestamp(token.expiresAt)}
                    </p>
                    <p className="mt-1 text-xs text-dim">{token.scopes.join(", ")}</p>
                  </div>
                  {!isRevoked ? (
                    <div className="flex flex-wrap gap-2 self-start sm:self-center">
                      <button
                        type="button"
                        onClick={() => revokeToken(token.id)}
                        disabled={tokenMutationPending}
                        aria-label={`Revoke access for ${token.name}`}
                        className="rounded border border-red-900/40 px-3 py-1.5 text-xs text-red-500 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Revoke access
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {connectedAppCursors.length > 1 || connectedAppsQuery.data?.nextCursor ? (
            <div className="flex items-center justify-between border-t border-border pt-3">
              <button
                type="button"
                onClick={() => setConnectedAppCursors((cursors) => cursors.slice(0, -1))}
                disabled={connectedAppCursors.length === 1}
                aria-label="Previous connected apps page"
                className="rounded border border-border-strong px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                Previous
              </button>
              <span className="text-xs text-subtle">Page {connectedAppCursors.length}</span>
              <button
                type="button"
                onClick={() => {
                  const nextCursor = connectedAppsQuery.data?.nextCursor;
                  if (nextCursor) setConnectedAppCursors((cursors) => [...cursors, nextCursor]);
                }}
                disabled={!connectedAppsQuery.data?.nextCursor}
                aria-label="Next connected apps page"
                className="rounded border border-border-strong px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                Next
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      <h2 className="text-sm font-medium text-foreground">Personal tokens</h2>
      <div className="space-y-3 rounded-md border border-border bg-surface-solid p-3">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_11rem]">
          <label className="space-y-1">
            <span className="text-xs font-medium text-subtle">Token name</span>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-full rounded border border-border-strong bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium text-subtle">Expires</span>
            <input
              type="date"
              aria-label="Expires"
              value={expiresAt ?? ""}
              onChange={(event) => setExpiresAt(event.target.value || null)}
              className="w-full rounded border border-border-strong bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
            />
            <span className="block text-xs text-dim">Leave blank for no expiration.</span>
          </label>
        </div>

        <div className="space-y-2">
          <div className="text-xs font-medium text-subtle">Scopes</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {mcpScopeOptions.map((option) => (
              <label
                key={option.value}
                className="flex items-center gap-2 rounded border border-border bg-surface/70 px-3 py-2 text-sm text-foreground"
              >
                <input
                  type="checkbox"
                  checked={selectedScopes.has(option.value)}
                  disabled={
                    option.value === "nutrition:read" && selectedScopes.has("nutrition:write")
                  }
                  onChange={() => toggleScope(option.value)}
                  className="h-4 w-4 accent-accent"
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </div>

        <button
          type="button"
          disabled={!canCreate}
          onClick={createToken}
          className="rounded bg-accent px-3 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {createTokenMutation.isPending ? "Creating..." : "Create Token"}
        </button>
      </div>

      {createdToken ? (
        <div className="space-y-2 rounded-md border border-accent/40 bg-accent/10 p-3">
          <p className="text-sm font-medium text-foreground">
            Save this token now. It will not be shown again.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              readOnly
              value={createdToken}
              className="min-w-0 flex-1 rounded border border-border-strong bg-surface px-3 py-2 font-mono text-xs text-foreground"
            />
            <button
              type="button"
              onClick={copyToken}
              className="rounded border border-border-strong px-3 py-2 text-sm text-foreground transition-colors hover:bg-surface-hover"
            >
              Copy
            </button>
          </div>
          {copyStatus ? <p className="text-xs text-subtle">{copyStatus}</p> : null}
        </div>
      ) : null}

      {errorMessage ? (
        <p className="text-sm text-red-400">
          {userFacingErrorMessage(
            errorMessage,
            "The token action could not be completed. Please try again.",
          )}
        </p>
      ) : null}

      <div className="space-y-2">
        {personalTokens.length === 0 ? (
          <QueryStatePanel variant="empty" message="No personal tokens yet." height={96} />
        ) : (
          <ul className="space-y-2">
            {personalTokens.map((token) => {
              const isRevoked = token.revokedAt !== null;
              const isExpired = token.expiresAt !== null && new Date(token.expiresAt) <= new Date();
              const isActive = !isRevoked && !isExpired;
              return (
                <li
                  key={token.id}
                  className="flex flex-col gap-3 rounded bg-surface-hover px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-foreground">{token.name}</p>
                      {isRevoked ? (
                        <span className="rounded border border-red-900/40 px-2 py-0.5 text-xs text-red-500">
                          Revoked
                        </span>
                      ) : null}
                      {isExpired ? (
                        <span className="rounded border border-amber-900/40 px-2 py-0.5 text-xs text-amber-500">
                          Expired
                        </span>
                      ) : null}
                    </div>
                    <p className="text-xs text-subtle">
                      Created {formatTimestamp(token.createdAt)} · Last used{" "}
                      {formatTimestamp(token.lastUsedAt)} · Expires{" "}
                      {formatTimestamp(token.expiresAt)}
                    </p>
                    <p className="mt-1 text-xs text-dim">{token.scopes.join(", ")}</p>
                    {editingTokenId === token.id ? (
                      <div className="mt-3 space-y-2">
                        <div className="grid gap-2 sm:grid-cols-2">
                          {mcpScopeOptions.map((option) => (
                            <label
                              key={option.value}
                              className="flex items-center gap-2 rounded border border-border bg-surface/70 px-3 py-2 text-sm text-foreground"
                            >
                              <input
                                type="checkbox"
                                checked={editingScopes.has(option.value)}
                                disabled={
                                  option.value === "nutrition:read" &&
                                  editingScopes.has("nutrition:write")
                                }
                                onChange={() =>
                                  setEditingScopes((current) =>
                                    toggleScopeSet(current, option.value),
                                  )
                                }
                                className="h-4 w-4 accent-accent"
                              />
                              <span>{option.label}</span>
                            </label>
                          ))}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => saveScopes(token.id)}
                            disabled={tokenMutationPending || editingScopes.size === 0}
                            aria-label={`Save scopes for ${token.name}`}
                            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-on-accent transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Save scopes
                          </button>
                          <button
                            type="button"
                            onClick={cancelEditScopes}
                            disabled={tokenMutationPending}
                            className="rounded border border-border-strong px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                  {isActive ? (
                    <div className="flex flex-wrap gap-2 self-start sm:self-center">
                      <button
                        type="button"
                        onClick={() => beginEditScopes(token)}
                        disabled={tokenMutationPending}
                        aria-label={`Edit scopes for ${token.name}`}
                        className="rounded border border-border-strong px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Edit scopes
                      </button>
                      <button
                        type="button"
                        onClick={() => rotateToken(token)}
                        disabled={tokenMutationPending}
                        aria-label={`Rotate ${token.name}`}
                        className="rounded border border-border-strong px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Rotate
                      </button>
                      <button
                        type="button"
                        onClick={() => revokeToken(token.id)}
                        disabled={tokenMutationPending}
                        aria-label={`Revoke ${token.name}`}
                        className="rounded border border-red-900/40 px-3 py-1.5 text-xs text-red-500 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Revoke
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
