import { formatDateMedium } from "@dofek/format/format";
import { formatMeasurementText, type UnitConverter } from "@dofek/format/units";
import { providerLabel } from "@dofek/providers/providers";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { StrengthProgressionRow } from "../lib/training-progression";
import { colors } from "../theme";

/** Compact, dated recorded sets behind a disclosure, reused on Home and Strength. */
export function StrengthProgressionEvidence({
  row,
  units,
}: {
  row: StrengthProgressionRow;
  units: UnitConverter;
}) {
  const [expanded, setExpanded] = useState(false);
  const observations = [...row.evidence.observations].sort((left, right) =>
    right.date.localeCompare(left.date),
  );
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={styles.toggle}
      >
        <Text style={styles.link}>See recorded sets</Text>
      </Pressable>
      {expanded ? (
        <View style={styles.list}>
          {row.evidence.kind === "flat_benchmark" ? (
            <Text style={styles.text}>
              Estimated one-rep max range:{" "}
              {formatMeasurementText(units.formatWeight(row.evidence.observedRangeKg.min))} –{" "}
              {formatMeasurementText(units.formatWeight(row.evidence.observedRangeKg.max))}
            </Text>
          ) : null}
          {observations.map((observation) => (
            <View key={observation.sourceSetId} style={styles.row}>
              <Text style={styles.text}>
                {formatDateMedium(observation.date, { timeZone: "UTC" })} · {observation.reps} reps
                at {formatMeasurementText(units.formatWeight(observation.weightKg))}
                {observation.rpe !== null ? ` · Effort ${observation.rpe}/10` : null}
              </Text>
              <Text style={styles.meta}>{providerLabel(observation.provider)}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  toggle: { minHeight: 44, justifyContent: "center" },
  link: { color: colors.accent, fontSize: 13 },
  list: { gap: 6, marginTop: 6 },
  row: { gap: 2 },
  text: { color: colors.textSecondary, fontSize: 12 },
  meta: { color: colors.textTertiary, fontSize: 11 },
});
