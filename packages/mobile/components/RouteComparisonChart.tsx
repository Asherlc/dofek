import {
  formatDateMedium,
  formatDateTime,
  formatDurationMinutes,
  formatPace,
  formatTimeOnly,
} from "@dofek/format/format";
import type { UnitConverter } from "@dofek/format/units";
import {
  type RouteComparison,
  resolveRouteComparisonSelection,
} from "@dofek/training/route-comparison";
import { formatActivityTypeLabel } from "@dofek/training/training";
import { useState } from "react";
import {
  type LayoutChangeEvent,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Svg, { Circle, Line, Text as SvgText } from "react-native-svg";
import { colors } from "../theme";
import { AccessibleChart } from "./AccessibleChart";

interface RouteComparisonChartProps {
  routes: RouteComparison[];
  units: UnitConverter;
  onActivityPress: (activityId: string) => void;
  width?: number;
}

const PADDING = { top: 16, left: 46, right: 24, bottom: 28 };
const HEIGHT = 180;

export function RouteComparisonChart({
  routes,
  units,
  onActivityPress,
  width,
}: RouteComparisonChartProps) {
  const [selectedRouteId, setSelectedRouteId] = useState<string>();
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const selected = resolveRouteComparisonSelection(routes, selectedRouteId);
  // Remember initial, changed-anchor, and fallback selections across refreshes.
  if (selectedRouteId !== selected?.routeId) setSelectedRouteId(selected?.routeId);
  const chartWidth = width ?? measuredWidth;
  const onLayout = (event: LayoutChangeEvent) => {
    if (width === undefined) setMeasuredWidth(event.nativeEvent.layout.width);
  };
  if (!selected) return null;

  const points = selected.instances.map((attempt) => ({
    ...attempt,
    timestamp: new Date(attempt.startedAt).getTime(),
    pace:
      attempt.averagePaceMinPerKm === null
        ? null
        : units.convertPace(attempt.averagePaceMinPerKm * 60),
  }));
  const timestamps = points.map((point) => point.timestamp);
  const xMin = Math.min(...timestamps);
  const xMax = Math.max(...timestamps);
  const sameDay = new Date(xMin).toDateString() === new Date(xMax).toDateString();
  const paces = points.flatMap((point) => (point.pace === null ? [] : [point.pace]));
  const paceMin = Math.min(...paces);
  const paceMax = Math.max(...paces);
  const pacePadding = (paceMax - paceMin || 60) * 0.1;
  const yMin = Math.max(0, paceMin - pacePadding);
  const yMax = paceMax + pacePadding;
  const scaleX = (timestamp: number) =>
    PADDING.left +
    (xMax === xMin ? 0.5 : (timestamp - xMin) / (xMax - xMin)) *
      Math.max(0, chartWidth - PADDING.left - PADDING.right);
  // Lower pace values represent faster attempts and appear higher in the plot.
  const scaleY = (pace: number) => PADDING.top + ((pace - yMin) / (yMax - yMin)) * HEIGHT;
  const yTicks = paces.length ? [yMin, (yMin + yMax) / 2, yMax] : [];

  return (
    <View style={styles.container}>
      <ScrollView horizontal accessibilityRole="radiogroup" accessibilityLabel="Comparison route">
        {routes.map((route) => {
          const firstAttempt = route.instances[0];
          if (!firstAttempt) return null;
          const title = `${route.activityName} · ${formatActivityTypeLabel(route.activityType)}`;
          const detail = `${firstAttempt.distanceKm === null ? "Distance unavailable" : units.formatDistance(firstAttempt.distanceKm).text} · ${formatDateMedium(firstAttempt.startedAt)} · ${route.attemptCount} attempts`;
          const label = `${title} · ${detail}`;
          const checked = selected.routeId === route.routeId;
          return (
            <TouchableOpacity
              key={route.routeId}
              accessibilityRole="radio"
              accessibilityLabel={label}
              accessibilityState={{ checked }}
              onPress={() => setSelectedRouteId(route.routeId)}
              style={[styles.option, checked && styles.selectedOption]}
            >
              <Text style={{ color: checked ? colors.accent : colors.textSecondary }}>{title}</Text>
              <Text style={styles.optionDetail}>{detail}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      <AccessibleChart
        key={selected.routeId}
        title="Route comparison"
        summary={`${selected.activityName}; pace by activity date. Lower pace is faster and appears higher. ${selected.attemptCount} attempts.`}
        rows={points.map((point) => ({
          label: point.activityName,
          value: [
            formatDateTime(point.startedAt),
            point.pace === null
              ? "Pace unavailable"
              : `${formatPace(point.pace)} ${units.paceLabel}`,
            formatDurationMinutes(point.durationMinutes),
            point.distanceKm === null
              ? "Distance unavailable"
              : units.formatDistance(point.distanceKm).text,
            point.avgHeartRate === null ? "Heart rate unavailable" : `${point.avgHeartRate} bpm`,
            `${units.formatElevation(point.elevationGainMeters).text} elevation gain`,
          ].join(" · "),
          onPress: () => onActivityPress(point.activityId),
        }))}
      >
        <View onLayout={onLayout}>
          <Text style={styles.caption}>Pace (min{units.paceLabel}) · Faster ↑</Text>
          {paces.length ? (
            chartWidth > 0 ? (
              <Svg width={chartWidth} height={HEIGHT + PADDING.top + PADDING.bottom}>
                {yTicks.map((tick) => (
                  <Line
                    key={`grid-${tick}`}
                    x1={PADDING.left}
                    x2={chartWidth - PADDING.right}
                    y1={scaleY(tick)}
                    y2={scaleY(tick)}
                    stroke={colors.surfaceSecondary}
                  />
                ))}
                {yTicks.map((tick) => (
                  <SvgText
                    key={`label-${tick}`}
                    x={PADDING.left - 6}
                    y={scaleY(tick) + 4}
                    textAnchor="end"
                    fontSize={10}
                    fill={colors.textSecondary}
                  >
                    {formatPace(tick)}
                  </SvgText>
                ))}
                <Line
                  x1={PADDING.left}
                  x2={chartWidth - PADDING.right}
                  y1={HEIGHT + PADDING.top}
                  y2={HEIGHT + PADDING.top}
                  stroke={colors.textTertiary}
                />
                {[...new Set([xMin, xMax])].map((tick, index) => (
                  <SvgText
                    key={tick}
                    x={scaleX(tick)}
                    y={HEIGHT + PADDING.top + 20}
                    textAnchor={xMin === xMax ? "middle" : index === 0 ? "start" : "end"}
                    fontSize={10}
                    fill={colors.textSecondary}
                  >
                    {sameDay ? formatTimeOnly(new Date(tick)) : formatDateMedium(new Date(tick))}
                  </SvgText>
                ))}
                {points.map((point) =>
                  point.pace === null ? null : (
                    <Circle
                      key={point.activityId}
                      cx={scaleX(point.timestamp)}
                      cy={scaleY(point.pace)}
                      r={5}
                      fill={colors.accent}
                      onPress={() => onActivityPress(point.activityId)}
                    />
                  ),
                )}
              </Svg>
            ) : (
              <View style={{ height: HEIGHT + PADDING.top + PADDING.bottom }} />
            )
          ) : (
            <Text style={styles.caption}>Pace unavailable for these attempts</Text>
          )}
          <Text style={styles.caption}>
            {sameDay ? `Activity date · ${formatDateMedium(new Date(xMin))}` : "Activity date"}
          </Text>
        </View>
      </AccessibleChart>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12 },
  option: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
    borderRadius: 8,
    marginRight: 8,
  },
  selectedOption: { borderColor: colors.accent },
  optionDetail: { color: colors.textSecondary, fontSize: 12 },
  caption: { color: colors.textSecondary, fontSize: 12, textAlign: "center" },
});
