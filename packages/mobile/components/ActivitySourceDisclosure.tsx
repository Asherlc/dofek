import type {
  ActivitySourceTree,
  ActivitySourceTreeNode,
} from "@dofek/providers/activity-source-tree";
import { useId, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { SERVER_URL } from "../lib/server";
import { captureException } from "../lib/telemetry";
import { colors, spacing } from "../theme";
import { ProviderLogo } from "./ProviderLogo";

function SourceLink({ node }: { node: ActivitySourceTreeNode }) {
  const [error, setError] = useState<string | null>(null);
  const url = node.url;
  if (!url) return null;
  return (
    <View>
      <Pressable
        style={styles.link}
        accessibilityRole="button"
        accessibilityLabel={`Open ${node.label} source`}
        onPress={async () => {
          setError(null);
          try {
            await Linking.openURL(url);
          } catch (error) {
            captureException(error);
            setError(error instanceof Error ? error.message : "Unable to open source link.");
          }
        }}
      >
        <Text style={styles.linkLabel}>View source ↗</Text>
      </Pressable>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function SourceNode({ node }: { node: ActivitySourceTreeNode }) {
  return (
    <View>
      <View style={styles.nodeRow}>
        <ProviderLogo
          provider={node.providerId}
          sourceName={node.sourceName}
          serverUrl={SERVER_URL}
          size={20}
        />
        <View style={styles.nodeContent}>
          <Text style={styles.label}>{node.label}</Text>
          {node.description ? <Text style={styles.description}>{node.description}</Text> : null}
          <SourceLink node={node} />
        </View>
      </View>
      <SourceBranches nodes={node.children} />
    </View>
  );
}

function SourceBranches({ nodes }: { nodes: ActivitySourceTreeNode[] }) {
  return nodes.map((node) => (
    <View key={node.id} style={styles.branch}>
      <View style={styles.connector} accessibilityElementsHidden importantForAccessibility="no" />
      <SourceNode node={node} />
    </View>
  ));
}

export function ActivitySourceDisclosure({ tree }: { tree: ActivitySourceTree }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const primary = tree.primary;
  return (
    <View style={styles.container}>
      <Pressable
        style={styles.trigger}
        accessibilityRole="button"
        accessibilityLabel={primary ? `Sources: ${primary.label}` : "Sources"}
        accessibilityHint={open ? "Hide activity sources" : "Show activity sources"}
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        aria-controls={contentId}
        onPress={() => setOpen((expanded) => !expanded)}
      >
        {primary ? (
          <View style={styles.primary}>
            <ProviderLogo
              provider={primary.providerId}
              sourceName={primary.sourceName}
              serverUrl={SERVER_URL}
              size={20}
            />
            <Text style={styles.label}>{primary.label}</Text>
          </View>
        ) : null}
        <View style={styles.sourceControl}>
          <Text style={styles.controlLabel}>Sources</Text>
          <Text style={styles.chevron} accessibilityElementsHidden importantForAccessibility="no">
            {open ? "⌃" : "⌄"}
          </Text>
        </View>
      </Pressable>
      {open ? (
        <View id={contentId} style={styles.details}>
          {primary ? (
            <View>
              {primary.description ? (
                <Text style={styles.description}>{primary.description}</Text>
              ) : null}
              <SourceLink node={primary} />
              <SourceBranches nodes={primary.children} />
            </View>
          ) : null}
          {tree.otherSources.length > 0 ? (
            <View style={styles.otherSources}>
              <Text style={styles.otherHeading}>Other matching sources</Text>
              {tree.otherSources.map((node) => (
                <SourceNode key={node.id} node={node} />
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: 1,
    borderTopColor: colors.surfaceSecondary,
    backgroundColor: colors.surface,
  },
  trigger: {
    minHeight: 44,
    minWidth: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  primary: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexShrink: 1 },
  sourceControl: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginLeft: "auto",
  },
  controlLabel: { color: colors.textSecondary, fontSize: 12 },
  chevron: { color: colors.textSecondary, fontSize: 16 },
  label: { color: colors.text, fontSize: 13, fontWeight: "600", flexShrink: 1 },
  details: { paddingHorizontal: spacing.md, paddingBottom: spacing.md },
  description: { color: colors.textSecondary, fontSize: 12, lineHeight: 18 },
  nodeRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  nodeContent: { flex: 1, minWidth: 0, gap: 2 },
  branch: {
    marginLeft: 9,
    borderLeftWidth: 1,
    borderLeftColor: colors.textTertiary,
    paddingLeft: 18,
    paddingTop: spacing.sm,
  },
  connector: {
    position: "absolute",
    left: 0,
    top: 18,
    width: 14,
    borderTopWidth: 1,
    borderTopColor: colors.textTertiary,
  },
  otherSources: { gap: spacing.sm, marginTop: spacing.md },
  otherHeading: { color: colors.textSecondary, fontSize: 12, fontWeight: "600" },
  link: { minHeight: 44, minWidth: 44, justifyContent: "center", alignSelf: "flex-start" },
  linkLabel: { color: colors.accent, fontSize: 12 },
  error: { color: colors.danger, fontSize: 12 },
});
