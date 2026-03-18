import { useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import Svg, { Rect, Line, Text as SvgText } from "react-native-svg";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";
import { statusColors } from "@dofek/shared/colors";

// ── Types ──

const DAY_OPTIONS = [
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "180d", value: 180 },
  { label: "365d", value: 365 },
];

// ── Helpers ──

function formatNumber(value: number | null | undefined, decimals = 0): string {
  if (value == null || Number.isNaN(value)) return "--";
  return value.toFixed(decimals);
}

function nutrientBarColor(percentRda: number): string {
  if (percentRda >= 100) return statusColors.positive;
  if (percentRda >= 75) return statusColors.warning;
  if (percentRda >= 50) return statusColors.elevated;
  return statusColors.danger;
}

function proteinPerKgColor(value: number): string {
  if (value >= 1.6) return statusColors.positive;
  if (value >= 1.2) return statusColors.warning;
  return statusColors.danger;
}

function proteinPerKgRecommendation(value: number): string {
  if (value >= 1.6) return "Meeting recommended intake for active individuals (1.6+ g/kg)";
  if (value >= 1.2) return "Adequate protein, but below optimal for active individuals. Target 1.6+ g/kg.";
  return "Protein intake is low. Aim for at least 1.6 g/kg bodyweight for muscle maintenance.";
}

function LoadingText() {
  return <Text style={styles.loadingText}>Loading...</Text>;
}

// ── Main Screen ──

export default function NutritionAnalyticsScreen() {
  const [days, setDays] = useState(90);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Days selector */}
      <View style={styles.daysRow}>
        {DAY_OPTIONS.map((opt) => (
          <TouchableOpacity
            key={opt.value}
            style={[styles.dayButton, days === opt.value && styles.dayButtonActive]}
            onPress={() => setDays(opt.value)}
            activeOpacity={0.7}
          >
            <Text style={[styles.dayButtonText, days === opt.value && styles.dayButtonTextActive]}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <AdaptiveTdeeSection days={days} />
      <CaloricBalanceSection days={days} />
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
      <Text style={styles.cardTitle}>Adaptive TDEE Estimate</Text>
      {data == null ? (
        <Text style={styles.emptyText}>Not enough data</Text>
      ) : (
        <>
          <Text style={styles.bigValue}>{Math.round(data.estimatedTdee)} kcal/day</Text>
          <View style={styles.tdeeDetails}>
            <Text style={styles.cardSubtext}>
              Confidence: {Math.round(data.confidence)}%
            </Text>
            <Text style={styles.cardSubtext}>
              Based on {data.dataPoints} data points
            </Text>
          </View>
        </>
      )}
    </View>
  );
}

// ── Section 2: Caloric Balance ──

function CaloricBalanceSection({ days }: { days: number }) {
  const { width: screenWidth } = useWindowDimensions();
  const chartWidth = screenWidth - 64;

  const balance = trpc.nutritionAnalytics.caloricBalance.useQuery({ days });

  if (balance.isLoading) return <LoadingText />;

  const data = balance.data ?? [];
  if (data.length === 0) return null;

  const avgBalance =
    data.reduce((sum, d) => sum + d.balance, 0) / data.length;
  const latestRollingAvg = data[data.length - 1]?.rollingAvgBalance;

  // Chart calculations
  const maxAbs = Math.max(...data.map((d) => Math.abs(d.balance)), 1);
  const chartHeight = 120;
  const midY = chartHeight / 2;
  const barWidth = Math.max(2, (chartWidth - data.length * 1) / data.length);

  return (
    <View>
      <Text style={styles.sectionTitle}>Caloric Balance</Text>

      {/* Summary cards */}
      <View style={styles.summaryRow}>
        <View style={styles.summaryCard}>
          <Text style={styles.summaryLabel}>Average Daily Balance</Text>
          <Text
            style={[
              styles.summaryValue,
              { color: avgBalance >= 0 ? statusColors.positive : statusColors.danger },
            ]}
          >
            {avgBalance >= 0 ? "+" : ""}{Math.round(avgBalance)} kcal
          </Text>
        </View>
        <View style={styles.summaryCard}>
          <Text style={styles.summaryLabel}>Rolling Average</Text>
          <Text
            style={[
              styles.summaryValue,
              {
                color:
                  latestRollingAvg != null
                    ? latestRollingAvg >= 0
                      ? statusColors.positive
                      : statusColors.danger
                    : colors.text,
              },
            ]}
          >
            {latestRollingAvg != null
              ? `${latestRollingAvg >= 0 ? "+" : ""}${Math.round(latestRollingAvg)} kcal`
              : "--"}
          </Text>
        </View>
      </View>

      {/* Bar chart */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Daily Balance</Text>
        <View style={styles.chartContainer}>
          <Svg width={chartWidth} height={chartHeight}>
            {/* Zero line */}
            <Line
              x1={0}
              y1={midY}
              x2={chartWidth}
              y2={midY}
              stroke={colors.textTertiary}
              strokeWidth={StyleSheet.hairlineWidth}
            />
            {data.map((d, i) => {
              const barH = (Math.abs(d.balance) / maxAbs) * (midY - 4);
              const x = i * (barWidth + 1);
              const isPositive = d.balance >= 0;
              const y = isPositive ? midY - barH : midY;
              return (
                <Rect
                  key={d.date}
                  x={x}
                  y={y}
                  width={barWidth}
                  height={Math.max(barH, 1)}
                  rx={1}
                  fill={isPositive ? statusColors.positive : statusColors.danger}
                  opacity={0.8}
                />
              );
            })}
          </Svg>
        </View>
      </View>
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
            <Text style={styles.cardSubtext}>
              {proteinPerKgRecommendation(proteinPerKg)}
            </Text>
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

  const adequacy = trpc.nutritionAnalytics.micronutrientAdequacy.useQuery({ days });

  if (adequacy.isLoading) return <LoadingText />;

  const data = adequacy.data ?? [];
  if (data.length === 0) return null;

  // Sort by percentRda ascending (worst first)
  const sorted = [...data].sort((a, b) => a.percentRda - b.percentRda);

  return (
    <View>
      <Text style={styles.sectionTitle}>Micronutrient Adequacy</Text>
      <Text style={styles.sectionSubtext}>
        Average daily intake vs. Recommended Daily Allowance
      </Text>

      {sorted.map((nutrient) => {
        const pct = Math.min(nutrient.percentRda, 150);
        const barFraction = pct / 150;
        const barColor = nutrientBarColor(nutrient.percentRda);

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
                <View
                  style={[
                    styles.nutrientRdaMarker,
                    { left: `${(100 / 150) * 100}%` },
                  ]}
                />
              </View>
              <Text style={[styles.nutrientPct, { color: barColor }]}>
                {Math.round(nutrient.percentRda)}%
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

  // ── Summary row ──
  summaryRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 12,
  },
  summaryCard: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 12,
    alignItems: "center",
  },
  summaryLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.textSecondary,
    marginBottom: 4,
    textAlign: "center",
  },
  summaryValue: {
    fontSize: 18,
    fontWeight: "800",
    color: colors.text,
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

  // ── Charts ──
  chartContainer: {
    marginTop: 12,
    alignItems: "center",
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
