import { formatDateLong, formatDateMedium, formatDateYmd } from "@dofek/format/format";
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Svg, { Circle, Line, Path, Text as SvgText } from "react-native-svg";
import { Card } from "../components/Card";
import { DaySelector } from "../components/DaySelector";
import { getQueryErrorMessage, QueryStatePanel } from "../components/QueryStatePanel";
import { trpc } from "../lib/trpc";
import { useTimeRangePreference } from "../lib/useTimeRangePreference";
import { chartColors, colors, spacing } from "../theme";

const CHART_HEIGHT = 150;
const CHART_PADDING = { top: 16, right: 12, bottom: 28, left: 12 };

interface TrendPoint {
  date: string;
  value: number | null;
  source: { providerId: string; label: string } | null;
}

interface TrendSeries {
  questionSlug: string;
  displayName: string;
  dataType: "boolean" | "numeric";
  unit: string | null;
  statement: string;
  points: TrendPoint[];
}

function JournalTrendChart({
  endDate,
  series,
  startDate,
}: {
  endDate: string;
  series: TrendSeries;
  startDate: string;
}) {
  const { width } = useWindowDimensions();
  const chartWidth = Math.max(240, Math.min(width - spacing.md * 4, 640));
  const plotWidth = chartWidth - CHART_PADDING.left - CHART_PADDING.right;
  const plotHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
  const dates = [...new Set(series.points.map((point) => point.date))];
  const dateIndex = new Map(dates.map((date, index) => [date, index]));
  const xForDate = (date: string) => {
    const index = dateIndex.get(date) ?? 0;
    return (
      CHART_PADDING.left +
      (dates.length === 1 ? plotWidth / 2 : (index / (dates.length - 1)) * plotWidth)
    );
  };
  const values = series.points.flatMap((point) => (point.value === null ? [] : [point.value]));
  const minimum = series.dataType === "boolean" ? 0 : Math.min(...values);
  const maximum = series.dataType === "boolean" ? 1 : Math.max(...values);
  const valueRange = maximum - minimum || 1;
  const yForValue = (value: number) =>
    CHART_PADDING.top + plotHeight - ((value - minimum) / valueRange) * plotHeight;
  const segments: Array<Array<{ date: string; value: number }>> = [];
  let activeSegment: Array<{ date: string; value: number }> = [];

  for (const point of series.points) {
    if (point.value === null) {
      if (activeSegment.length > 0) segments.push(activeSegment);
      activeSegment = [];
    } else {
      activeSegment.push({ date: point.date, value: point.value });
    }
  }
  if (activeSegment.length > 0) segments.push(activeSegment);

  const observedPoints = series.points.filter(
    (point): point is TrendPoint & { value: number } => point.value !== null,
  );
  const hasSameDayObservations =
    new Set(observedPoints.map((point) => point.date)).size !== observedPoints.length;
  const missingDates = series.points
    .filter((point) => point.value === null)
    .map((point) => point.date);
  const accessibilityLabel = hasSameDayObservations
    ? `${series.displayName} journal trend from ${formatDateMedium(startDate)} to ${formatDateMedium(endDate)}. Multiple sources recorded the same date, so observations are shown as separate points. Exact values are listed below.`
    : `${series.displayName} journal trend from ${formatDateMedium(startDate)} to ${formatDateMedium(endDate)}. Missing days are marked as hollow circles. Exact values are listed below.`;

  return (
    <View accessible accessibilityLabel={accessibilityLabel}>
      <Svg width={chartWidth} height={CHART_HEIGHT}>
        <Line
          x1={CHART_PADDING.left}
          y1={CHART_PADDING.top + plotHeight}
          x2={CHART_PADDING.left + plotWidth}
          y2={CHART_PADDING.top + plotHeight}
          stroke={colors.surfaceSecondary}
          strokeWidth={1}
        />
        {series.dataType === "numeric" && !hasSameDayObservations
          ? segments.map((segment, index) =>
              segment.length > 1 ? (
                <Path
                  key={`segment-${segment[0]?.date ?? index}`}
                  d={segment
                    .map(
                      (point, pointIndex) =>
                        `${pointIndex === 0 ? "M" : "L"} ${xForDate(point.date)} ${yForValue(point.value)}`,
                    )
                    .join(" ")}
                  fill="none"
                  stroke={chartColors.blue}
                  strokeWidth={2}
                />
              ) : null,
            )
          : null}
        {observedPoints.map((point) => (
          <Circle
            key={`observed-${point.date}-${point.source?.providerId ?? "unknown"}`}
            cx={xForDate(point.date)}
            cy={yForValue(point.value)}
            r={4}
            fill={chartColors.blue}
          />
        ))}
        {missingDates.map((date) => (
          <Circle
            key={`missing-${date}`}
            cx={xForDate(date)}
            cy={CHART_PADDING.top + plotHeight}
            r={4}
            fill="none"
            stroke={colors.textTertiary}
            strokeWidth={1.5}
          />
        ))}
        <SvgText
          x={CHART_PADDING.left}
          y={CHART_HEIGHT - 5}
          textAnchor="start"
          fontSize={10}
          fill={colors.textTertiary}
        >
          {formatDateMedium(startDate)}
        </SvgText>
        <SvgText
          x={CHART_PADDING.left + plotWidth}
          y={CHART_HEIGHT - 5}
          textAnchor="end"
          fontSize={10}
          fill={colors.textTertiary}
        >
          {formatDateMedium(endDate)}
        </SvgText>
      </Svg>
    </View>
  );
}

function formatTrendValue(value: number, dataType: TrendSeries["dataType"], unit: string | null) {
  if (dataType === "boolean") {
    return value === 1 ? "Yes" : value === 0 ? "No" : String(value);
  }
  return `${value}${unit ? ` ${unit}` : ""}`;
}

function TrendCard({
  endDate,
  series,
  startDate,
}: {
  endDate: string;
  series: TrendSeries;
  startDate: string;
}) {
  const observations = series.points.filter(
    (
      point,
    ): point is TrendPoint & {
      value: number;
      source: NonNullable<TrendPoint["source"]>;
    } => point.value !== null && point.source !== null,
  );
  const missingDates = series.points
    .filter((point) => point.value === null)
    .map((point) => formatDateLong(point.date));

  return (
    <Card title={series.displayName}>
      <Text style={styles.evidenceText}>{series.statement}</Text>
      <JournalTrendChart endDate={endDate} series={series} startDate={startDate} />
      <Text style={styles.detailHeading}>Exact values</Text>
      {observations.map((point) => (
        <Text key={`${point.date}-${point.source.providerId}`} style={styles.detailText}>
          {formatDateLong(point.date)}:{" "}
          {formatTrendValue(point.value, series.dataType, series.unit)} · {point.source.label}
        </Text>
      ))}
      <Text style={styles.detailHeading}>Missing days</Text>
      <Text style={styles.detailText}>Missing: {missingDates.join(", ") || "None"}</Text>
    </Card>
  );
}

export default function TrackingScreen() {
  const { days, description, setDays } = useTimeRangePreference("behavior");
  const query = trpc.journal.trends.useQuery({
    days,
    endDate: formatDateYmd(),
  });
  const evidence = query.data;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.heading}>
        <Text style={styles.title}>Journal Trends</Text>
        <Text style={styles.subtitle}>
          Review exact numeric and Yes/No journal observations over time
        </Text>
      </View>

      <DaySelector days={days} description={description} onChange={setDays} />

      {query.isLoading && !evidence ? (
        <QueryStatePanel variant="loading" />
      ) : query.error && !evidence ? (
        <QueryStatePanel
          variant="error"
          message={getQueryErrorMessage(query.error)}
          onRetry={() => void query.refetch()}
          retryLabel="Retry journal trends"
        />
      ) : evidence && evidence.series.length === 0 ? (
        <>
          {query.error ? (
            <QueryStatePanel
              variant="error"
              message={getQueryErrorMessage(query.error)}
              onRetry={() => void query.refetch()}
              retryLabel="Retry journal trends"
            />
          ) : null}
          <QueryStatePanel
            variant="empty"
            title="No numeric journal data to chart"
            message="Sync a numeric or Yes/No journal observation to start reviewing trends."
          />
        </>
      ) : evidence ? (
        <>
          {query.error ? (
            <QueryStatePanel
              variant="error"
              message={getQueryErrorMessage(query.error)}
              onRetry={() => void query.refetch()}
              retryLabel="Retry journal trends"
            />
          ) : null}
          <Card title="Evidence">
            <Text style={styles.window}>
              {formatDateMedium(evidence.window.startDate)} –{" "}
              {formatDateMedium(evidence.window.endDate)}
            </Text>
            <Text style={styles.evidenceText}>{evidence.statement}</Text>
            <Text style={styles.evidenceText}>{evidence.uncertainty.statement}</Text>
            <View style={styles.legend}>
              <View style={styles.missingMarker} />
              <Text style={styles.legendText}>No recorded value</Text>
            </View>
          </Card>
          {evidence.series.map((series) => (
            <TrendCard
              key={series.questionSlug}
              endDate={evidence.window.endDate}
              series={series}
              startDate={evidence.window.startDate}
            />
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: spacing.md,
    paddingBottom: 100,
    gap: spacing.md,
  },
  heading: {
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
  window: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  evidenceText: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  legend: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.xs,
  },
  missingMarker: {
    borderColor: colors.textTertiary,
    borderRadius: 5,
    borderWidth: 1.5,
    height: 10,
    width: 10,
  },
  legendText: {
    color: colors.textTertiary,
    fontSize: 12,
  },
  detailHeading: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "600",
  },
  detailText: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
});
