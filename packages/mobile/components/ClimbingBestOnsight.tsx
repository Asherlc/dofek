import { formatDateMedium } from "@dofek/format/format";
import type {
  ClimbingBestOnsightCell,
  ClimbingBestOnsight as ClimbingBestOnsightData,
} from "@dofek/training/climbing-best-onsight";
import { climbingTypeOptions } from "@dofek/training/climbing-filters";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";
import { ProviderRecordDetail } from "./providers/provider-record-detail";
import { getQueryErrorMessage, QueryStatePanel } from "./QueryStatePanel";

const climbingTypeLabels = Object.fromEntries(climbingTypeOptions);

const settings = [
  { key: "gym", label: "Gym" },
  { key: "outdoor", label: "Outdoor" },
] as const;

interface ClimbingBestOnsightProps {
  data?: ClimbingBestOnsightData;
  error?: unknown;
  loading?: boolean;
}

export function ClimbingBestOnsight({ data, error, loading }: ClimbingBestOnsightProps) {
  const [selected, setSelected] = useState<ClimbingBestOnsightCell | null>(null);

  if (!data) {
    if (loading) {
      return <QueryStatePanel variant="loading" minHeight={120} />;
    }
    return error ? (
      <QueryStatePanel variant="error" message={getQueryErrorMessage(error)} minHeight={120} />
    ) : null;
  }

  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>
        Best recorded onsight
      </Text>
      <Text style={styles.period}>
        Past 12 months · {formatDateMedium(data.startDate, { timeZone: "UTC" })}–
        {formatDateMedium(data.endDate, { timeZone: "UTC" })}
      </Text>
      {error ? (
        <QueryStatePanel variant="error" message={getQueryErrorMessage(error)} minHeight={0} />
      ) : null}
      <View accessibilityRole="table" accessibilityLabel="Best recorded onsight">
        <View style={styles.row}>
          <Text style={[styles.cell, styles.headerCell]}>Climbing type</Text>
          {settings.map(({ label }) => (
            <Text key={label} style={[styles.cell, styles.headerCell]}>
              {label}
            </Text>
          ))}
        </View>
        {data.rows.map((row) => {
          const typeLabel = climbingTypeLabels[row.type];
          return (
            <View key={row.type} style={styles.row}>
              <Text style={[styles.cell, styles.rowHeader]}>{typeLabel}</Text>
              {settings.map(({ key, label }) => {
                const cell = row[key];
                return cell ? (
                  <Pressable
                    key={key}
                    accessibilityRole="button"
                    accessibilityLabel={`${cell.grade}, open ${label} ${typeLabel} send`}
                    onPress={() => setSelected(cell)}
                    style={styles.cell}
                  >
                    <Text style={styles.grade}>{cell.grade}</Text>
                  </Pressable>
                ) : (
                  <View
                    key={key}
                    accessible
                    accessibilityLabel={`No recorded ${label} ${typeLabel} onsight`}
                    style={styles.cell}
                  >
                    <Text style={styles.empty}>—</Text>
                  </View>
                );
              })}
            </View>
          );
        })}
      </View>
      {selected ? (
        <ProviderRecordDetail
          input={{
            providerId: selected.providerId,
            dataType: "climbingLogEntries",
            recordId: selected.recordId,
          }}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 8,
  },
  heading: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
  },
  period: {
    fontSize: 12,
    color: colors.textTertiary,
  },
  row: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surfaceSecondary,
  },
  cell: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  headerCell: {
    fontWeight: "600",
    color: colors.textSecondary,
  },
  rowHeader: {
    fontWeight: "500",
    color: colors.text,
  },
  grade: {
    color: colors.accent,
    textDecorationLine: "underline",
  },
  empty: {
    color: colors.textTertiary,
  },
});
