import {
  formatDateShort,
  formatDurationSeconds,
  formatIntensity,
  formatNumber,
} from "@dofek/format/format";
import { TRAINING_TERMINOLOGY } from "@dofek/training/terminology";
import type {
  PolarizationTrendResult,
  TrainingHrZonesResult,
  TrainingMonotonyWeek,
} from "dofek-server/types";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";
import { TrainingMethodDetails } from "./TrainingMethodDetails";

interface TrainingDistributionCardsProps {
  intensityDistribution: TrainingHrZonesResult["intensityDistribution"] | null;
  polarization: PolarizationTrendResult | null;
  monotony: TrainingMonotonyWeek[] | null;
}

export function TrainingDistributionCards({
  intensityDistribution,
  polarization,
  monotony,
}: TrainingDistributionCardsProps) {
  const latestPolarizationWeek = polarization?.weeks.at(-1) ?? null;
  const latestMonotonyWeek = monotony?.at(-1) ?? null;

  return (
    <>
      {intensityDistribution && intensityDistribution.totalSeconds > 0 ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            {TRAINING_TERMINOLOGY.intensityDistribution.plainLabel}
          </Text>
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
          <Text style={styles.explanation}>
            {TRAINING_TERMINOLOGY.intensityDistribution.plainDescription}
          </Text>
          <TrainingMethodDetails
            title={TRAINING_TERMINOLOGY.intensityDistribution.plainLabel}
            technicalName={TRAINING_TERMINOLOGY.intensityDistribution.technicalName}
            lines={[
              TRAINING_TERMINOLOGY.intensityDistribution.details,
              intensityDistribution.explanation,
            ]}
            sourceActionId="heart-rate-zone-model-source"
          />
        </View>
      ) : null}

      {polarization ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{TRAINING_TERMINOLOGY.polarization.plainLabel}</Text>
          {latestPolarizationWeek ? (
            <>
              <View style={styles.polarizationHeader}>
                <Text style={styles.status}>{latestPolarizationWeek.statusLabel}</Text>
                <Text style={styles.weekLabel}>
                  Week of {formatDateShort(latestPolarizationWeek.week)}
                </Text>
              </View>
              <Text style={styles.index}>
                {TRAINING_TERMINOLOGY.polarization.valueLabel}{" "}
                {latestPolarizationWeek.polarizationIndex === null
                  ? "—"
                  : formatNumber(latestPolarizationWeek.polarizationIndex, 3)}
              </Text>
              <Text style={styles.zoneSummary}>
                {formatIntensity(latestPolarizationWeek.zonePercentages.z1)} easy ·{" "}
                {formatIntensity(latestPolarizationWeek.zonePercentages.z2)} threshold ·{" "}
                {formatIntensity(latestPolarizationWeek.zonePercentages.z3)} high
              </Text>
              <Text style={styles.explanation}>
                {TRAINING_TERMINOLOGY.polarization.plainDescription}
              </Text>
            </>
          ) : (
            <Text style={styles.emptyText}>
              No {TRAINING_TERMINOLOGY.polarization.plainLabel.toLowerCase()} data in this period
            </Text>
          )}
          <TrainingMethodDetails
            title={TRAINING_TERMINOLOGY.polarization.plainLabel}
            technicalName={TRAINING_TERMINOLOGY.polarization.technicalName}
            lines={[
              TRAINING_TERMINOLOGY.polarization.details,
              ...(latestPolarizationWeek ? [latestPolarizationWeek.explanation] : []),
              polarization.method.formula,
              polarization.method.zoneBasis,
              polarization.method.calculationChoice,
              polarization.method.interpretation,
            ]}
            source={polarization.method.source}
            sourceActionId="polarization-source"
          />
        </View>
      ) : null}

      {monotony ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{TRAINING_TERMINOLOGY.monotony.plainLabel}</Text>
          {latestMonotonyWeek ? (
            <>
              <View style={styles.metricRow}>
                <Text style={styles.index}>
                  {TRAINING_TERMINOLOGY.monotony.valueLabel}{" "}
                  {formatNumber(latestMonotonyWeek.monotony, 2)}
                </Text>
                <Text style={styles.index}>
                  {TRAINING_TERMINOLOGY.monotony.strainLabel}{" "}
                  {formatNumber(latestMonotonyWeek.strain)}
                </Text>
              </View>
              <Text style={styles.zoneSummary}>
                Average daily load {formatNumber(latestMonotonyWeek.dailyMeanLoad, 2)} · daily
                variation {formatNumber(latestMonotonyWeek.dailyLoadStandardDeviation, 2)}
              </Text>
              <TrainingMethodDetails
                title={TRAINING_TERMINOLOGY.monotony.plainLabel}
                technicalName={TRAINING_TERMINOLOGY.monotony.technicalName}
                lines={[
                  TRAINING_TERMINOLOGY.monotony.details,
                  latestMonotonyWeek.method.formula,
                  latestMonotonyWeek.method.calendar,
                  latestMonotonyWeek.method.activityScope,
                  latestMonotonyWeek.method.interpretation,
                ]}
                source={latestMonotonyWeek.method.source}
                sourceActionId="training-monotony-source"
              />
            </>
          ) : (
            <Text style={styles.emptyText}>
              No {TRAINING_TERMINOLOGY.monotony.plainLabel.toLowerCase()} data in this period
            </Text>
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
  metricRow: {
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
