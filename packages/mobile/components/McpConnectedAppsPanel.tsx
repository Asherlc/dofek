import { formatDateTime } from "@dofek/format/format";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { colors, fontSize, fontWeight, radius, spacing } from "../theme";
import { getQueryErrorMessage, QueryStatePanel } from "./QueryStatePanel";

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

function toggleScopeSet(current: Set<McpScope>, scope: McpScope): Set<McpScope> {
  const next = new Set(current);
  if (scope === "nutrition:write" && !next.has(scope)) {
    next.add("nutrition:read");
    next.add(scope);
    return next;
  }
  if (scope === "nutrition:read" && next.has("nutrition:write")) return next;
  if (next.has(scope)) next.delete(scope);
  else next.add(scope);
  return next;
}

function formatTokenDate(value: string | null): string {
  return value ? formatDateTime(value) : "—";
}

export function McpConnectedAppsPanel() {
  const trpcUtils = trpc.useUtils();
  const [connectedAppCursors, setConnectedAppCursors] = useState<Array<string | undefined>>([
    undefined,
  ]);
  const connectedAppsQuery = trpc.mcp.listConnectedApps.useQuery({
    cursor: connectedAppCursors.at(-1),
  });
  const revokeConnectedAppMutation = trpc.mcp.revokeConnectedApp.useMutation();
  const updateConnectedAppScopesMutation = trpc.mcp.updateConnectedAppScopes.useMutation();
  const [editingConnectedAppKey, setEditingConnectedAppKey] = useState<string | null>(null);
  const [editingScopes, setEditingScopes] = useState<Set<McpScope>>(() => new Set());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const oauthTokens = connectedAppsQuery.data?.items ?? [];

  const disconnectApp = async (oauthClientId: string, oauthResource: string): Promise<void> => {
    setErrorMessage(null);
    try {
      await revokeConnectedAppMutation.mutateAsync({ oauthClientId, oauthResource });
      setConnectedAppCursors([undefined]);
      await trpcUtils.mcp.listConnectedApps.invalidate();
    } catch (error: unknown) {
      captureException(error, { source: "mcp-connected-app-disconnect" });
      setErrorMessage(getQueryErrorMessage(error, "Could not disconnect the app. Try again."));
    }
  };

  const beginEditScopes = (app: (typeof oauthTokens)[number]): void => {
    setErrorMessage(null);
    setEditingConnectedAppKey(`${app.oauthClientId}:${app.oauthResource}`);
    const nextScopes = new Set<McpScope>(app.scopes);
    if (nextScopes.has("nutrition:write")) nextScopes.add("nutrition:read");
    setEditingScopes(nextScopes);
  };

  const cancelEditScopes = (): void => {
    setEditingConnectedAppKey(null);
    setEditingScopes(new Set());
  };

  const saveScopes = async (app: (typeof oauthTokens)[number]): Promise<void> => {
    setErrorMessage(null);
    try {
      await updateConnectedAppScopesMutation.mutateAsync({
        oauthClientId: app.oauthClientId,
        oauthResource: app.oauthResource,
        scopes: mcpScopeValues.filter((scope) => editingScopes.has(scope)),
      });
      cancelEditScopes();
      await trpcUtils.mcp.listConnectedApps.invalidate();
    } catch (error: unknown) {
      captureException(error, { source: "mcp-connected-app-scopes" });
      setErrorMessage(getQueryErrorMessage(error, "Could not update app scopes. Try again."));
    }
  };

  if (connectedAppsQuery.isLoading && connectedAppsQuery.data === undefined) {
    return <QueryStatePanel variant="loading" />;
  }
  if (connectedAppsQuery.error && connectedAppsQuery.data === undefined) {
    return (
      <QueryStatePanel
        variant="error"
        message={getQueryErrorMessage(connectedAppsQuery.error, "Could not load connected apps.")}
      />
    );
  }
  if (oauthTokens.length === 0 && connectedAppCursors.length === 1) return null;

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>Connected apps</Text>
      <Text style={styles.description}>
        Each app is shown once, even when it refreshes its access token. Disconnect it here to
        revoke all access.
      </Text>
      {errorMessage ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {errorMessage}
        </Text>
      ) : null}
      {connectedAppsQuery.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {getQueryErrorMessage(connectedAppsQuery.error, "Could not load connected apps.")}
        </Text>
      ) : null}
      <View style={styles.list}>
        {oauthTokens.map((app) => {
          return (
            <View key={`${app.oauthClientId}:${app.oauthResource}`} style={styles.tokenCard}>
              <View style={styles.tokenHeader}>
                <Text style={styles.tokenName}>{app.name}</Text>
                <View style={styles.badges}>
                  {!app.isActive ? <Text style={styles.revoked}>Disconnected</Text> : null}
                </View>
              </View>
              <Text style={styles.meta}>
                Connected {formatTokenDate(app.connectedAt)} · Last used{" "}
                {formatTokenDate(app.lastUsedAt)}
              </Text>
              <Text style={styles.scopes}>{app.scopes.join(", ")}</Text>
              {editingConnectedAppKey === `${app.oauthClientId}:${app.oauthResource}` ? (
                <View style={styles.scopeEditor}>
                  {mcpScopeOptions.map((option) => {
                    const checked = editingScopes.has(option.value);
                    const disabled =
                      option.value === "nutrition:read" && editingScopes.has("nutrition:write");
                    return (
                      <Pressable
                        key={option.value}
                        accessibilityRole="checkbox"
                        accessibilityLabel={option.label}
                        accessibilityState={{ checked, disabled }}
                        disabled={disabled}
                        onPress={() =>
                          setEditingScopes((current) => toggleScopeSet(current, option.value))
                        }
                        style={[styles.scopeRow, disabled ? styles.scopeRowDisabled : null]}
                      >
                        <Text style={styles.scopeCheckbox}>{checked ? "☑" : "☐"}</Text>
                        <Text style={styles.scopeLabel}>{option.label}</Text>
                      </Pressable>
                    );
                  })}
                  <View style={styles.scopeActions}>
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel={`Save scopes for ${app.name}`}
                      accessibilityState={{
                        disabled:
                          updateConnectedAppScopesMutation.isPending || editingScopes.size === 0,
                      }}
                      disabled={
                        updateConnectedAppScopesMutation.isPending || editingScopes.size === 0
                      }
                      onPress={() => void saveScopes(app)}
                      style={styles.saveButton}
                    >
                      <Text style={styles.saveButtonText}>Save scopes</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel="Cancel"
                      accessibilityState={{ disabled: updateConnectedAppScopesMutation.isPending }}
                      disabled={updateConnectedAppScopesMutation.isPending}
                      onPress={cancelEditScopes}
                      style={styles.cancelButton}
                    >
                      <Text style={styles.cancelButtonText}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : null}
              {app.isActive ? (
                <View style={styles.actions}>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={`Edit scopes for ${app.name}`}
                    accessibilityState={{
                      disabled:
                        revokeConnectedAppMutation.isPending ||
                        updateConnectedAppScopesMutation.isPending,
                    }}
                    disabled={
                      revokeConnectedAppMutation.isPending ||
                      updateConnectedAppScopesMutation.isPending
                    }
                    onPress={() => beginEditScopes(app)}
                    style={styles.editButton}
                  >
                    <Text style={styles.editButtonText}>Edit scopes</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={`Disconnect ${app.name}`}
                    accessibilityState={{
                      disabled:
                        revokeConnectedAppMutation.isPending ||
                        updateConnectedAppScopesMutation.isPending,
                    }}
                    disabled={
                      revokeConnectedAppMutation.isPending ||
                      updateConnectedAppScopesMutation.isPending
                    }
                    onPress={() => void disconnectApp(app.oauthClientId, app.oauthResource)}
                    style={styles.revokeButton}
                  >
                    <Text style={styles.revokeButtonText}>Disconnect</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>
          );
        })}
      </View>
      {connectedAppCursors.length > 1 || connectedAppsQuery.data?.nextCursor ? (
        <View style={styles.pagination}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Previous connected apps page"
            accessibilityState={{ disabled: connectedAppCursors.length === 1 }}
            disabled={connectedAppCursors.length === 1}
            onPress={() => setConnectedAppCursors((cursors) => cursors.slice(0, -1))}
            style={[
              styles.paginationButton,
              connectedAppCursors.length === 1 ? styles.paginationButtonDisabled : null,
            ]}
          >
            <Text style={styles.paginationButtonText}>Previous</Text>
          </Pressable>
          <Text style={styles.paginationStatus}>Page {connectedAppCursors.length}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Next connected apps page"
            accessibilityState={{ disabled: !connectedAppsQuery.data?.nextCursor }}
            disabled={!connectedAppsQuery.data?.nextCursor}
            onPress={() => {
              const nextCursor = connectedAppsQuery.data?.nextCursor;
              if (nextCursor) setConnectedAppCursors((cursors) => [...cursors, nextCursor]);
            }}
            style={[
              styles.paginationButton,
              !connectedAppsQuery.data?.nextCursor ? styles.paginationButtonDisabled : null,
            ]}
          >
            <Text style={styles.paginationButtonText}>Next</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  badges: { flexDirection: "row", gap: spacing.xs },
  actions: { flexDirection: "row", gap: spacing.sm },
  cancelButton: {
    borderColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  cancelButtonText: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
  description: { color: colors.textSecondary, fontSize: fontSize.sm },
  error: { color: colors.danger, fontSize: fontSize.sm },
  list: { gap: spacing.sm },
  pagination: {
    alignItems: "center",
    borderTopColor: colors.surfaceSecondary,
    borderTopWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: spacing.sm,
  },
  paginationButton: {
    borderColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  paginationButtonDisabled: { opacity: 0.35 },
  paginationButtonText: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
  paginationStatus: { color: colors.textSecondary, fontSize: fontSize.xs },
  meta: { color: colors.textSecondary, fontSize: fontSize.xs },
  panel: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    padding: spacing.md,
  },
  revoked: {
    color: colors.danger,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
  editButton: {
    borderColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  editButtonText: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
  revokeButton: {
    alignSelf: "flex-start",
    borderColor: colors.danger,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  revokeButtonText: {
    color: colors.danger,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
  scopes: { color: colors.textTertiary, fontSize: fontSize.xs },
  saveButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  saveButtonText: {
    color: colors.onAccent,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
  scopeActions: { flexDirection: "row", gap: spacing.sm },
  scopeCheckbox: { color: colors.textSecondary, fontSize: fontSize.base },
  scopeEditor: { gap: spacing.xs, marginTop: spacing.xs },
  scopeLabel: { color: colors.textSecondary, flex: 1, fontSize: fontSize.sm },
  scopeRow: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  scopeRowDisabled: { opacity: 0.5 },
  title: { color: colors.text, fontSize: fontSize.lg, fontWeight: fontWeight.bold },
  tokenCard: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.lg,
    gap: spacing.xs,
    padding: spacing.md,
  },
  tokenHeader: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  tokenName: {
    color: colors.text,
    flex: 1,
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
  },
});
