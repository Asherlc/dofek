import {
  formatDateMedium,
  formatDateShort,
  formatDurationSeconds,
  formatNumber,
  formatSigned,
} from "@dofek/format/format";
import type { AppRouterOutputs } from "dofek-server/router";
import { useRouter } from "expo-router";
import { type ReactNode, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Line, Text as SvgText } from "react-native-svg";
import { colors } from "../../theme";
import { AccessibleChart } from "../AccessibleChart";
import { getQueryErrorMessage, QueryStatePanel } from "../QueryStatePanel";

type Decoupling = AppRouterOutputs["cycling"]["decoupling"];
type Half = Decoupling["rides"][number]["firstHalf"];
const title = "Power-to-heart-rate decoupling";
const sign = "Positive values mean power was lower relative to heart rate in the second half.";

function halfSummary(half: Half) {
  return `${half.meanWatts ?? "—"} W · ${half.meanBpm ?? "—"} bpm · ${half.coveragePct}% paired coverage`;
}

export function CyclingDecouplingChart({
  data,
  loading,
  error,
}: {
  data?: Decoupling;
  loading?: boolean;
  error?: unknown;
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const points = (data?.rides ?? []).map((ride) => ({
    ...ride,
    timestamp: Date.parse(ride.date),
  }));
  const first = points[0];
  const last = points.at(-1);
  const labelFor = (ride: (typeof points)[number]) =>
    `${ride.name ?? data?.workoutName} · ${formatDateMedium(ride.date)}`;
  const rowLabel = (ride: (typeof points)[number], index: number) => {
    const label = labelFor(ride);
    const duplicate = points.some(
      (other) =>
        other.activityId !== ride.activityId &&
        labelFor(other) === label &&
        formatSigned(other.percent) === formatSigned(ride.percent),
    );
    return duplicate ? `${label} · Ride ${index + 1}` : label;
  };
  const selected = points.find((ride) => ride.activityId === selectedId);

  let content: ReactNode;
  if (!data && error) {
    content = <QueryStatePanel variant="error" message={getQueryErrorMessage(error)} />;
  } else if (!data && loading) {
    content = <QueryStatePanel variant="loading" />;
  } else if (!first || !last) {
    content = (
      <QueryStatePanel
        variant="empty"
        title="No repeat rides in this date range"
        message="Choose a wider date range to look for matching workouts."
      />
    );
  } else {
    const values = points.map((ride) => ride.percent);
    const lower = Math.min(-1, ...values);
    const upper = Math.max(1, ...values);
    const scaleY = (value: number) => 16 + ((upper - value) / (upper - lower)) * 132;
    const scaleX = (timestamp: number) =>
      first.timestamp === last.timestamp
        ? width / 2
        : 46 + ((timestamp - first.timestamp) / (last.timestamp - first.timestamp)) * (width - 82);
    content = (
      <>
        <Text style={styles.strong}>
          {data?.workoutName} · {points.length} rides · Same workout template
        </Text>
        <AccessibleChart
          title={title}
          summary="Decoupling percent by workout date. Select a ride for details."
          rows={points.map((ride, index) => ({
            label: rowLabel(ride, index),
            value: `${formatSigned(ride.percent)}%`,
            onPress: () => setSelectedId(ride.activityId),
          }))}
        >
          <View
            onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
            style={{ height: 178 }}
          >
            {width > 82 && (
              <Svg width={width} height={178}>
                {[upper, 0, lower].map((tick) => (
                  <SvgText
                    key={tick}
                    x={38}
                    y={scaleY(tick) + 4}
                    textAnchor="end"
                    fontSize={10}
                    fill={colors.textSecondary}
                  >
                    {formatNumber(tick, 1)}%
                  </SvgText>
                ))}
                <Line
                  x1={44}
                  x2={width - 20}
                  y1={scaleY(0)}
                  y2={scaleY(0)}
                  stroke={colors.textTertiary}
                />
                {points.map((ride) => (
                  <Circle
                    key={ride.activityId}
                    cx={scaleX(ride.timestamp)}
                    cy={scaleY(ride.percent)}
                    r={ride.activityId === selectedId ? 8 : 5}
                    fill={colors.accent}
                    onPress={() => setSelectedId(ride.activityId)}
                  />
                ))}
                {(formatDateShort(first.date) === formatDateShort(last.date)
                  ? [first]
                  : [first, last]
                ).map((ride) => (
                  <SvgText
                    key={ride.activityId}
                    x={scaleX(ride.timestamp)}
                    y={170}
                    textAnchor="middle"
                    fontSize={10}
                    fill={colors.textSecondary}
                  >
                    {formatDateShort(ride.date)}
                  </SvgText>
                ))}
              </Svg>
            )}
          </View>
        </AccessibleChart>
        <Text style={styles.secondary}>{sign}</Text>
        {selected && (
          <View style={styles.details}>
            <Pressable
              accessibilityRole="link"
              onPress={() => router.push(`/activity/${selected.activityId}`)}
            >
              <Text style={styles.link}>{selected.name ?? data?.workoutName}</Text>
            </Pressable>
            <Text accessibilityLiveRegion="polite" style={styles.strong}>
              {`${formatSigned(selected.percent)}%`}
            </Text>
            <Text style={styles.secondary}>
              {formatDateMedium(selected.date)} · {formatDurationSeconds(selected.elapsedSeconds)}
            </Text>
            <Text style={styles.secondary}>First half · {halfSummary(selected.firstHalf)}</Text>
            <Text style={styles.secondary}>Second half · {halfSummary(selected.secondHalf)}</Text>
            <Text style={styles.secondary}>
              Power ·{" "}
              {selected.powerMeasurementKind === "direct"
                ? "Direct measurement"
                : "Measurement source unknown"}
              . Heart rate ·{" "}
              {selected.heartRateMeasurementKind === "direct"
                ? "Direct measurement"
                : "Measurement source unknown"}
              .
            </Text>
          </View>
        )}
      </>
    );
  }
  return (
    <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.strong}>
        {title}
      </Text>
      <Text style={styles.secondary}>
        How power relative to heart rate changed between halves of a ride.
      </Text>
      {data && error ? (
        <QueryStatePanel variant="error" message={getQueryErrorMessage(error)} />
      ) : null}
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: 16, padding: 16, gap: 10 },
  details: {
    borderColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    gap: 6,
  },
  strong: { color: colors.text, fontWeight: "600" },
  secondary: { color: colors.textSecondary, fontSize: 13 },
  link: { color: colors.accent, fontWeight: "600", textDecorationLine: "underline" },
});
