import { formatDateMedium, formatDurationSeconds, formatNumber } from "@dofek/format/format";
import { providerLabel } from "@dofek/providers/providers";
import type { AppRouterOutputs } from "dofek-server/router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme";

type CyclingProgression = NonNullable<AppRouterOutputs["trainingProgression"]["cycling"]>;
type Ride = CyclingProgression["rides"][number];

function RideEvidence({ ride }: { ride: Ride }) {
  return (
    <View style={styles.ride}>
      <Text style={styles.rideTitle}>
        {ride.role === "selected" ? "Selected ride" : "Comparison ride"} ·{" "}
        {formatDateMedium(ride.date, { timeZone: "UTC" })}
      </Text>
      <Text style={styles.effort}>Session effort: {ride.sessionEffort}/10</Text>
      {ride.intervals.map((interval) => (
        <Text key={interval.index} style={styles.interval}>
          Work {interval.index}:{" "}
          {formatDurationSeconds(interval.workDurationSeconds, { precision: "second" })} at{" "}
          {formatNumber(interval.meanPowerWatts, 0)} W
          {interval.sourceProvider ? ` · ${providerLabel(interval.sourceProvider)}` : ""}
        </Text>
      ))}
      {ride.powerProvenance.providers.length > 0 ? (
        <Text style={styles.meta}>
          Measured power: {ride.powerProvenance.providers.map(providerLabel).join(", ")}
        </Text>
      ) : null}
    </View>
  );
}

/** Both comparable rides behind an accessible disclosure; effort stays ride-level. */
export function CyclingProgressionEvidence({ result }: { result: CyclingProgression }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={styles.toggle}
      >
        <Text style={styles.link}>See interval evidence</Text>
      </Pressable>
      {expanded ? (
        <View style={styles.list}>
          {result.rides.map((ride) => (
            <RideEvidence key={ride.activityId} ride={ride} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  toggle: { minHeight: 44, justifyContent: "center" },
  link: { color: colors.accent, fontSize: 13 },
  list: { gap: 12, marginTop: 8 },
  ride: { gap: 2 },
  rideTitle: { color: colors.text, fontSize: 13, fontWeight: "600" },
  effort: { color: colors.textSecondary, fontSize: 12 },
  interval: { color: colors.textSecondary, fontSize: 12 },
  meta: { color: colors.textTertiary, fontSize: 11 },
});
