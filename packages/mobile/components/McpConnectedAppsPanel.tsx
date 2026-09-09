import { formatDateTime } from "@dofek/format/format";
import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { colors, fontSize, fontWeight, radius, spacing } from "../theme";
import { getQueryErrorMessage, QueryStatePanel } from "./QueryStatePanel";

function formatTokenDate(value: string | null): string {
  return value ? formatDateTime(value) : "—";
}

export function McpConnectedAppsPanel() {
  const trpcUtils = trpc.useUtils();
  const tokens = trpc.mcp.listTokens.useQuery();
  const revokeTokenMutation = trpc.mcp.revokeToken.useMutation();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const oauthTokens = (tokens.data ?? []).filter((token) => token.oauthClientId != null);

  const revokeAccess = async (tokenId: string): Promise<void> => {
    setErrorMessage(null);
    try {
      await revokeTokenMutation.mutateAsync({ tokenId });
      await trpcUtils.mcp.listTokens.invalidate();
    } catch (error: unknown) {
      captureException(error, { source: "mcp-connected-app-revoke" });
      setErrorMessage(getQueryErrorMessage(error, "Could not revoke access. Try again."));
    }
  };

  if (tokens.isLoading && tokens.data === undefined) {
    return <QueryStatePanel variant="loading" />;
  }
  if (tokens.error && tokens.data === undefined) {
    return (
      <QueryStatePanel
        variant="error"
        message={getQueryErrorMessage(tokens.error, "Could not load connected apps.")}
      />
    );
  }
  if (oauthTokens.length === 0) return null;

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>Connected apps</Text>
      <Text style={styles.description}>
        OAuth clients manage their own access tokens. Revoke access here to disconnect the client.
      </Text>
      {errorMessage ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {errorMessage}
        </Text>
      ) : null}
      <View style={styles.list}>
        {oauthTokens.map((token) => {
          const isRevoked = token.revokedAt !== null;
          const isExpired = token.expiresAt !== null && new Date(token.expiresAt) <= new Date();
          return (
            <View key={token.id} style={styles.tokenCard}>
              <View style={styles.tokenHeader}>
                <Text style={styles.tokenName}>{token.name}</Text>
                <View style={styles.badges}>
                  {isRevoked ? <Text style={styles.revoked}>Revoked</Text> : null}
                  {isExpired ? <Text style={styles.expired}>Expired</Text> : null}
                </View>
              </View>
              <Text style={styles.meta}>
                Connected {formatTokenDate(token.createdAt)} · Last used{" "}
                {formatTokenDate(token.lastUsedAt)}
              </Text>
              <Text style={styles.meta}>Access expires {formatTokenDate(token.expiresAt)}</Text>
              <Text style={styles.scopes}>{token.scopes.join(", ")}</Text>
              {!isRevoked ? (
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={`Revoke access for ${token.name}`}
                  accessibilityState={{ disabled: revokeTokenMutation.isPending }}
                  disabled={revokeTokenMutation.isPending}
                  onPress={() => void revokeAccess(token.id)}
                  style={styles.revokeButton}
                >
                  <Text style={styles.revokeButtonText}>Revoke access</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  badges: { flexDirection: "row", gap: spacing.xs },
  description: { color: colors.textSecondary, fontSize: fontSize.sm },
  error: { color: colors.danger, fontSize: fontSize.sm },
  expired: {
    color: colors.warning,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
  list: { gap: spacing.sm },
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
