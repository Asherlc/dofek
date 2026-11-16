import { formatDateLong, formatNumber } from "@dofek/format/format";
import { Text, View } from "react-native";
import type { CyclingThresholdEvidence } from "../../server/src/contracts/cycling-threshold.ts";
import { colors } from "../theme";

export function CyclingThresholdDetails({ evidence }: { evidence: CyclingThresholdEvidence }) {
  if (evidence.method !== "configured" || evidence.value == null) return null;
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: colors.textSecondary }}>
        FTP: {formatNumber(evidence.value, 0)} W
        {evidence.effective_from ? ` · effective ${formatDateLong(evidence.effective_from)}` : ""}
      </Text>
    </View>
  );
}
