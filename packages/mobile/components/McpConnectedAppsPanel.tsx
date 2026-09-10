import { formatDateTime } from "@dofek/format/format";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { colors, fontSize, fontWeight, radius, spacing } from "../theme";
import { getQueryErrorMessage, QueryStatePanel } from "./QueryStatePanel";

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
              {app.isActive ? (
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={`Disconnect ${app.name}`}
                  accessibilityState={{ disabled: revokeConnectedAppMutation.isPending }}
                  disabled={revokeConnectedAppMutation.isPending}
                  onPress={() => void disconnectApp(app.oauthClientId, app.oauthResource)}
                  style={styles.revokeButton}
                >
                  <Text style={styles.revokeButtonText}>Disconnect</Text>
                </TouchableOpacity>
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
