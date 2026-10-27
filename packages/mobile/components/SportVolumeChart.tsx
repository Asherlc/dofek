import {
  type SportVolumeMetric,
  sportVolumeMetrics,
  sportVolumeResultSchema,
} from "@dofek/training/sport-volume";
import { formatActivityTypeLabel } from "@dofek/training/training";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { isTransientNetworkError } from "../lib/query-client";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { useUnitConverter } from "../lib/units";
import { colors } from "../theme";
import { QueryStatePanel } from "./QueryStatePanel";
import { WeeklyVolumeBars } from "./WeeklyVolumeBars";

export function SportVolumeChart({ days, enabled }: { days: number | null; enabled: boolean }) {
  const [sport, setSport] = useState<string>();
  const [metric, setMetric] = useState<SportVolumeMetric>("time");
  const units = useUnitConverter();
  const query = trpc.training.sportVolume.useQuery(
    { days, sport, metric },
    { enabled, select: sportVolumeResultSchema.parse, placeholderData: (previous) => previous },
  );
  useEffect(() => {
    if (query.error && !isTransientNetworkError(query.error)) captureException(query.error);
  }, [query.error]);
  const data = query.data;
  const currentSport = sport ?? data?.sport ?? "";
  const metrics = sportVolumeMetrics(currentSport);
  const unit =
    data?.unit === "km"
      ? units.distanceLabel
      : data?.unit === "m"
        ? units.elevationLabel
        : (data?.unit ?? "min");
  const weeks = (data?.weeks ?? []).map((row) => ({
    ...row,
    value:
      row.value == null
        ? null
        : data?.unit === "km"
          ? units.convertDistance(row.value)
          : data?.unit === "m"
            ? units.convertElevation(row.value)
            : row.value,
  }));
  return (
    <View style={styles.card}>
      <Text style={styles.title}>
        {data?.sport ? `${formatActivityTypeLabel(data.sport)} Volume` : "Weekly Volume"}
      </Text>
      {data?.sports.length ? (
        <ScrollView horizontal accessibilityRole="radiogroup" accessibilityLabel="Volume sport">
          {data.sports.map((entry) => (
            <TouchableOpacity
              key={entry}
              accessibilityRole="radio"
              accessibilityLabel={formatActivityTypeLabel(entry)}
              accessibilityState={{ checked: currentSport === entry }}
              onPress={() => {
                setSport(entry);
                setMetric("time");
              }}
              style={styles.option}
            >
              <Text
                style={{ color: currentSport === entry ? colors.accent : colors.textSecondary }}
              >
                {formatActivityTypeLabel(entry)}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      ) : null}
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="Volume metric"
        style={styles.options}
      >
        {metrics.map((entry) => (
          <TouchableOpacity
            key={entry.key}
            accessibilityRole="radio"
            accessibilityLabel={entry.label}
            accessibilityState={{ checked: metric === entry.key }}
            onPress={() => {
              if (sport === undefined && data?.sport) setSport(data.sport);
              setMetric(entry.key);
            }}
            style={styles.option}
          >
            <Text style={{ color: metric === entry.key ? colors.accent : colors.textSecondary }}>
              {entry.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      {query.error ? <QueryStatePanel variant="error" message={query.error.message} /> : null}
      {query.isLoading && !data ? <QueryStatePanel variant="loading" /> : null}
      {query.isFetching && data ? (
        <Text accessibilityLiveRegion="polite" style={styles.text}>
          Updating volume…
        </Text>
      ) : null}
      {data ? (
        data.weeks.length ? (
          <>
            <Text style={styles.text}>{unit} per week</Text>
            <WeeklyVolumeBars weeks={weeks} unit={unit} />
          </>
        ) : (
          <Text style={styles.text}>No volume data for this period</Text>
        )
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  card: { padding: 16, marginBottom: 16, backgroundColor: colors.surface, borderRadius: 12 },
  title: { color: colors.text, fontWeight: "600", fontSize: 16 },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  option: { minHeight: 44, justifyContent: "center", paddingHorizontal: 8 },
  text: { color: colors.textSecondary },
});
