import { formatNumber } from "@dofek/format/format";
import { aggregateWeeklyVolume, StrainScore, WorkloadRatio } from "@dofek/scoring/scoring";
import {
  collapseWeeklyVolumeActivityTypes,
  formatActivityTypeLabel,
} from "@dofek/training/training";
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { ActivityCard } from "../../components/ActivityCard";
import { ChartTitleWithTooltip } from "../../components/ChartTitleWithTooltip";
import { SparkLine } from "../../components/charts/SparkLine";
import { StrainGauge } from "../../components/charts/StrainGauge";
import { VerticalAscentChart } from "../../components/charts/VerticalAscentChart";
import { DaySelector } from "../../components/DaySelector";
import { safeParseRows } from "../../lib/safe-parse";
import { trpc } from "../../lib/trpc";
import { useUnitConverter } from "../../lib/units";
import { useRefresh } from "../../lib/useRefresh";
import { colors } from "../../theme";
import { ActivityRowSchema, WeeklyVolumeRowSchema } from "../../types/api";

export default function StrainScreen() {
  const router = useRouter();
  const [days, setDays] = useState(30);
  const units = useUnitConverter();
  const endDate = useMemo(() => new Date().toLocaleDateString("en-CA"), []);
  const workloadQuery = trpc.recovery.workloadRatio.useQuery({ days });
  const workloadResult = workloadQuery.data;
  const workloadData = workloadResult?.timeSeries ?? [];
  const todayWorkload = workloadData[workloadData.length - 1];

  const strainTargetQuery = trpc.recovery.strainTarget.useQuery({ days, endDate });
  const strainTarget = strainTargetQuery.data;

  const activitiesQuery = trpc.training.activityStats.useQuery({ days });
  const activitiesParsed = safeParseRows(
    ActivityRowSchema,
    activitiesQuery.data,
    "strain:activities",
  );
  const activities = activitiesParsed.data;

  const verticalAscentQuery = trpc.cyclingAdvanced.verticalAscentRate.useQuery({ days });

  const weeklyVolumeQuery = trpc.training.weeklyVolume.useQuery({ days });
  const weeklyVolumeParsed = safeParseRows(
    WeeklyVolumeRowSchema,
    weeklyVolumeQuery.data,
    "strain:weeklyVolume",
  );
  const weeklyVolume = weeklyVolumeParsed.data;
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

  const strainTrend = workloadData.map((d) => d.strain);

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

          {/* Strain Target */}
          {strainTarget && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Daily Strain Target</Text>
              <View style={styles.targetHeader}>
                <View style={styles.targetValueRow}>
                  <Text style={styles.targetValue}>{strainTarget.targetStrain}</Text>
                  <Text
                    style={[
                      styles.zoneBadge,
                      {
                        backgroundColor:
                          strainTarget.zone === "Push"
                            ? `${colors.positive}20`
                            : strainTarget.zone === "Recovery"
                              ? `${colors.danger}20`
                              : `${colors.warning}20`,
                        color:
                          strainTarget.zone === "Push"
                            ? colors.positive
                            : strainTarget.zone === "Recovery"
                              ? colors.danger
                              : colors.warning,
                      },
                    ]}
                  >
                    {strainTarget.zone}
                  </Text>
                </View>
                <Text style={styles.targetProgress}>{strainTarget.progressPercent}% reached</Text>
              </View>
              <View style={styles.targetBarTrack}>
                <View
                  style={[
                    styles.targetBarFill,
                    {
                      width: `${Math.min(strainTarget.progressPercent, 100)}%`,
                      backgroundColor: new StrainScore(strainTarget.currentStrain).color,
                    },
                  ]}
                />
              </View>
              <Text style={styles.targetExplanation}>{strainTarget.explanation}</Text>
            </View>
          )}

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
            {strainTrend.length >= 2 ? (
              <SparkLine
                data={strainTrend}
                height={60}
                color={colors.accent}
                showBaseline
                showYAxis
              />
            ) : (
              <Text style={styles.emptyChartText}>No training data yet for this period</Text>
            )}
          </View>

          {/* Vertical Ascent Rate */}
          {(verticalAscentQuery.data ?? []).length > 0 && (
            <View style={styles.card}>
              <ChartTitleWithTooltip
                title="Vertical Ascent Rate"
                description="Climbing speed — meters gained per hour while ascending. Bubble size indicates elevation gain."
                textStyle={styles.cardTitle}
              />
              <VerticalAscentChart data={verticalAscentQuery.data ?? []} units={units} />
            </View>
          )}

          {/* Weekly volume summary */}
          {(weeklyVolumeQuery.isError || weeklyVolumeParsed.error) && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Weekly Volume</Text>
              <Text style={styles.errorText}>Failed to load weekly volume.</Text>
            </View>
          )}
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
            {activitiesQuery.isLoading ? (
              <ActivityIndicator color={colors.accent} style={styles.activitiesLoader} />
            ) : activitiesQuery.isError || activitiesParsed.error ? (
              <Text style={styles.errorText}>
                {activitiesQuery.error?.message ?? "Failed to load activities."}
              </Text>
            ) : activities.length > 0 ? (
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
            ) : (
              <Text style={styles.activitiesEmpty}>No recent activities</Text>
            )}
          </View>
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
  targetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  targetValueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  targetValue: {
    fontSize: 28,
    fontWeight: "700",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  zoneBadge: {
    fontSize: 11,
    fontWeight: "700",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    overflow: "hidden",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  targetProgress: {
    fontSize: 13,
    color: colors.textSecondary,
    fontVariant: ["tabular-nums"],
  },
  targetBarTrack: {
    height: 8,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 4,
    overflow: "hidden",
  },
  targetBarFill: {
    height: "100%",
    borderRadius: 4,
  },
  targetExplanation: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  sparkContainer: {
    alignItems: "center",
  },
  emptyChartText: {
    fontSize: 13,
    color: colors.textTertiary,
    textAlign: "center",
    paddingVertical: 16,
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
  activitiesLoader: {
    paddingVertical: 24,
  },
  activitiesEmpty: {
    color: colors.textTertiary,
    fontSize: 13,
    textAlign: "center",
    paddingVertical: 24,
  },
  errorText: {
    color: "#f87171",
    fontSize: 13,
    textAlign: "center",
    paddingVertical: 24,
  },
});
