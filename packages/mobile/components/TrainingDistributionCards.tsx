import {
  formatDateShort,
  formatDurationSeconds,
  formatIntensity,
  formatNumber,
} from "@dofek/format/format";
import type { PolarizationTrendResult, TrainingHrZonesResult } from "dofek-server/types";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";

interface TrainingDistributionCardsProps {
  intensityDistribution: TrainingHrZonesResult["intensityDistribution"] | null;
  polarization: PolarizationTrendResult | null;
}

export function TrainingDistributionCards({
  intensityDistribution,
  polarization,
}: TrainingDistributionCardsProps) {
  const latestPolarizationWeek = polarization?.weeks.at(-1) ?? null;

  return (
    <>
      {intensityDistribution && intensityDistribution.totalSeconds > 0 ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Karvonen Intensity Distribution</Text>
          <View style={styles.zoneStack}>
            {intensityDistribution.zones
              .filter((zone) => zone.seconds > 0)
              .map((zone) => (
                <View key={zone.zone} style={styles.zoneRow}>
                  <Text style={styles.zoneLabel}>{zone.label}</Text>
                  <Text style={styles.zoneDuration}>{formatDurationSeconds(zone.seconds)}</Text>
                  <Text style={styles.zonePercent}>{formatIntensity(zone.percent)}</Text>
                </View>
              ))}
          </View>
          <Text style={styles.explanation}>{intensityDistribution.explanation}</Text>
        </View>
      ) : null}

      {polarization ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Cycling Polarization</Text>
          {latestPolarizationWeek ? (
            <>
              <View style={styles.polarizationHeader}>
                <Text style={styles.status}>{latestPolarizationWeek.statusLabel}</Text>
                <Text style={styles.weekLabel}>
                  Week of {formatDateShort(latestPolarizationWeek.week)}
                </Text>
              </View>
              <Text style={styles.index}>
                Index{" "}
                {latestPolarizationWeek.polarizationIndex === null
                  ? "—"
                  : formatNumber(latestPolarizationWeek.polarizationIndex, 3)}
              </Text>
              <Text style={styles.zoneSummary}>
                {formatIntensity(latestPolarizationWeek.zonePercentages.z1)} easy ·{" "}
                {formatIntensity(latestPolarizationWeek.zonePercentages.z2)} threshold ·{" "}
                {formatIntensity(latestPolarizationWeek.zonePercentages.z3)} high
              </Text>
              <Text style={styles.explanation}>{latestPolarizationWeek.explanation}</Text>
            </>
          ) : (
            <Text style={styles.emptyText}>No cycling polarization data in this period</Text>
          )}
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    gap: 12,
    padding: 16,
  },
  cardTitle: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  zoneStack: {
    gap: 8,
  },
  zoneRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  zoneLabel: {
    color: colors.text,
    flex: 1,
    fontSize: 13,
  },
  zoneDuration: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  zonePercent: {
    color: colors.text,
    fontSize: 13,
    fontVariant: ["tabular-nums"],
    fontWeight: "700",
    minWidth: 44,
    textAlign: "right",
  },
  polarizationHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  status: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "700",
  },
  weekLabel: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  index: {
    color: colors.text,
    fontSize: 14,
    fontVariant: ["tabular-nums"],
  },
  zoneSummary: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  explanation: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  emptyText: {
    color: colors.textTertiary,
    fontSize: 13,
    paddingVertical: 12,
    textAlign: "center",
  },
});
