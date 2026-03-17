import { ScrollView, StyleSheet, Text, View } from "react-native";
import { ActivityCard } from "../../components/ActivityCard";
import { StrainGauge } from "../../components/charts/StrainGauge";
import { SparkLine } from "../../components/charts/SparkLine";
import { trpc } from "../../lib/trpc";

interface WorkloadRow {
  date: string;
  dailyLoad: number;
  acuteLoad: number;
  chronicLoad: number;
  workloadRatio: number | null;
}

export default function StrainScreen() {
  const workloadQuery = trpc.recovery.workloadRatio.useQuery({ days: 30 });
  const workloadData = (workloadQuery.data ?? []) as WorkloadRow[];
  const todayWorkload = workloadData[workloadData.length - 1];

  const activitiesQuery = trpc.training.activityStats.useQuery({ days: 14 });
  const activities = ((activitiesQuery.data ?? []) as Array<Record<string, unknown>>);

  const weeklyVolumeQuery = trpc.training.weeklyVolume.useQuery({ days: 30 });
  const weeklyVolume = ((weeklyVolumeQuery.data ?? []) as Array<Record<string, unknown>>);

  const dailyStrain = todayWorkload?.dailyLoad ?? 0;
  const acuteLoad = todayWorkload?.acuteLoad ?? 0;
  const chronicLoad = todayWorkload?.chronicLoad ?? 0;
  const workloadRatio = todayWorkload?.workloadRatio;

  const strainTrend = workloadData.slice(-14).map((d) => d.dailyLoad);

  const isLoading = workloadQuery.isLoading;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
    >
      {isLoading ? (
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>Loading strain data...</Text>
        </View>
      ) : (
        <>
          {/* Today's strain gauge */}
          <View style={styles.gaugeSection}>
            <StrainGauge strain={dailyStrain} size={160} />
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
            <Text style={styles.cardTitle}>Daily Strain (14 Days)</Text>
            {strainTrend.length >= 2 && (
              <View style={styles.sparkContainer}>
                <SparkLine
                  data={strainTrend}
                  width={320}
                  height={60}
                  color="#007AFF"
                  showBaseline
                />
              </View>
            )}
          </View>

          {/* Weekly volume summary */}
          {weeklyVolume.length > 0 && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Weekly Volume</Text>
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
                    name={String(activity.name ?? "")}
                    activityType={String(activity.activity_type ?? "")}
                    startedAt={String(activity.started_at)}
                    endedAt={
                      activity.ended_at != null
                        ? String(activity.ended_at)
                        : null
                    }
                    avgHr={
                      activity.avg_hr != null ? Number(activity.avg_hr) : null
                    }
                    maxHr={
                      activity.max_hr != null ? Number(activity.max_hr) : null
                    }
                    avgPower={
                      activity.avg_power != null
                        ? Number(activity.avg_power)
                        : null
                    }
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

function workloadRatioColor(ratio: number | null): string {
  if (ratio == null) return "#8e8e93";
  if (ratio >= 0.8 && ratio <= 1.3) return "#00E676"; // sweet spot
  if (ratio >= 0.5 && ratio <= 1.5) return "#FFD600"; // caution
  return "#FF3D00"; // danger
}

function workloadRatioHint(ratio: number): string {
  if (ratio >= 0.8 && ratio <= 1.3) return "Optimal training zone";
  if (ratio < 0.8) return "Detraining risk - increase load gradually";
  if (ratio <= 1.5) return "High load - monitor recovery closely";
  return "Injury risk zone - consider rest";
}

interface WeekSummary {
  week: string;
  hours: number;
  fraction: number;
}

function aggregateWeeklyVolume(
  rows: Array<Record<string, unknown>>,
): WeekSummary[] {
  const weekMap = new Map<string, number>();
  for (const row of rows) {
    const week = String(row.week);
    const hours = Number(row.hours ?? 0);
    weekMap.set(week, (weekMap.get(week) ?? 0) + hours);
  }
  const entries = Array.from(weekMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-4);
  const maxHours = Math.max(...entries.map(([, h]) => h), 1);
  return entries.map(([week, hours]) => ({
    week,
    hours,
    fraction: hours / maxHours,
  }));
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
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
    color: "#636366",
  },
  gaugeSection: {
    alignItems: "center",
    paddingVertical: 16,
  },
  card: {
    backgroundColor: "#1c1c1e",
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: "#8e8e93",
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
    color: "#fff",
    fontVariant: ["tabular-nums"],
  },
  loadLabel: {
    fontSize: 11,
    color: "#636366",
  },
  ratioHint: {
    fontSize: 12,
    color: "#8e8e93",
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
    color: "#8e8e93",
    width: 50,
  },
  volumeBarTrack: {
    flex: 1,
    height: 8,
    backgroundColor: "#2a2a2e",
    borderRadius: 4,
    overflow: "hidden",
  },
  volumeBarFill: {
    height: "100%",
    backgroundColor: "#007AFF",
    borderRadius: 4,
  },
  volumeHours: {
    fontSize: 13,
    fontWeight: "600",
    color: "#fff",
    width: 40,
    textAlign: "right",
    fontVariant: ["tabular-nums"],
  },
  section: {
    gap: 12,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: "#8e8e93",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  activitiesStack: {
    gap: 8,
  },
});
