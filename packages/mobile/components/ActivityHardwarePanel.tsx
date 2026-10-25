import {
  type ActivityHardware,
  activityHardwareRoleLabels,
} from "@dofek/providers/activity-hardware";
import { providerLabel } from "@dofek/providers/providers";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { trpc } from "../lib/trpc";
import { colors, radius, spacing } from "../theme";
import { getQueryErrorMessage, QueryStatePanel } from "./QueryStatePanel";

interface Props {
  data?: ActivityHardware;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
}
export function ActivityHardwareSection({ activityId }: { activityId: string }) {
  const hardware = trpc.activity.hardware.useQuery({ id: activityId }, { enabled: !!activityId });
  return (
    <ActivityHardwarePanel
      data={hardware.data}
      loading={hardware.isLoading}
      error={hardware.error}
      onRetry={() => void hardware.refetch()}
    />
  );
}
export function ActivityHardwarePanel({ data, loading = false, error, onRetry }: Props) {
  const [expanded, setExpanded] = useState(false);
  const hasHardware = data && (data.items.length > 0 || data.power.length > 0);
  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>
          Devices and sensors
        </Text>
        {hasHardware ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Device and sensor details"
            accessibilityState={{ expanded }}
            aria-expanded={expanded}
            onPress={() => setExpanded((value) => !value)}
            style={styles.disclosure}
          >
            <Text style={styles.secondary}>Details</Text>
            <Text style={styles.chevron} accessibilityElementsHidden importantForAccessibility="no">
              {expanded ? "⌃" : "⌄"}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {error ? (
        <QueryStatePanel
          variant="error"
          message={getQueryErrorMessage(error)}
          onRetry={onRetry}
          minHeight={72}
        />
      ) : null}
      {!data && loading && !error ? <QueryStatePanel variant="loading" minHeight={72} /> : null}
      {data?.items.map((item, index) => (
        <View key={item.id} style={[styles.item, index > 0 && styles.separator]}>
          <Text style={styles.name}>{item.label}</Text>
          <Text style={styles.secondary}>
            {activityHardwareRoleLabels[item.role]} · {providerLabel(item.providerId)}
          </Text>
          {expanded ? (
            <View style={styles.facts}>
              {item.sourceName &&
              item.sourceName !== item.label &&
              item.sourceName !== providerLabel(item.providerId) ? (
                <Text style={styles.secondary}>Source: {item.sourceName}</Text>
              ) : null}
              {item.manufacturer ? (
                <Text style={styles.secondary}>Manufacturer: {item.manufacturer}</Text>
              ) : null}
              {item.model && item.model !== item.label ? (
                <Text style={styles.secondary}>Model: {item.model}</Text>
              ) : null}
              {item.details.map((detail) => (
                <Text key={detail.label} style={styles.secondary}>
                  {detail.label}: {detail.value}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      ))}
      {expanded
        ? data?.power.map((power) => (
            <Text key={power.activityId} style={styles.secondary}>
              {power.label}
            </Text>
          ))
        : null}
      {data && data.items.length === 0 && data.power.length === 0 && !error ? (
        <QueryStatePanel variant="empty" message="No device metadata reported." minHeight={64} />
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  panel: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.md,
    gap: spacing.md,
  },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  item: { gap: spacing.xs },
  facts: { gap: spacing.xs, marginTop: spacing.xs },
  separator: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm },
  title: { color: colors.text, fontSize: 16, fontWeight: "600", flexShrink: 1 },
  name: { color: colors.text, fontSize: 14, fontWeight: "500" },
  secondary: { color: colors.textSecondary, fontSize: 12 },
  disclosure: {
    minHeight: 44,
    minWidth: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingLeft: spacing.sm,
  },
  chevron: { color: colors.textSecondary, fontSize: 16 },
});
