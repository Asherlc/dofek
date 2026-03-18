import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { colors } from "../theme";
import { trpc } from "../lib/trpc";

const PARAM_LABELS: Record<string, { label: string; description: string }> = {
  ewma: {
    label: "Training Load Windows",
    description: "Days of training history used for fitness and fatigue",
  },
  readinessWeights: {
    label: "Readiness Score Weights",
    description: "How much each factor contributes to readiness",
  },
  sleepTarget: {
    label: "Sleep Target",
    description: "Sleep associated with your best recovery",
  },
  stressThresholds: {
    label: "Stress Sensitivity",
    description: "How HRV and resting HR map to stress levels",
  },
  trimpConstants: {
    label: "Heart Rate Effort Model",
    description: "How heart rate intensity translates to load",
  },
};

function formatMinutes(min: number): string {
  const hours = Math.floor(min / 60);
  const mins = min % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

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
    return <Text style={styles.errorText}>Failed to load personalization status</Text>;
  }

  const data = status.data;
  if (!data) return null;

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
            Updated {new Date(data.fittedAt).toLocaleDateString()}
          </Text>
        )}
      </View>

      {/* Parameter cards */}
      <ParamCard
        paramKey="ewma"
        personalized={data.parameters.ewma}
        value={`Fitness: ${data.effective.ewma.ctlDays}d, Fatigue: ${data.effective.ewma.atlDays}d`}
        defaultValue={`Fitness: ${data.defaults.ewma.ctlDays}d, Fatigue: ${data.defaults.ewma.atlDays}d`}
        quality={
          data.parameters.ewma
            ? `${data.parameters.ewma.sampleCount} days, r=${data.parameters.ewma.correlation}`
            : undefined
        }
      />

      <ParamCard
        paramKey="readinessWeights"
        personalized={data.parameters.readinessWeights}
        value={`HRV ${Math.round(data.effective.readinessWeights.hrv * 100)}%, RHR ${Math.round(data.effective.readinessWeights.restingHr * 100)}%, Sleep ${Math.round(data.effective.readinessWeights.sleep * 100)}%, Load ${Math.round(data.effective.readinessWeights.loadBalance * 100)}%`}
        defaultValue={`HRV ${Math.round(data.defaults.readinessWeights.hrv * 100)}%, RHR ${Math.round(data.defaults.readinessWeights.restingHr * 100)}%, Sleep ${Math.round(data.defaults.readinessWeights.sleep * 100)}%, Load ${Math.round(data.defaults.readinessWeights.loadBalance * 100)}%`}
        quality={
          data.parameters.readinessWeights
            ? `${data.parameters.readinessWeights.sampleCount} days, r=${data.parameters.readinessWeights.correlation}`
            : undefined
        }
      />

      <ParamCard
        paramKey="sleepTarget"
        personalized={data.parameters.sleepTarget}
        value={formatMinutes(data.effective.sleepTarget.minutes)}
        defaultValue={formatMinutes(data.defaults.sleepTarget.minutes)}
        quality={
          data.parameters.sleepTarget
            ? `${data.parameters.sleepTarget.sampleCount} qualifying nights`
            : undefined
        }
      />

      <ParamCard
        paramKey="stressThresholds"
        personalized={data.parameters.stressThresholds}
        value={`HRV: ${data.effective.stressThresholds.hrvThresholds.map((t) => t.toFixed(1)).join(", ")}`}
        defaultValue={`HRV: ${data.defaults.stressThresholds.hrvThresholds.map((t) => t.toFixed(1)).join(", ")}`}
        quality={
          data.parameters.stressThresholds
            ? `${data.parameters.stressThresholds.sampleCount} days`
            : undefined
        }
      />

      <ParamCard
        paramKey="trimpConstants"
        personalized={data.parameters.trimpConstants}
        value={`Factor: ${data.effective.trimpConstants.genderFactor}, Exp: ${data.effective.trimpConstants.exponent}`}
        defaultValue={`Factor: ${data.defaults.trimpConstants.genderFactor}, Exp: ${data.defaults.trimpConstants.exponent}`}
        quality={
          data.parameters.trimpConstants
            ? `${data.parameters.trimpConstants.sampleCount} activities, R²=${data.parameters.trimpConstants.r2}`
            : undefined
        }
      />

      {/* Actions */}
      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.refitButton}
          onPress={() => refitMutation.mutate()}
          disabled={refitMutation.isPending}
          activeOpacity={0.7}
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
  paramKey,
  personalized,
  value,
  defaultValue,
  quality,
}: {
  paramKey: string;
  personalized: unknown;
  value: string;
  defaultValue: string;
  quality?: string;
}) {
  const meta = PARAM_LABELS[paramKey];
  const isPersonalized = personalized !== null;

  return (
    <View style={styles.paramCard}>
      <View style={styles.paramHeader}>
        <Text style={styles.paramLabel}>{meta?.label ?? paramKey}</Text>
        <Text style={[styles.paramBadge, isPersonalized ? styles.badgeLearned : styles.badgeDefault]}>
          {isPersonalized ? "Learned" : "Default"}
        </Text>
      </View>
      <Text style={styles.paramDescription}>{meta?.description}</Text>
      <Text style={styles.paramValue}>{value}</Text>
      {isPersonalized && quality && <Text style={styles.paramQuality}>Quality: {quality}</Text>}
      {isPersonalized && <Text style={styles.paramDefault}>Default: {defaultValue}</Text>}
    </View>
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
    fontFamily: "Menlo",
    marginTop: 2,
  },
  paramQuality: {
    fontSize: 11,
    color: colors.textTertiary,
  },
  paramDefault: {
    fontSize: 11,
    color: colors.textTertiary,
    opacity: 0.7,
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
