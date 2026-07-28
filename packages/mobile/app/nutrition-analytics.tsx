import { formatCalories, formatNumber, formatNutritionNumber } from "@dofek/format/format";
import { operationalStatusColors, statusColors } from "@dofek/scoring/colors";
import { useState } from "react";
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { ChartTitleWithTooltip } from "../components/ChartTitleWithTooltip";
import { trpc } from "../lib/trpc";
import { useRefresh } from "../lib/useRefresh";
import { colors } from "../theme";

// ── Types ──

const DAY_OPTIONS = [
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "180d", value: 180 },
  { label: "365d", value: 365 },
];

// ── Helpers ──

function nutrientBarColor(
  safetyStatus:
    | "at_or_above_upper_limit"
    | "upper_limit_not_evaluable"
    | "within_upper_limit"
    | "no_upper_limit_in_ruleset",
): string {
  if (safetyStatus === "at_or_above_upper_limit") {
    return operationalStatusColors.danger.indicator;
  }
  if (safetyStatus === "upper_limit_not_evaluable") {
    return operationalStatusColors.warning.indicator;
  }
  return operationalStatusColors.info.indicator;
}

function proteinPerKgColor(value: number): string {
  if (value >= 1.6) return statusColors.positive;
  if (value >= 1.2) return statusColors.warning;
  return statusColors.danger;
}

function proteinPerKgRecommendation(value: number): string {
  if (value >= 1.6) return "Meeting recommended intake for active individuals (1.6+ g/kg)";
  if (value >= 1.2)
    return "Adequate protein, but below optimal for active individuals. Target 1.6+ g/kg.";
  return "Protein intake is low. Aim for at least 1.6 g/kg bodyweight for muscle maintenance.";
}

function LoadingText() {
  return <Text style={styles.loadingText}>Loading...</Text>;
}

// ── Main Screen ──

export default function NutritionAnalyticsScreen() {
  const [days, setDays] = useState(90);
  const { refreshing, onRefresh } = useRefresh();

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.textSecondary}
        />
      }
    >
      {/* Days selector */}
      <View style={styles.daysRow}>
        {DAY_OPTIONS.map((opt) => (
          <TouchableOpacity
            key={opt.value}
            style={[styles.dayButton, days === opt.value && styles.dayButtonActive]}
            onPress={() => setDays(opt.value)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={opt.label}
            accessibilityState={{ selected: days === opt.value }}
          >
            <Text style={[styles.dayButtonText, days === opt.value && styles.dayButtonTextActive]}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <AdaptiveTdeeSection days={days} />
      <MacroSummarySection days={days} />
      <MicronutrientAdequacySection days={days} />
    </ScrollView>
  );
}

// ── Section 1: Adaptive TDEE ──

function AdaptiveTdeeSection({ days }: { days: number }) {
  const tdee = trpc.nutritionAnalytics.adaptiveTdee.useQuery({ days: Math.max(days, 90) });

  if (tdee.isLoading) return <LoadingText />;

  const data = tdee.data;

  return (
    <View style={styles.card}>
      <ChartTitleWithTooltip
        title="Adaptive Total Daily Energy Expenditure (TDEE) Estimate"
        description="Estimated from logged calorie intake and observed body-weight change."
        textStyle={styles.cardTitle}
      />
      {data == null || data.estimatedTdee == null ? (
        <Text style={styles.emptyText}>
          Not enough data to estimate Total Daily Energy Expenditure (TDEE)
        </Text>
      ) : (
        <>
          <Text style={styles.bigValue}>{formatCalories(data.estimatedTdee)}/day</Text>
          <View style={styles.tdeeDetails}>
            <Text style={styles.cardSubtext}>
              Confidence: {formatNutritionNumber(data.confidence)}%
            </Text>
            <Text style={styles.cardSubtext}>Based on {data.dataPoints} data points</Text>
          </View>
        </>
      )}
    </View>
  );
}

// ── Section 3: Macro Summary ──

function MacroSummarySection({ days }: { days: number }) {
  const macros = trpc.nutritionAnalytics.macroRatios.useQuery({ days });

  if (macros.isLoading) return <LoadingText />;

  const data = macros.data ?? [];
  if (data.length === 0) return null;

  const latest = data[data.length - 1];
  const proteinPerKg = latest?.proteinPerKg;

  return (
    <View>
      <Text style={styles.sectionTitle}>Protein Intake</Text>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Protein per kg Bodyweight</Text>
        {proteinPerKg != null ? (
          <>
            <Text style={[styles.bigValue, { color: proteinPerKgColor(proteinPerKg) }]}>
              {formatNumber(proteinPerKg, 1)} g/kg
            </Text>
            <Text style={styles.cardSubtext}>{proteinPerKgRecommendation(proteinPerKg)}</Text>
          </>
        ) : (
          <Text style={styles.emptyText}>No data available</Text>
        )}
      </View>
    </View>
  );
}

// ── Section 4: Micronutrient Adequacy ──

function MicronutrientAdequacySection({ days }: { days: number }) {
  const { width: screenWidth } = useWindowDimensions();
  const barMaxWidth = screenWidth - 160;

  const adequacy = trpc.nutritionAnalytics.micronutrientAdequacyV2.useQuery({ days });

  if (adequacy.isLoading) return <LoadingText />;

  const data = (adequacy.data?.nutrients ?? []).filter(
    (nutrient) => nutrient.adequacy != null && nutrient.adequacy.status !== "not_evaluable",
  );
  if (data.length === 0) return null;

  const sorted = [...data].sort((a, b) => {
    const first = a.adequacy?.status !== "not_evaluable" ? a.adequacy?.percentDailyValue : 0;
    const second = b.adequacy?.status !== "not_evaluable" ? b.adequacy?.percentDailyValue : 0;
    return (first ?? 0) - (second ?? 0);
  });

  return (
    <View>
      <ChartTitleWithTooltip
        title="Micronutrient Adequacy"
        description="This chart compares your average micronutrient intake against recommended daily targets."
        textStyle={styles.sectionTitle}
      />
      <Text style={styles.sectionSubtext}>
        Average over recorded days vs. U.S. Food and Drug Administration (FDA) Daily Value; not a
        personalized deficiency or safety assessment
      </Text>

      {sorted.map((nutrient) => {
        const percentDailyValue =
          nutrient.adequacy?.status !== "not_evaluable"
            ? (nutrient.adequacy?.percentDailyValue ?? 0)
            : 0;
        const percentage = Math.min(percentDailyValue, 150);
        const barFraction = percentage / 150;
        const barColor = nutrientBarColor(nutrient.safetyStatus);

        return (
          <View key={nutrient.nutrient} style={styles.nutrientRow}>
            <View style={styles.nutrientLabelContainer}>
              <Text style={styles.nutrientLabel} numberOfLines={1}>
                {nutrient.nutrient}
              </Text>
            </View>
            <View style={styles.nutrientBarContainer}>
              <View style={[styles.nutrientBarTrack, { width: barMaxWidth }]}>
                <View
                  style={[
                    styles.nutrientBarFill,
                    {
                      width: `${barFraction * 100}%`,
                      backgroundColor: barColor,
                    },
                  ]}
                />
                {/* 100% marker */}
                <View style={[styles.nutrientRdaMarker, { left: `${(100 / 150) * 100}%` }]} />
              </View>
              <Text style={[styles.nutrientPct, { color: barColor }]}>
                {formatNutritionNumber(percentDailyValue)}%
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

// ── Styles ──

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: 16,
    paddingBottom: 40,
  },

  // ── Days selector ──
  daysRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 16,
  },
  dayButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: colors.surface,
  },
  dayButtonActive: {
    backgroundColor: colors.accent,
  },
  dayButtonText: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  dayButtonTextActive: {
    color: colors.text,
  },

  // ── Sections ──
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.text,
    marginBottom: 12,
    marginTop: 16,
  },
  sectionSubtext: {
    fontSize: 12,
    color: colors.textSecondary,
    marginBottom: 12,
    marginTop: -8,
  },

  // ── Cards ──
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.text,
    marginBottom: 4,
  },
  cardSubtext: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 4,
  },
  bigValue: {
    fontSize: 28,
    fontWeight: "800",
    color: colors.text,
  },

  // ── TDEE ──
  tdeeDetails: {
    marginTop: 4,
    gap: 2,
  },

  // ── Nutrient bars ──
  nutrientRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
  },
  nutrientLabelContainer: {
    width: 90,
  },
  nutrientLabel: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  nutrientBarContainer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  nutrientBarTrack: {
    height: 12,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 6,
    overflow: "hidden",
    position: "relative",
  },
  nutrientBarFill: {
    height: "100%",
    borderRadius: 6,
  },
  nutrientRdaMarker: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: colors.text,
    opacity: 0.4,
  },
  nutrientPct: {
    fontSize: 12,
    fontWeight: "700",
    width: 40,
    textAlign: "right",
  },

  // ── Status text ──
  loadingText: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: "center",
    paddingVertical: 32,
  },
  emptyText: {
    fontSize: 14,
    color: colors.textTertiary,
    textAlign: "center",
    paddingVertical: 16,
  },
});
