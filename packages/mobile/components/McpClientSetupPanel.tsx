import {
  buildClaudeConnectorUrl,
  buildCursorInstallUrl,
  buildMcpClientInstructions,
  buildVsCodeInstallUrl,
} from "@dofek/mcp-contracts/client-setup";
import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { openExternalUrl } from "../lib/open-external-url";
import { captureException } from "../lib/telemetry";
import { colors, fontSize, fontWeight, radius, spacing } from "../theme";

type SetupMessage = { kind: "error" | "success"; text: string } | null;

export function McpClientSetupPanel({ endpoint }: { endpoint: string }) {
  const [showOtherClients, setShowOtherClients] = useState(false);
  const [message, setMessage] = useState<SetupMessage>(null);
  const instructions = buildMcpClientInstructions(endpoint);

  async function copy(
    value: string,
    client: string,
    successText: string,
    fallbackTarget: "MCP URL" | "setup text",
  ): Promise<void> {
    setMessage(null);
    try {
      await Clipboard.setStringAsync(value);
      setMessage({ kind: "success", text: successText });
    } catch (error: unknown) {
      captureException(error, { source: "mcp-client-setup-copy", client });
      setMessage({
        kind: "error",
        text: `Copy failed. Select the ${fallbackTarget} and copy it manually.`,
      });
    }
  }

  async function open(url: string, client: string): Promise<void> {
    setMessage(null);
    const opened = await openExternalUrl(url, `mcp-client-setup-${client.toLowerCase()}`);
    if (!opened) {
      setMessage({
        kind: "error",
        text: `Could not open ${client}. Copy the MCP URL and finish setup on your computer.`,
      });
    }
  }

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>Connect an AI client</Text>
      <Text style={styles.description}>
        Review the connection, then sign in to Dofek when prompted.
      </Text>
      <Text style={styles.label}>Remote MCP URL</Text>
      <Text selectable style={styles.endpoint}>
        {endpoint}
      </Text>
      <View style={styles.actionGrid}>
        <SetupButton
          label="Connect Claude"
          onPress={() => void open(buildClaudeConnectorUrl(endpoint), "Claude")}
        />
        <SetupButton
          label="Copy for ChatGPT"
          onPress={() =>
            void copy(
              endpoint,
              "ChatGPT",
              "Copied. In ChatGPT desktop, open Settings → MCP servers → Add server, then paste the URL.",
              "MCP URL",
            )
          }
        />
        <SetupButton
          label="Add to Cursor"
          onPress={() => void open(buildCursorInstallUrl(endpoint), "Cursor")}
        />
        <SetupButton
          label="Add to VS Code"
          onPress={() => void open(buildVsCodeInstallUrl(endpoint), "VS Code")}
        />
      </View>
      <Text style={styles.note}>Use the Cursor and VS Code actions on a computer.</Text>
      {message ? (
        <Text
          accessibilityRole={message.kind === "error" ? "alert" : undefined}
          accessibilityLiveRegion="polite"
          style={message.kind === "error" ? styles.error : styles.status}
        >
          {message.text}
        </Text>
      ) : null}
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Other MCP clients"
        accessibilityState={{ expanded: showOtherClients }}
        onPress={() => setShowOtherClients((visible) => !visible)}
        style={styles.otherClientsButton}
      >
        <Text style={styles.otherClientsButtonText}>Other MCP clients</Text>
        <Text style={styles.chevron}>{showOtherClients ? "⌃" : "⌄"}</Text>
      </TouchableOpacity>
      {showOtherClients ? (
        <View style={styles.instructions}>
          {instructions.map((client) => (
            <View key={client.id} style={styles.instruction}>
              <View style={styles.instructionHeader}>
                <Text style={styles.label}>{client.name}</Text>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={`Copy ${client.name} setup`}
                  onPress={() =>
                    void copy(
                      client.instruction,
                      client.name,
                      `${client.name} setup copied.`,
                      "setup text",
                    )
                  }
                  style={styles.copyButton}
                >
                  <Text style={styles.copyButtonText}>Copy</Text>
                </TouchableOpacity>
              </View>
              <Text selectable style={styles.instructionText}>
                {client.instruction}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function SetupButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.actionButton}
    >
      <Text style={styles.actionButtonText}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  actionButton: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    flexBasis: "48%",
    flexGrow: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  actionButtonText: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  actionGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chevron: { color: colors.textSecondary, fontSize: fontSize.lg },
  copyButton: {
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  copyButtonText: { color: colors.text, fontSize: fontSize.xs },
  description: { color: colors.textSecondary, fontSize: fontSize.sm },
  endpoint: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    color: colors.text,
    fontFamily: "monospace",
    fontSize: fontSize.xs,
    padding: spacing.sm,
  },
  error: { color: colors.danger, fontSize: fontSize.sm },
  instruction: { gap: spacing.xs },
  instructionHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  instructionText: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    color: colors.text,
    fontFamily: "monospace",
    fontSize: fontSize.xs,
    padding: spacing.sm,
  },
  instructions: { gap: spacing.md },
  label: { color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: fontWeight.semibold },
  note: { color: colors.textSecondary, fontSize: fontSize.xs },
  otherClientsButton: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-between",
    padding: spacing.sm,
  },
  otherClientsButtonText: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  panel: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    padding: spacing.md,
  },
  status: { color: colors.textSecondary, fontSize: fontSize.sm },
  title: { color: colors.text, fontSize: fontSize.lg, fontWeight: fontWeight.bold },
});
