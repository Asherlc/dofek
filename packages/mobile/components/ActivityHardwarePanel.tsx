import {
  type ActivityHardware,
  type ActivityHardwareItem,
  activityHardwareDetailsLabel,
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
function HardwareItem({ item }: { item: ActivityHardwareItem }) {
  const [expanded, setExpanded] = useState(false);
  const detailsLabel = activityHardwareDetailsLabel(item.role);
  return (
    <View style={styles.item}>
      <Text style={styles.name}>{item.label}</Text>
      <Text style={styles.secondary}>
        {activityHardwareRoleLabels[item.role]} · {providerLabel(item.providerId)}
        {item.sourceName ? ` · ${item.sourceName}` : ""}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${detailsLabel} for ${item.label}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={styles.disclosure}
      >
        <Text style={styles.secondary}>
          {expanded ? `Hide ${detailsLabel.toLowerCase()}` : detailsLabel}
        </Text>
      </Pressable>
      {expanded ? (
        <View style={styles.item}>
          <Text style={styles.secondary}>{item.evidence}</Text>
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
  );
}
export function ActivityHardwarePanel({ data, loading = false, error, onRetry }: Props) {
  return (
    <View style={styles.panel}>
      <Text accessibilityRole="header" style={styles.title}>
        Devices and sensors
      </Text>
      {error ? (
        <QueryStatePanel
          variant="error"
          message={getQueryErrorMessage(error)}
          onRetry={onRetry}
          minHeight={72}
        />
      ) : null}
      {!data && loading && !error ? <QueryStatePanel variant="loading" minHeight={72} /> : null}
      {data?.items.map((item) => (
        <HardwareItem key={item.id} item={item} />
      ))}
      {data?.power.map((power) => (
        <Text key={power.activityId} style={styles.secondary}>
          {power.label}
        </Text>
      ))}
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
  item: { gap: spacing.xs },
  title: { color: colors.text, fontSize: 16, fontWeight: "600" },
  name: { color: colors.text, fontSize: 14, fontWeight: "500" },
  secondary: { color: colors.textSecondary, fontSize: 12 },
  disclosure: { minHeight: 44, justifyContent: "center" },
});
