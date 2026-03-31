import * as WebBrowser from "expo-web-browser";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useAuth } from "../lib/auth-context";
import { SERVER_URL } from "../lib/server";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";

export function SlackIntegrationPanel() {
  const { data, isLoading, refetch } = trpc.settings.slackStatus.useQuery();
  const { sessionToken } = useAuth();

  async function handleConnect() {
    const url = new URL(`${SERVER_URL}/auth/provider/slack`);
    if (sessionToken) url.searchParams.set("session", sessionToken);
    await WebBrowser.openBrowserAsync(url.toString(), {
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
    });
    refetch();
  }

  if (isLoading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator color={colors.accent} size="small" />
        <Text style={styles.loadingText}>Checking Slack status...</Text>
      </View>
    );
  }

  if (!data?.configured) {
    return (
      <View style={styles.container}>
        <Text style={styles.dimText}>Slack integration is not configured on this server.</Text>
      </View>
    );
  }

  if (data.connected) {
    return (
      <View style={styles.container}>
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
      <View style={styles.connectRow}>
        <View style={styles.connectInfo}>
          <Text style={styles.label}>Log food via Slack</Text>
          <Text style={styles.dimText}>Add the bot to your workspace, then DM it what you ate</Text>
        </View>
        <TouchableOpacity style={styles.connectButton} onPress={handleConnect} activeOpacity={0.7}>
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
