import { StyleSheet, Text, View } from "react-native";
import {
  type ProviderStats,
  providerStatsBreakdown,
  providerStatsTotal,
} from "@dofek/providers/provider-stats";
import { colors } from "../theme";

function StatBadge({ label, count }: { label: string; count: number }) {
  return (
    <View style={styles.statBadge}>
      <Text style={styles.statBadgeCount}>{count.toLocaleString()}</Text>
      <Text style={styles.statBadgeLabel}>{label}</Text>
    </View>
  );
}

/**
 * Compact variant: horizontal wrap of stat badges (used in provider cards).
 * Full variant: total header + grid of stat badges (used in detail pages).
 */
export function ProviderStatsBreakdown({
  stats,
  variant = "compact",
}: {
  stats: ProviderStats;
  variant?: "compact" | "full";
}) {
  const total = providerStatsTotal(stats);
  const breakdown = providerStatsBreakdown(stats);

  if (total === 0) return null;

  if (variant === "full") {
    return (
      <View style={styles.fullContainer}>
        <View style={styles.totalRow}>
          <Text style={styles.totalCount}>{total.toLocaleString()}</Text>
          <Text style={styles.totalLabel}>total records</Text>
        </View>
        <View style={styles.statsRow}>
          {breakdown.map((b) => (
            <StatBadge key={b.label} label={b.label} count={b.count} />
          ))}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.statsRow}>
      {breakdown.map((b) => (
        <StatBadge key={b.label} label={b.label} count={b.count} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fullContainer: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  totalRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 8,
  },
  totalCount: {
    fontSize: 24,
    fontWeight: "700",
    color: colors.text,
  },
  totalLabel: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  statsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  statBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.surfaceSecondary,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  statBadgeCount: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.text,
  },
  statBadgeLabel: {
    fontSize: 12,
    color: colors.textSecondary,
  },
});
