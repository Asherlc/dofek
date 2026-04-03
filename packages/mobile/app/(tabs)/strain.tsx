import { formatNumber } from "@dofek/format/format";
import {
  collapseWeeklyVolumeActivityTypes,
  formatActivityTypeLabel,
} from "@dofek/training/training";
import { useRouter } from "expo-router";
import { useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ActivityCard } from "../../components/ActivityCard";
import { ChartTitleWithTooltip } from "../../components/ChartTitleWithTooltip";
import { SparkLine } from "../../components/charts/SparkLine";
import { StrainGauge } from "../../components/charts/StrainGauge";
import { DaySelector } from "../../components/DaySelector";
import { aggregateWeeklyVolume, WorkloadRatio } from "../../lib/scoring";
import { trpc } from "../../lib/trpc";
import { useUnitConverter } from "../../lib/units";
import { useRefresh } from "../../lib/useRefresh";
import { colors } from "../../theme";
import { ActivityRowSchema, WeeklyVolumeRowSchema } from "../../types/api";

export default function StrainScreen() {
  const router = useRouter();
  const [days, setDays] = useState(30);
  const units = useUnitConverter();
  const workloadQuery = trpc.recovery.workloadRatio.useQuery({ days });
  const workloadResult = workloadQuery.data;
  const workloadData = workloadResult?.timeSeries ?? [];
  const todayWorkload = workloadData[workloadData.length - 1];

  const activitiesQuery = trpc.training.activityStats.useQuery({ days });
  const activities = ActivityRowSchema.array()
    .catch([])
    .parse(activitiesQuery.data ?? []);

  const weeklyVolumeQuery = trpc.training.weeklyVolume.useQuery({ days });
  const weeklyVolume = WeeklyVolumeRowSchema.array()
    .catch([])
    .parse(weeklyVolumeQuery.data ?? []);
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

  const dailyStrain = workloadResult?.displayedStrain ?? 0;
  const acuteLoad = todayWorkload?.acuteLoad ?? 0;
  const chronicLoad = todayWorkload?.chronicLoad ?? 0;
  const workloadRatio = todayWorkload?.workloadRatio;
  const workloadRatioScore = new WorkloadRatio(workloadRatio ?? null);
  const displayedDate = workloadResult?.displayedDate;
  const strainDateLabel =
    displayedDate == null
      ? "No training load yet"
      : displayedDate === todayWorkload?.date
        ? "Today"
        : `Last training day: ${new Date(displayedDate).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          })}`;

  const strainTrend = workloadData.slice(-14).map((d) => d.strain);

  const isLoading = workloadQuery.isLoading;
  const { refreshing, onRefresh } = useRefresh();

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.textSecondary}
        />
      }
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
                <Text style={styles.loadValue}>{formatNumber(acuteLoad)}</Text>
                <Text style={styles.loadLabel}>Acute (7 day)</Text>
              </View>
              <View style={styles.loadItem}>
                <Text style={styles.loadValue}>{formatNumber(chronicLoad)}</Text>
                <Text style={styles.loadLabel}>Chronic (28 day)</Text>
              </View>
              <View style={styles.loadItem}>
                <Text
                  style={[
                    styles.loadValue,
                    {
                      color: workloadRatioScore.color,
                    },
                  ]}
                >
                  {workloadRatio != null ? formatNumber(workloadRatio, 2) : "--"}
                </Text>
                <Text style={styles.loadLabel}>Workload Ratio</Text>
              </View>
            </View>
            {workloadRatio != null && (
              <Text style={styles.ratioHint}>{workloadRatioScore.hint}</Text>
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
                <SparkLine data={strainTrend} height={60} color={colors.accent} showBaseline />
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
                      <View style={[styles.volumeBarFill, { width: `${week.fraction * 100}%` }]} />
                    </View>
                    <Text style={styles.volumeHours}>{formatNumber(week.hours)}h</Text>
                  </View>
                ))}
              </View>
              {activityTypeTotals.length > 0 && (
                <View style={styles.activityTypeSummary}>
                  {activityTypeTotals.map((entry) => (
                    <Text key={entry.activityType} style={styles.activityTypeSummaryItem}>
                      {formatActivityTypeLabel(entry.activityType)}: {formatNumber(entry.hours)}h
                    </Text>
                  ))}
                </View>
              )}
            </View>
          )}

          {/* Recent activities */}
          {activities.length > 0 && (
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Recent Activities</Text>
                <TouchableOpacity
                  activeOpacity={0.7}
                  onPress={() => router.push("/activities")}
                  style={styles.sectionLinkButton}
                >
                  <Text style={styles.sectionLinkButtonText}>View all</Text>
                </TouchableOpacity>
              </View>
              <View style={styles.activitiesStack}>
                {activities.slice(0, 5).map((activity) => (
                  <TouchableOpacity
                    key={String(activity.id)}
                    activeOpacity={0.7}
                    onPress={() => router.push(`/activity/${activity.id}`)}
                  >
                    <ActivityCard
                      name={activity.name ?? ""}
                      activityType={activity.activity_type ?? ""}
                      startedAt={activity.started_at}
                      endedAt={activity.ended_at ?? null}
                      avgHr={activity.avg_hr ?? null}
                      maxHr={activity.max_hr ?? null}
                      avgPower={activity.avg_power ?? null}
                      distanceKm={activity.distance_meters ? activity.distance_meters / 1000 : null}
                      units={units}
                    />
                  </TouchableOpacity>
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
  sectionHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  sectionLinkButton: {
    borderColor: colors.surfaceSecondary,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  sectionLinkButtonText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  activitiesStack: {
    gap: 8,
  },
});
