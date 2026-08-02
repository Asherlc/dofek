import { formatDateMedium } from "@dofek/format/format";
import {
  ACTIVITY_HEATMAP_BANDS,
  ACTIVITY_HEATMAP_DESCRIPTION,
  ACTIVITY_HEATMAP_MEASURE_LABEL,
  ACTIVITY_HEATMAP_UNIT_LABEL,
  type ActivityHeatmapBandId,
} from "@dofek/training/activity-heatmap";
import type { CalendarDay } from "dofek-server/types";
import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors, radius, spacing } from "../theme";

interface ActivityHeatmapProps {
  data: CalendarDay[];
}

const colorsByBand: Record<ActivityHeatmapBandId, string> = {
  none: colors.surfaceSecondary,
  light: "#064e3b",
  moderate: "#059669",
  high: colors.positive,
  very_high: "#86efac",
};

export function ActivityHeatmap({ data }: ActivityHeatmapProps) {
  const [selectedDate, setSelectedDate] = useState(data.at(-1)?.date ?? "");
  const selectedDay = data.find((day) => day.date === selectedDate) ?? data.at(-1);

  if (data.length === 0) {
    return (
      <View style={styles.panel} accessible={true} accessibilityLabel="No training data">
        <Text style={styles.emptyText}>No training data</Text>
      </View>
    );
  }

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>
        {ACTIVITY_HEATMAP_MEASURE_LABEL} ({ACTIVITY_HEATMAP_UNIT_LABEL})
      </Text>
      <Text style={styles.description}>{ACTIVITY_HEATMAP_DESCRIPTION}</Text>
      <View accessible={true} accessibilityLabel="Training time legend" style={styles.legend}>
        {ACTIVITY_HEATMAP_BANDS.map((band) => (
          <View key={band.id} style={styles.legendItem}>
            <View
              accessibilityLabel={band.label}
              style={[styles.legendSwatch, { backgroundColor: colorsByBand[band.id] }]}
            />
            <View style={styles.legendCopy}>
              <Text style={styles.legendLabel}>{band.label}</Text>
              <Text style={styles.legendMeaning}>{band.meaning}</Text>
            </View>
          </View>
        ))}
      </View>
      <Text style={styles.daysLabel}>Recorded days</Text>
      <View style={styles.dayGrid}>
        {data.map((day) => (
          <TouchableOpacity
            key={day.date}
            accessibilityHint="Double-tap to view daily training details."
            accessibilityLabel={`${formatDateMedium(day.date)}, ${day.totalMinutes} minutes of training time. ${day.trainingTimeMeaning}`}
            accessibilityRole="button"
            accessibilityState={{ selected: day.date === selectedDay?.date }}
            onPress={() => setSelectedDate(day.date)}
            style={[
              styles.dayCell,
              { backgroundColor: colorsByBand[day.trainingTimeBand] },
              day.date === selectedDay?.date ? styles.dayCellSelected : null,
            ]}
          >
            <Text style={styles.dayDate}>{formatDateMedium(day.date)}</Text>
            <Text style={styles.dayMinutes}>{day.totalMinutes} min</Text>
          </TouchableOpacity>
        ))}
      </View>
      {selectedDay ? (
        <View accessibilityLiveRegion="polite" accessible={true} style={styles.details}>
          <Text style={styles.detailsTitle}>{formatDateMedium(selectedDay.date)}</Text>
          <Text style={styles.detailsValue}>
            {selectedDay.totalMinutes} minutes of training time
          </Text>
          <Text style={styles.detailsMeaning}>{selectedDay.trainingTimeMeaning}</Text>
          <Text style={styles.detailsMeta}>{selectedDay.activityCount} recorded activities.</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    gap: spacing.sm,
    padding: spacing.md,
  },
  title: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
  },
  description: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  legend: {
    gap: spacing.xs,
  },
  legendItem: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing.xs,
  },
  legendSwatch: {
    borderColor: colors.textTertiary,
    borderRadius: 3,
    borderWidth: 1,
    height: 14,
    marginTop: 2,
    width: 14,
  },
  legendCopy: {
    flex: 1,
    gap: 2,
  },
  legendLabel: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "700",
  },
  legendMeaning: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  daysLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
    marginTop: spacing.xs,
    textTransform: "uppercase",
  },
  dayGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
  },
  dayCell: {
    borderRadius: radius.md,
    minWidth: 92,
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.sm,
  },
  dayCellSelected: {
    borderColor: colors.text,
    borderWidth: 2,
  },
  dayDate: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "600",
  },
  dayMinutes: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
    marginTop: 2,
  },
  details: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    gap: 2,
    padding: spacing.sm,
  },
  detailsTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "700",
  },
  detailsValue: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700",
  },
  detailsMeaning: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  detailsMeta: {
    color: colors.textTertiary,
    fontSize: 12,
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: 13,
  },
});
