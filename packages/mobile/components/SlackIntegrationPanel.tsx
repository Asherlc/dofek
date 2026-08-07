import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { createProviderHandoffCode } from "../lib/auth";
import { useAuth } from "../lib/auth-context";
import { SERVER_URL } from "../lib/server";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";
import { getQueryErrorMessage, QueryStatePanel } from "./QueryStatePanel";

export function SlackIntegrationPanel() {
  const { data, error, isLoading, refetch } = trpc.settings.slackStatus.useQuery();
  const { sessionToken } = useAuth();
  const [isConnecting, setIsConnecting] = useState(false);

  async function handleConnect() {
    if (!sessionToken || isConnecting) return;
    setIsConnecting(true);
    try {
      const handoffCode = await createProviderHandoffCode(SERVER_URL, "slack", sessionToken);
      const url = new URL(`${SERVER_URL}/auth/provider/slack`);
      url.searchParams.set("code", handoffCode);
      await WebBrowser.openBrowserAsync(url.toString(), {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      });
      await refetch();
    } catch (error: unknown) {
      captureException(error, { context: "slack-provider-handoff" });
      Alert.alert(
        "Unable to connect Slack",
        error instanceof Error ? error.message : "Slack connection failed",
      );
    } finally {
      setIsConnecting(false);
    }
  }

  if (isLoading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator color={colors.accent} size="small" />
        <Text style={styles.loadingText}>Checking Slack status...</Text>
      </View>
    );
  }

  if (data === undefined) {
    return (
      <QueryStatePanel
        variant="error"
        title="Could not load Slack status"
        message={getQueryErrorMessage(error)}
        minHeight={96}
      />
    );
  }

  const refreshWarning = error ? (
    <QueryStatePanel
      variant="error"
      title="Could not refresh Slack status"
      message={getQueryErrorMessage(error)}
      minHeight={72}
    />
  ) : null;

  if (!data.configured) {
    return (
      <View style={styles.container}>
        {refreshWarning}
        <Text style={styles.dimText}>Slack integration is not configured on this server.</Text>
      </View>
    );
  }

  if (data.connected) {
    return (
      <View style={styles.container}>
        {refreshWarning}
        <View style={styles.row}>
          <View style={styles.connectedDot} />
          <View>
            <Text style={styles.label}>Connected</Text>
            <Text style={styles.dimText}>DM the bot in Slack to log what you ate</Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {refreshWarning}
      <View style={styles.connectRow}>
        <View style={styles.connectInfo}>
          <Text style={styles.label}>Log food via Slack</Text>
          <Text style={styles.dimText}>Add the bot to your workspace, then DM it what you ate</Text>
        </View>
        <TouchableOpacity
          style={styles.connectButton}
          onPress={handleConnect}
          activeOpacity={0.7}
          disabled={isConnecting}
          accessibilityRole="button"
          accessibilityLabel="Add to Slack"
          accessibilityState={{ busy: isConnecting, disabled: isConnecting }}
        >
          <Text style={styles.connectButtonText}>Add to Slack</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const SLACK_PURPLE = "#4A154B";

const styles = StyleSheet.create({
  container: {
    gap: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  connectedDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.positive,
  },
  label: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.text,
  },
  dimText: {
    fontSize: 13,
    color: colors.textTertiary,
  },
  loadingText: {
    fontSize: 13,
    color: colors.textTertiary,
  },
  connectRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  connectInfo: {
    flex: 1,
    marginRight: 12,
  },
  connectButton: {
    backgroundColor: SLACK_PURPLE,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  connectButtonText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
});
