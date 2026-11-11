import { formatDateLong, formatDurationSeconds, formatNumber } from "@dofek/format/format";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { CyclingThresholdEvidence } from "../../server/src/contracts/cycling-threshold.ts";
import { colors } from "../theme";

export function CyclingThresholdDetails({ evidence }: { evidence: CyclingThresholdEvidence }) {
  const [expanded, setExpanded] = useState(false);
  if (evidence.unavailable_reason)
    return <Text style={{ color: colors.textSecondary }}>{evidence.unavailable_reason}</Text>;
  return (
    <View style={{ gap: 4 }}>
      {evidence.value != null && (
        <Text style={{ color: colors.textSecondary }}>
          Computed eFTP: {formatNumber(evidence.value, 0)} W
        </Text>
      )}
      {evidence.evidence_at != null &&
        evidence.evidence_duration_seconds != null &&
        evidence.evidence_power != null && (
          <Text style={{ color: colors.textSecondary }}>
            Evidence: {formatDurationSeconds(evidence.evidence_duration_seconds)} at{" "}
            {formatNumber(evidence.evidence_power, 0)} W on{" "}
            {formatDateLong(evidence.evidence_at, { timeZone: "UTC" })}.
          </Text>
        )}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Text style={{ color: colors.textSecondary }}>Estimate uncertainty</Text>
      </Pressable>
      {expanded && (
        <View style={{ gap: 4 }}>
          <Text style={{ color: colors.textSecondary }}>
            eFTP means estimated functional threshold power.
          </Text>
          <Text style={{ color: colors.textSecondary }}>{evidence.uncertainty.reason}</Text>
        </View>
      )}
    </View>
  );
}
