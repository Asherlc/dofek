import {
  BODY_DECISION_CONTEXT_UNAVAILABLE,
  BODY_SOURCE_GUIDANCE,
  BODY_TREND_WEIGHT_DECISION_COPY,
  type BodyDecisionContextView,
  formatBodyDecisionProvenance,
  formatBodyDecisionVariation,
  formatSignedBodyResidual,
} from "@dofek/format/body-decision-context";
import { formatMeasurementText } from "@dofek/format/units";
import { providerLabel } from "@dofek/providers/providers";
import { StyleSheet, Text, View } from "react-native";
import { useUnitConverter } from "../lib/units";
import { colors } from "../theme";

interface BodyDecisionContextProps {
  context: BodyDecisionContextView | null;
}

export function BodyDecisionContext({ context }: BodyDecisionContextProps) {
  const units = useUnitConverter();
  const formatWeight = (weightKg: number) => formatMeasurementText(units.formatWeight(weightKg));
  const provenance = formatBodyDecisionProvenance(context?.latestMeasurement ?? null, {
    formatWeight,
    providerLabel,
  });
  const variation = context
    ? formatBodyDecisionVariation(context.variation, (residualKg) =>
        formatSignedBodyResidual(residualKg, formatWeight),
      )
    : null;

  return (
    <View
      accessibilityLabel="Trend Weight decision context"
      style={styles.container}
      testID="body-decision-context"
    >
      {context == null ? (
        <Text style={styles.text}>{BODY_DECISION_CONTEXT_UNAVAILABLE}</Text>
      ) : (
        <>
          {provenance != null && <Text style={styles.text}>{provenance}</Text>}
          <Text style={styles.text}>{BODY_TREND_WEIGHT_DECISION_COPY}</Text>
          <Text style={styles.text}>{variation}</Text>
          <Text style={styles.text}>{BODY_SOURCE_GUIDANCE}</Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: 1,
    borderTopColor: colors.surfaceSecondary,
    paddingTop: 10,
    gap: 6,
  },
  text: {
    color: colors.textTertiary,
    fontSize: 11,
    lineHeight: 17,
  },
});
