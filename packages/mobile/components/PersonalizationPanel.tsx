import {
  formatDateMedium,
  formatDurationMinutes,
  formatIntensity,
  formatStandardDeviation,
} from "@dofek/format/format";
import type { PersonalizationModelCard } from "dofek-server/types";
import { useEffect } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";

export function PersonalizationPanel() {
  const status = trpc.personalization.status.useQuery();
  const utils = trpc.useUtils();
  const invalidateAll = () => {
    utils.personalization.status.invalidate();
    // Invalidate queries that depend on personalized params
    utils.pmc.invalidate();
    utils.recovery.invalidate();
    utils.stress.invalidate();
  };
  const refitMutation = trpc.personalization.refit.useMutation({ onSuccess: invalidateAll });
  const resetMutation = trpc.personalization.reset.useMutation({ onSuccess: invalidateAll });

  if (status.isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color={colors.accent} size="small" />
      </View>
    );
  }

  if (status.error) {
    return <Text style={styles.errorText}>{status.error.message}</Text>;
  }

  const data = status.data;
  if (!data) return null;
  const resolvedModelCards = resolveModelCards(data.modelCards);
  if ("missingKey" in resolvedModelCards) {
    return <IncompleteModelCardsError missingKey={resolvedModelCards.missingKey} />;
  }
  const modelCards = resolvedModelCards.cards;

  function handleReset() {
    Alert.alert(
      "Reset Personalization",
      "This will revert all parameters to defaults. Your data is not affected.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset",
          style: "destructive",
          onPress: () => resetMutation.mutate(),
        },
      ],
    );
  }

  return (
    <View style={styles.container}>
      {/* Status header */}
      <View style={styles.statusRow}>
        <View style={styles.statusLeft}>
          <View
            style={[styles.statusDot, data.isPersonalized ? styles.dotActive : styles.dotInactive]}
          />
          <Text style={styles.statusText}>
            {data.isPersonalized ? "Personalized" : "Using defaults"}
          </Text>
        </View>
        {data.fittedAt && (
          <Text style={styles.statusDate}>
            Last refit attempt {formatDateMedium(data.fittedAt)}
          </Text>
        )}
      </View>

      {/* Parameter cards */}
      <ParamCard
        modelCard={modelCards.exponentialMovingAverage}
        value={`Fitness: ${data.effective.exponentialMovingAverage.chronicTrainingLoadDays}d, Fatigue: ${data.effective.exponentialMovingAverage.acuteTrainingLoadDays}d`}
        defaultValue={`Fitness: ${data.defaults.exponentialMovingAverage.chronicTrainingLoadDays}d, Fatigue: ${data.defaults.exponentialMovingAverage.acuteTrainingLoadDays}d`}
      />

      <ParamCard
        modelCard={modelCards.readinessWeights}
        value={`Heart Rate Variability ${formatIntensity(data.effective.readinessWeights.hrv * 100)}, Resting Heart Rate ${formatIntensity(data.effective.readinessWeights.restingHr * 100)}, Sleep ${formatIntensity(data.effective.readinessWeights.sleep * 100)}, Respiratory Rate ${formatIntensity(data.effective.readinessWeights.respiratoryRate * 100)}`}
        defaultValue={`Heart Rate Variability ${formatIntensity(data.defaults.readinessWeights.hrv * 100)}, Resting Heart Rate ${formatIntensity(data.defaults.readinessWeights.restingHr * 100)}, Sleep ${formatIntensity(data.defaults.readinessWeights.sleep * 100)}, Respiratory Rate ${formatIntensity(data.defaults.readinessWeights.respiratoryRate * 100)}`}
      />

      <ParamCard
        modelCard={modelCards.sleepTarget}
        value={formatDurationMinutes(data.effective.sleepTarget.minutes)}
        defaultValue={formatDurationMinutes(data.defaults.sleepTarget.minutes)}
      />

      <ParamCard
        modelCard={modelCards.stressThresholds}
        value={`Heart Rate Variability: ${data.effective.stressThresholds.hrvThresholds.map(formatStandardDeviation).join(", ")} · Resting Heart Rate: ${data.effective.stressThresholds.rhrThresholds.map(formatStandardDeviation).join(", ")}`}
        defaultValue={`Heart Rate Variability: ${data.defaults.stressThresholds.hrvThresholds.map(formatStandardDeviation).join(", ")} · Resting Heart Rate: ${data.defaults.stressThresholds.rhrThresholds.map(formatStandardDeviation).join(", ")}`}
      />

      <ParamCard
        modelCard={modelCards.trainingImpulseConstants}
        value={`Factor: ${data.effective.trainingImpulseConstants.genderFactor}, Exp: ${data.effective.trainingImpulseConstants.exponent}`}
        defaultValue={`Factor: ${data.defaults.trainingImpulseConstants.genderFactor}, Exp: ${data.defaults.trainingImpulseConstants.exponent}`}
      />

      {/* Actions */}
      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.refitButton}
          onPress={() => refitMutation.mutate()}
          disabled={refitMutation.isPending}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Refit Now"
          accessibilityState={{
            busy: refitMutation.isPending,
            disabled: refitMutation.isPending,
          }}
        >
          <Text style={[styles.refitText, refitMutation.isPending && styles.textDisabled]}>
            {refitMutation.isPending ? "Refitting..." : "Refit Now"}
          </Text>
        </TouchableOpacity>
        {data.isPersonalized && (
          <TouchableOpacity
            style={styles.resetButton}
            onPress={handleReset}
            disabled={resetMutation.isPending}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Reset to Defaults"
            accessibilityState={{
              busy: resetMutation.isPending,
              disabled: resetMutation.isPending,
            }}
          >
            <Text style={[styles.resetText, resetMutation.isPending && styles.textDisabled]}>
              Reset to Defaults
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

function ParamCard({
  modelCard,
  value,
  defaultValue,
}: {
  modelCard: PersonalizationModelCard;
  value: string;
  defaultValue: string;
}) {
  const isPersonalized = modelCard.status === "personalized";
  const lastFit = modelCard.lastSuccessfulFitAt
    ? formatDateMedium(modelCard.lastSuccessfulFitAt)
    : modelCard.lastFitSummary;

  return (
    <View style={styles.paramCard}>
      <View style={styles.paramHeader}>
        <Text
          style={styles.paramLabel}
          accessibilityRole="header"
          accessibilityLabel={`${modelCard.title} model evidence`}
        >
          {modelCard.title}
        </Text>
        <Text
          style={[styles.paramBadge, isPersonalized ? styles.badgeLearned : styles.badgeDefault]}
        >
          {isPersonalized ? "Learned" : "Default"}
        </Text>
      </View>
      <Text style={styles.paramDescription}>{modelCard.description}</Text>
      <Text style={styles.paramValue}>{value}</Text>
      {isPersonalized && <Text style={styles.paramDefault}>Default: {defaultValue}</Text>}
      <View style={styles.modelEvidence}>
        <EvidenceRow label="Last successful fit" value={lastFit} />
        <EvidenceRow label="Data window" value={modelCard.dataWindow} />
        <EvidenceRow label="Data sufficiency" value={modelCard.dataSufficiency} />
        <EvidenceRow label="Fit evidence" value={modelCard.fitEvidence} />
        <EvidenceRow label="Uncertainty" value={modelCard.uncertainty} />
        <Text style={styles.evidenceLabel}>Excluded data:</Text>
        {modelCard.excludedData.map((exclusion) => (
          <Text key={exclusion} style={styles.evidenceValue}>
            {"\u2022"} {exclusion}
          </Text>
        ))}
      </View>
    </View>
  );
}

function EvidenceRow({ label, value }: { label: string; value: string }) {
  return (
    <Text style={styles.evidenceValue}>
      <Text style={styles.evidenceLabel}>{label}: </Text>
      {value}
    </Text>
  );
}

type ModelCardsByKey = Record<PersonalizationModelCard["key"], PersonalizationModelCard>;

function resolveModelCards(
  modelCards: PersonalizationModelCard[],
): { cards: ModelCardsByKey } | { missingKey: PersonalizationModelCard["key"] } {
  const exponentialMovingAverage = modelCards.find(
    (card) => card.key === "exponentialMovingAverage",
  );
  if (!exponentialMovingAverage) return { missingKey: "exponentialMovingAverage" };
  const readinessWeights = modelCards.find((card) => card.key === "readinessWeights");
  if (!readinessWeights) return { missingKey: "readinessWeights" };
  const sleepTarget = modelCards.find((card) => card.key === "sleepTarget");
  if (!sleepTarget) return { missingKey: "sleepTarget" };
  const stressThresholds = modelCards.find((card) => card.key === "stressThresholds");
  if (!stressThresholds) return { missingKey: "stressThresholds" };
  const trainingImpulseConstants = modelCards.find(
    (card) => card.key === "trainingImpulseConstants",
  );
  if (!trainingImpulseConstants) return { missingKey: "trainingImpulseConstants" };

  return {
    cards: {
      exponentialMovingAverage,
      readinessWeights,
      sleepTarget,
      stressThresholds,
      trainingImpulseConstants,
    },
  };
}

function IncompleteModelCardsError({
  missingKey,
}: {
  missingKey: PersonalizationModelCard["key"];
}) {
  useEffect(() => {
    captureException(new Error(`Missing personalization model card: ${missingKey}`), {
      context: "personalization-model-cards",
      missingModelCard: missingKey,
    });
  }, [missingKey]);

  return (
    <Text style={styles.errorText}>
      Personalization model details are incomplete. Refresh and try again; contact support if this
      continues.
    </Text>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
  },
  loadingContainer: {
    paddingVertical: 24,
    alignItems: "center",
  },
  errorText: {
    fontSize: 14,
    color: colors.danger,
  },

  // Status
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  statusLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  dotActive: {
    backgroundColor: colors.positive,
  },
  dotInactive: {
    backgroundColor: colors.textTertiary,
  },
  statusText: {
    fontSize: 14,
    color: colors.text,
  },
  statusDate: {
    fontSize: 12,
    color: colors.textTertiary,
  },

  // Param cards
  paramCard: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 10,
    padding: 12,
    gap: 3,
  },
  paramHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  paramLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  paramBadge: {
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  badgeLearned: {
    color: colors.positive,
  },
  badgeDefault: {
    color: colors.textTertiary,
  },
  paramDescription: {
    fontSize: 12,
    color: colors.textTertiary,
  },
  paramValue: {
    fontSize: 14,
    color: colors.text,
    fontVariant: ["tabular-nums"],
    marginTop: 2,
  },
  paramDefault: {
    fontSize: 11,
    color: colors.textTertiary,
    opacity: 0.7,
  },
  modelEvidence: {
    gap: 3,
    paddingTop: 8,
  },
  evidenceLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  evidenceValue: {
    fontSize: 11,
    color: colors.textTertiary,
  },

  // Actions
  actions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  refitButton: {
    borderWidth: 1.5,
    borderColor: colors.positive,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  refitText: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.positive,
  },
  resetButton: {
    borderWidth: 1.5,
    borderColor: colors.surfaceSecondary,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  resetText: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  textDisabled: {
    opacity: 0.5,
  },
});
