import {
  formatTodayPlanConfidence,
  formatTodayPlanFreshness,
  type TodayPlanResult,
} from "@dofek/scoring/today-plan";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../theme";
import { getQueryErrorMessage, QueryStatePanel } from "./QueryStatePanel";

export interface TodayPlanCardProps {
  plan?: TodayPlanResult | null;
  loading?: boolean;
  error?: unknown;
}

export function TodayPlanCard({ plan, loading = false, error }: TodayPlanCardProps) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);

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
      <Pressable
        onPress={() => setEvidenceOpen((current) => !current)}
        accessibilityRole="button"
        accessibilityLabel="Why this?"
        accessibilityState={{ expanded: evidenceOpen }}
        style={styles.whyButton}
      >
        <Text style={styles.whyButtonText}>Why this?</Text>
      </Pressable>
      {evidenceOpen ? (
        <View style={styles.evidence} accessibilityLabel="Why this?">
          <Text style={styles.evidenceHeading}>Contributing observations</Text>
          <View style={styles.factsRow}>
            {plan.supportingFacts.map((fact) => (
              <View key={fact.label} style={styles.fact}>
                <Text style={styles.factLabel}>{fact.label}</Text>
                <Text style={styles.factValue}>{fact.value}</Text>
              </View>
            ))}
          </View>
          {plan.caveats.length > 0 ? (
            <View style={styles.caveats}>
              <Text style={styles.evidenceHeading}>Caveats</Text>
              {plan.caveats.map((caveat) => (
                <Text key={caveat} style={styles.caveat}>
                  • {caveat}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
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
  whyButton: {
    alignSelf: "flex-start",
    paddingVertical: 2,
  },
  whyButtonText: {
    fontSize: 13,
    color: colors.accent,
    textDecorationLine: "underline",
  },
  evidence: {
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.sm,
  },
  evidenceHeading: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.text,
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
  caveats: {
    gap: 4,
  },
  caveat: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 18,
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
