import { rawLoadToStrain } from "@dofek/scoring/scoring";
import {
  collapseWeeklyVolumeActivityTypes,
  formatActivityTypeLabel,
  selectRecentDailyLoad,
} from "@dofek/training/training";
import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { ActivityCard } from "../../components/ActivityCard";
import { ChartTitleWithTooltip } from "../../components/ChartTitleWithTooltip";
import { DaySelector } from "../../components/DaySelector";
import { StrainGauge } from "../../components/charts/StrainGauge";
import { SparkLine } from "../../components/charts/SparkLine";
import { aggregateWeeklyVolume, workloadRatioColor, workloadRatioHint } from "../../lib/scoring";
import type { WeekSummary } from "../../lib/scoring";
import { trpc } from "../../lib/trpc";
import { useUnitSystem } from "../../lib/units";
import type { ActivityRow, WorkloadRow } from "../../types/api";
import { ActivityRowSchema, WeeklyVolumeRowSchema } from "../../types/api";
import { colors } from "../../theme";

export default function StrainScreen() {
  const [days, setDays] = useState(30);
  const unitSystem = useUnitSystem();
  const workloadQuery = trpc.recovery.workloadRatio.useQuery({ days });
  const workloadData = workloadQuery.data ?? [];
  const todayWorkload = workloadData[workloadData.length - 1];
  const displayedWorkload = selectRecentDailyLoad(workloadData);

  const activitiesQuery = trpc.training.activityStats.useQuery({ days });
  const activities = ActivityRowSchema.array().catch([]).parse(activitiesQuery.data ?? []);

  const weeklyVolumeQuery = trpc.training.weeklyVolume.useQuery({ days });
  const weeklyVolume = WeeklyVolumeRowSchema.array().catch([]).parse(weeklyVolumeQuery.data ?? []);
  const collapsedWeeklyVolume = collapseWeeklyVolumeActivityTypes(weeklyVolume, 6);
  const activityTypeTotalsMap = new Map<string, number>();
  for (const row of collapsedWeeklyVolume) {
    activityTypeTotalsMap.set(
      row.activity_type,
      (activityTypeTotalsMap.get(row.activity_type) ?? 0) + row.hours,
    );
  }
  const activityTypeTotals = [...activityTypeTotalsMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([activityType, hours]) => ({ activityType, hours }));

  const dailyStrain = rawLoadToStrain(displayedWorkload?.dailyLoad ?? 0);
  const acuteLoad = todayWorkload?.acuteLoad ?? 0;
  const chronicLoad = todayWorkload?.chronicLoad ?? 0;
  const workloadRatio = todayWorkload?.workloadRatio;
  const strainDateLabel =
    displayedWorkload == null
      ? "No training load yet"
      : displayedWorkload.date === todayWorkload?.date
        ? "Today"
        : `Last training day: ${new Date(displayedWorkload.date).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          })}`;

  const strainTrend = workloadData.slice(-14).map((d) => rawLoadToStrain(d.dailyLoad));

  const isLoading = workloadQuery.isLoading;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
    >
      <DaySelector days={days} onChange={setDays} />

      {isLoading ? (
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>Loading strain data...</Text>
        </View>
      ) : (
        <>
          {/* Current strain gauge */}
          <View style={styles.gaugeSection}>
            <StrainGauge strain={dailyStrain} size={160} />
            <Text style={styles.gaugeCaption}>{strainDateLabel}</Text>
          </View>

          {/* Workload breakdown */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Training Load</Text>
            <View style={styles.loadGrid}>
              <View style={styles.loadItem}>
                <Text style={styles.loadValue}>
                  {acuteLoad.toFixed(1)}
                </Text>
                <Text style={styles.loadLabel}>Acute (7 day)</Text>
              </View>
              <View style={styles.loadItem}>
                <Text style={styles.loadValue}>
                  {chronicLoad.toFixed(1)}
                </Text>
                <Text style={styles.loadLabel}>Chronic (28 day)</Text>
              </View>
              <View style={styles.loadItem}>
                <Text
                  style={[
                    styles.loadValue,
                    {
                      color: workloadRatioColor(workloadRatio ?? null),
                    },
                  ]}
                >
                  {workloadRatio != null ? workloadRatio.toFixed(2) : "--"}
                </Text>
                <Text style={styles.loadLabel}>Workload Ratio</Text>
              </View>
            </View>
            {workloadRatio != null && (
              <Text style={styles.ratioHint}>
                {workloadRatioHint(workloadRatio)}
              </Text>
            )}
          </View>

          {/* Strain trend */}
          <View style={styles.card}>
            <ChartTitleWithTooltip
              title={`Daily Strain (${days} Days)`}
              description="This chart shows your day-to-day strain trend across the selected date range."
              textStyle={styles.cardTitle}
            />
            {strainTrend.length >= 2 && (
              <View style={styles.sparkContainer}>
                <SparkLine
                  data={strainTrend}
                  width={320}
                  height={60}
                  color={colors.accent}
                  showBaseline
                />
              </View>
            )}
          </View>

          {/* Weekly volume summary */}
          {weeklyVolume.length > 0 && (
            <View style={styles.card}>
              <ChartTitleWithTooltip
                title="Weekly Volume"
                description="This chart shows your total training hours by week."
                textStyle={styles.cardTitle}
              />
              <View style={styles.volumeStack}>
                {aggregateWeeklyVolume(weeklyVolume).map((week) => (
                  <View key={week.week} style={styles.volumeRow}>
                    <Text style={styles.volumeDate}>
                      {new Date(week.week).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </Text>
                    <View style={styles.volumeBarTrack}>
                      <View
                        style={[
                          styles.volumeBarFill,
                          { width: `${week.fraction * 100}%` },
                        ]}
                      />
                    </View>
                    <Text style={styles.volumeHours}>
                      {week.hours.toFixed(1)}h
                    </Text>
                  </View>
                ))}
              </View>
              {activityTypeTotals.length > 0 && (
                <View style={styles.activityTypeSummary}>
                  {activityTypeTotals.map((entry) => (
                    <Text key={entry.activityType} style={styles.activityTypeSummaryItem}>
                      {formatActivityTypeLabel(entry.activityType)}: {entry.hours.toFixed(1)}h
                    </Text>
                  ))}
                </View>
              )}
            </View>
          )}

          {/* Recent activities */}
          {activities.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Recent Activities</Text>
              <View style={styles.activitiesStack}>
                {activities.slice(0, 5).map((activity) => (
                  <ActivityCard
                    key={String(activity.id)}
                    name={activity.name ?? ""}
                    activityType={activity.activity_type ?? ""}
                    startedAt={activity.started_at}
                    endedAt={activity.ended_at ?? null}
                    avgHr={activity.avg_hr ?? null}
                    maxHr={activity.max_hr ?? null}
                    avgPower={activity.avg_power ?? null}
                    distanceKm={activity.distance_meters ? activity.distance_meters / 1000 : null}
                    calories={activity.calories ?? null}
                    unitSystem={unitSystem}
                  />
                ))}
              </View>
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: 16,
    paddingBottom: 100,
    gap: 16,
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 80,
  },
  loadingText: {
    fontSize: 16,
    color: colors.textTertiary,
  },
  gaugeSection: {
    alignItems: "center",
    paddingVertical: 16,
    gap: 8,
  },
  gaugeCaption: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  loadGrid: {
    flexDirection: "row",
    justifyContent: "space-around",
  },
  loadItem: {
    alignItems: "center",
    gap: 4,
  },
  loadValue: {
    fontSize: 22,
    fontWeight: "700",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  loadLabel: {
    fontSize: 11,
    color: colors.textTertiary,
  },
  ratioHint: {
    fontSize: 12,
    color: colors.textSecondary,
    textAlign: "center",
  },
  sparkContainer: {
    alignItems: "center",
  },
  volumeStack: {
    gap: 8,
  },
  volumeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  volumeDate: {
    fontSize: 12,
    color: colors.textSecondary,
    width: 50,
  },
  volumeBarTrack: {
    flex: 1,
    height: 8,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 4,
    overflow: "hidden",
  },
  volumeBarFill: {
    height: "100%",
    backgroundColor: colors.accent,
    borderRadius: 4,
  },
  volumeHours: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.text,
    width: 40,
    textAlign: "right",
    fontVariant: ["tabular-nums"],
  },
  activityTypeSummary: {
    borderTopWidth: 1,
    borderTopColor: colors.surfaceSecondary,
    marginTop: 4,
    paddingTop: 8,
    gap: 4,
  },
  activityTypeSummaryItem: {
    fontSize: 12,
    color: colors.textSecondary,
    fontVariant: ["tabular-nums"],
  },
  section: {
    gap: 12,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  activitiesStack: {
    gap: 8,
  },
});
