import {
  formatTodayPlanConfidence,
  formatTodayPlanFreshness,
  type TodayPlanResult,
} from "@dofek/scoring/today-plan";
import { StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../theme";
import { getQueryErrorMessage, QueryStatePanel } from "./QueryStatePanel";

export interface TodayPlanCardProps {
  plan?: TodayPlanResult | null;
  loading?: boolean;
  error?: unknown;
}

export function TodayPlanCard({ plan, loading = false, error }: TodayPlanCardProps) {
  if (loading && plan == null) {
    return (
      <View style={styles.card} accessibilityLabel="What matters today">
        <Text style={styles.sectionTitle}>WHAT MATTERS TODAY</Text>
        <QueryStatePanel variant="loading" minHeight={96} />
      </View>
    );
  }

  if (error != null && plan == null) {
    return (
      <View style={styles.card} accessibilityLabel="What matters today">
        <Text style={styles.sectionTitle}>WHAT MATTERS TODAY</Text>
        <QueryStatePanel
          variant="error"
          message={getQueryErrorMessage(error, "Today plan unavailable")}
          minHeight={96}
        />
      </View>
    );
  }

  if (plan == null) {
    return null;
  }

  const refreshWarning =
    error != null ? (
      <QueryStatePanel
        variant="error"
        message={getQueryErrorMessage(error, "Today plan unavailable")}
        minHeight={48}
      />
    ) : null;

  if (plan.status === "insufficient_data") {
    return (
      <View style={styles.card} accessibilityLabel="What matters today">
        <Text style={styles.sectionTitle}>WHAT MATTERS TODAY</Text>
        {refreshWarning}
        <Text style={styles.message}>{plan.message}</Text>
        <Text style={styles.meta}>{formatTodayPlanConfidence(plan.confidence)}</Text>
      </View>
    );
  }

  const freshness = formatTodayPlanFreshness(plan.freshness);

  return (
    <View style={styles.card} accessibilityLabel="What matters today">
      <View style={styles.headerRow}>
        <Text style={styles.sectionTitle}>WHAT MATTERS TODAY</Text>
        <Text style={styles.zone}>{plan.action.zone.toUpperCase()}</Text>
      </View>
      {refreshWarning}
      <Text style={styles.title}>{plan.action.title}</Text>
      <Text style={styles.summary}>{plan.action.summary}</Text>
      <View style={styles.factsRow}>
        {plan.supportingFacts.map((fact) => (
          <View key={fact.label} style={styles.fact}>
            <Text style={styles.factLabel}>{fact.label}</Text>
            <Text style={styles.factValue}>{fact.value}</Text>
          </View>
        ))}
      </View>
      <Text style={styles.meta}>{formatTodayPlanConfidence(plan.confidence)}</Text>
      {freshness != null ? <Text style={styles.meta}>{freshness}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.md,
    gap: spacing.sm,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.sm,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    letterSpacing: 0.5,
  },
  zone: {
    fontSize: 10,
    fontWeight: "700",
    color: colors.textSecondary,
  },
  title: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.text,
  },
  summary: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  message: {
    fontSize: 14,
    color: colors.text,
    lineHeight: 20,
  },
  factsRow: {
    flexDirection: "row",
    gap: spacing.md,
  },
  fact: {
    flex: 1,
    gap: 2,
  },
  factLabel: {
    fontSize: 11,
    color: colors.textTertiary,
  },
  factValue: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  meta: {
    fontSize: 11,
    color: colors.textSecondary,
  },
});
