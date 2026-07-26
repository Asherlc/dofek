import {
  formatDateShort,
  formatDurationMinutes,
  formatHRV,
  formatMonthYear,
} from "@dofek/format/format";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Card } from "../components/Card";
import { HealthReportShareButton } from "../components/HealthReportShareButton";
import { getQueryErrorMessage, QueryStatePanel } from "../components/QueryStatePanel";
import { trpc } from "../lib/trpc";
import { useTodayQueryDate } from "../lib/useTodayQueryDate";
import { colors, spacing } from "../theme";

const REPORT_WEEKS = 12;
const REPORT_MONTHS = 6;

export default function ReportsScreen() {
  const endDate = useTodayQueryDate();
  const weeklyReport = trpc.weeklyReport.report.useQuery({
    weeks: REPORT_WEEKS,
    endDate,
  });
  const monthlyReport = trpc.monthlyReport.report.useQuery({ months: REPORT_MONTHS });

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.intro}>
        <Text style={styles.title}>Health Reports</Text>
        <Text style={styles.subtitle}>
          Create shareable snapshots from the health data calculated by Dofek.
        </Text>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Weekly Report</Text>
          {weeklyReport.data?.current ? (
            <HealthReportShareButton
              input={{ reportType: "weekly", weeks: REPORT_WEEKS, endDate }}
            />
          ) : null}
        </View>
        {weeklyReport.error && !weeklyReport.data ? (
          <QueryStatePanel variant="error" message={getQueryErrorMessage(weeklyReport.error)} />
        ) : weeklyReport.isLoading ? (
          <QueryStatePanel variant="loading" />
        ) : weeklyReport.data?.current ? (
          <Card>
            <Text style={styles.periodLabel}>
              Week of {formatDateShort(weeklyReport.data.current.weekStart)}
            </Text>
            <View style={styles.metricGrid}>
              <ReportMetric
                label="Training"
                value={formatDurationMinutes(weeklyReport.data.current.trainingHours * 60)}
              />
              <ReportMetric
                label="Activities"
                value={`${weeklyReport.data.current.activityCount}`}
              />
              <ReportMetric
                label="Avg nightly sleep"
                value={
                  weeklyReport.data.current.avgSleepMinutes > 0
                    ? formatDurationMinutes(weeklyReport.data.current.avgSleepMinutes)
                    : "Not tracked"
                }
              />
              <ReportMetric
                label="Average Heart Rate Variability (HRV)"
                value={formatHRV(weeklyReport.data.current.avgHrv)}
              />
            </View>
          </Card>
        ) : (
          <QueryStatePanel variant="empty" message="Not enough weekly data to create a report." />
        )}
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Monthly Report</Text>
          {monthlyReport.data?.current ? (
            <HealthReportShareButton input={{ reportType: "monthly", months: REPORT_MONTHS }} />
          ) : null}
        </View>
        {monthlyReport.error && !monthlyReport.data ? (
          <QueryStatePanel variant="error" message={getQueryErrorMessage(monthlyReport.error)} />
        ) : monthlyReport.isLoading ? (
          <QueryStatePanel variant="loading" />
        ) : monthlyReport.data?.current ? (
          <Card>
            <Text style={styles.periodLabel}>
              {formatMonthYear(monthlyReport.data.current.monthStart)}
            </Text>
            <View style={styles.metricGrid}>
              <ReportMetric
                label="Training"
                value={formatDurationMinutes(monthlyReport.data.current.trainingHours * 60)}
              />
              <ReportMetric
                label="Activities"
                value={`${monthlyReport.data.current.activityCount}`}
              />
              <ReportMetric
                label="Avg sleep"
                value={formatDurationMinutes(monthlyReport.data.current.avgSleepMinutes)}
              />
              <ReportMetric
                label="Average Heart Rate Variability (HRV)"
                value={formatHRV(monthlyReport.data.current.avgHrv)}
              />
            </View>
          </Card>
        ) : (
          <QueryStatePanel variant="empty" message="Not enough monthly data to create a report." />
        )}
      </View>
    </ScrollView>
  );
}

function ReportMetric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: spacing.md,
    paddingBottom: spacing.xl,
    gap: spacing.xl,
  },
  intro: {
    gap: spacing.xs,
  },
  title: {
    color: colors.text,
    fontSize: 24,
    fontWeight: "700",
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  section: {
    gap: spacing.sm,
  },
  sectionHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "700",
  },
  periodLabel: {
    color: colors.textSecondary,
    fontSize: 13,
  },
  metricGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    rowGap: spacing.md,
  },
  metric: {
    width: "50%",
    gap: 2,
  },
  metricLabel: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  metricValue: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
});
