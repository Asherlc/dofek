import type { ActivityHardware } from "@dofek/providers/activity-hardware";
import { activitySourceTreeWithHardware } from "@dofek/providers/activity-source-hardware";
import {
  type ActivitySourceTree,
  type ActivitySourceTreeNode,
  activitySourceNodePresentation,
} from "@dofek/providers/activity-source-tree";
import { type ReactNode, useId, useState } from "react";
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SERVER_URL } from "../lib/server";
import { captureException } from "../lib/telemetry";
import { colors, spacing } from "../theme";
import { AttributionIcon } from "./activity/ActivityMetricSourcePicker";
import { ProviderLogo } from "./ProviderLogo";
import { getQueryErrorMessage, QueryStatePanel } from "./QueryStatePanel";

interface Props {
  tree: ActivitySourceTree;
  heading?: ReactNode;
  hardware?: ActivityHardware;
  hardwareLoading?: boolean;
  hardwareError?: unknown;
  onRetryHardware?: () => void;
}

function SourceLink({ node, children }: { node: ActivitySourceTreeNode; children: ReactNode }) {
  const [error, setError] = useState<string | null>(null);
  const url = node.url;
  if (!url) return <>{children}</>;
  return (
    <View>
      <Pressable
        style={styles.link}
        accessibilityRole="button"
        accessibilityLabel={`View activity for ${node.label}`}
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
        {children}
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
      <SourceLink node={node}>
        <View style={styles.nodeRow}>
          <ProviderLogo
            provider={node.providerId}
            sourceName={node.sourceName}
            serverUrl={SERVER_URL}
            size={20}
          />
          <View style={styles.nodeContent}>
            <SourceLabel node={node} />
          </View>
          {node.url ? (
            <Text style={styles.linkCue} accessibilityElementsHidden importantForAccessibility="no">
              ↗
            </Text>
          ) : null}
        </View>
      </SourceLink>
      {node.description ? <Text style={styles.description}>{node.description}</Text> : null}
      <SourceBranches nodes={node.children} />
    </View>
  );
}

function SourceBranches({ nodes }: { nodes: ActivitySourceTreeNode[] }) {
  return nodes.map((node) => (
    <View key={node.id} style={styles.branch}>
      <View style={styles.connector} accessibilityElementsHidden importantForAccessibility="no" />
      <Text style={styles.relationship}>Shared to</Text>
      <SourceNode node={node} />
    </View>
  ));
}

export function ActivitySourceDisclosure({
  tree,
  heading,
  hardware,
  hardwareLoading = false,
  hardwareError,
  onRetryHardware,
}: Props) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const sourceTree = hardware ? activitySourceTreeWithHardware(tree, hardware) : tree;
  const { primary, otherSources } = sourceTree;
  if (!primary && otherSources.length === 0 && !hardwareLoading && !hardwareError)
    return <>{heading}</>;

  const details = (
    <>
      {!hardware && hardwareLoading && !hardwareError ? (
        <QueryStatePanel variant="loading" minHeight={72} />
      ) : null}
      {primary ? (
        <View>
          <Text style={styles.sectionTitle} accessibilityRole="header">
            Original
          </Text>
          <SourceNode node={primary} />
        </View>
      ) : (
        <Text style={styles.sectionTitle} accessibilityRole="header">
          Original unknown
        </Text>
      )}
      {otherSources.length > 0 ? (
        <View style={[styles.otherSources, primary ? styles.divided : undefined]}>
          {primary ? (
            <Text style={styles.sectionTitle} accessibilityRole="header">
              Other
            </Text>
          ) : null}
          {otherSources.map((node) => (
            <SourceNode key={node.id} node={node} />
          ))}
        </View>
      ) : null}
    </>
  );

  return (
    <View style={heading ? styles.headerContainer : styles.container}>
      {heading ? <View style={styles.heading}>{heading}</View> : null}
      <Pressable
        style={[styles.trigger, heading ? styles.headerTrigger : undefined]}
        accessibilityRole="button"
        accessibilityLabel={primary ? `Lineage: ${primary.label}` : "Lineage"}
        accessibilityHint={open ? "Hide activity lineage" : "Show activity lineage"}
        accessibilityState={{ expanded: open }}
        aria-haspopup={heading ? "dialog" : undefined}
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
            <SourceLabel node={primary} />
          </View>
        ) : null}
        <View style={styles.sourceControl}>
          <Text style={styles.controlLabel}>Lineage</Text>
          <Text style={styles.chevron} accessibilityElementsHidden importantForAccessibility="no">
            {open ? "⌃" : "⌄"}
          </Text>
        </View>
      </Pressable>
      {hardwareError ? (
        <View style={styles.fullWidth}>
          <QueryStatePanel
            variant="error"
            title="Could not load device metadata"
            message={getQueryErrorMessage(hardwareError)}
            onRetry={onRetryHardware}
            minHeight={72}
          />
        </View>
      ) : null}
      {open ? (
        heading ? (
          <Modal visible transparent animationType="fade" onRequestClose={() => setOpen(false)}>
            <View style={styles.overlay}>
              <Pressable
                style={StyleSheet.absoluteFill}
                accessibilityRole="button"
                accessibilityLabel="Dismiss lineage"
                onPress={() => setOpen(false)}
              />
              <View
                id={contentId}
                style={styles.dialog}
                role="dialog"
                accessibilityLabel="Lineage"
                accessibilityViewIsModal
              >
                <View style={styles.dialogHeader}>
                  <Text style={styles.dialogTitle} accessibilityRole="header">
                    Lineage
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Close lineage"
                    onPress={() => setOpen(false)}
                    style={styles.closeButton}
                  >
                    <Text style={styles.controlLabel}>Close</Text>
                  </Pressable>
                </View>
                <ScrollView>{details}</ScrollView>
              </View>
            </View>
          </Modal>
        ) : (
          <View id={contentId} style={styles.details}>
            <Text style={styles.dialogTitle} accessibilityRole="header">
              Lineage
            </Text>
            {details}
          </View>
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "rgba(0,0,0,0.5)" },
  dialog: { maxHeight: "80%", backgroundColor: colors.surface, borderRadius: 16, padding: 16 },
  dialogHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  dialogTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
  closeButton: { minHeight: 44, minWidth: 44, justifyContent: "center", alignItems: "center" },
  headerContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  heading: { flexGrow: 1, flexBasis: 180, minWidth: 0 },
  headerTrigger: { maxWidth: "100%", paddingHorizontal: 0 },
  fullWidth: { width: "100%" },
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
    top: 15,
    width: 14,
    borderTopWidth: 1,
    borderTopColor: colors.textTertiary,
  },
  otherSources: { gap: spacing.sm, marginTop: spacing.md },
  linkCue: { color: colors.accent, fontSize: 14 },
  link: { minHeight: 44, minWidth: 44, justifyContent: "center", alignSelf: "flex-start" },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: spacing.sm,
  },
  relationship: { color: colors.accent, fontSize: 12, marginBottom: spacing.xs },
  divided: { borderTopWidth: 1, borderTopColor: colors.textTertiary, paddingTop: spacing.md },
  error: { color: colors.danger, fontSize: 12 },
});

function SourceLabel({ node }: { node: ActivitySourceTreeNode }) {
  const { displayName, attribution } = activitySourceNodePresentation(node);
  if (!attribution) return <Text style={styles.label}>{displayName}</Text>;
  return (
    <View style={styles.primary}>
      <Text style={styles.label} accessibilityLabel={node.label}>
        {displayName}
      </Text>
      <AttributionIcon attribution={attribution} serverUrl={SERVER_URL} />
    </View>
  );
}
