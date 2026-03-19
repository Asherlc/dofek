import { useState, useMemo } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import Svg, { Path, Line, Circle, Text as SvgText } from "react-native-svg";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";
import { statusColors } from "@dofek/shared/colors";

// ── Types ──

interface Target {
  id: string;
  label: string;
  unit: string;
  type: string;
}

interface FeatureImportance {
  name: string;
  linearImportance: number;
  treeImportance: number;
  linearCoefficient: number;
}

interface PredictionPoint {
  date: string;
  actual: number | null;
  linearPrediction: number;
  treePrediction: number;
}

interface Diagnostics {
  linearRSquared: number;
  treeRSquared: number;
  crossValidatedRSquared: number;
  sampleCount: number;
  featureCount: number;
  linearFallbackUsed?: boolean;
}

// ── Helpers ──

type TargetGroup = "Recovery" | "Fitness" | "Body";

function classifyTarget(id: string): TargetGroup {
  if (id.includes("hrv") || id.includes("resting_hr") || id.includes("sleep_efficiency")) {
    return "Recovery";
  }
  if (id.includes("cardio_power") || id.includes("strength_volume")) {
    return "Fitness";
  }
  if (id.includes("weight")) {
    return "Body";
  }
  // Default to Fitness for unclassified targets
  return "Fitness";
}

function humanizeFeatureName(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function sparklinePath(data: number[], width: number, height: number, padding: number): string {
  if (data.length < 2) return "";
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const usableWidth = width - padding * 2;
  const usableHeight = height - padding * 2;
  const stepX = usableWidth / (data.length - 1);
  return data
    .map((v, i) => {
      const x = padding + i * stepX;
      const y = padding + usableHeight - ((v - min) / range) * usableHeight;
      return `${i === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");
}

const GROUP_ORDER: TargetGroup[] = ["Recovery", "Fitness", "Body"];

// ── Main Screen ──

export default function PredictionsScreen() {
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const [days] = useState(90);
  const { width: screenWidth } = useWindowDimensions();
  const chartWidth = screenWidth - 64;

  const targetsQuery = trpc.predictions.targets.useQuery();
  const targets = targetsQuery.data ?? [];

  // Auto-select the first target when data arrives
  const activeTarget = selectedTarget ?? targets[0]?.id ?? null;

  const predictionQuery = trpc.predictions.predict.useQuery(
    { target: activeTarget as string, days },
    { enabled: !!activeTarget },
  );
  const prediction = predictionQuery.data;

  // Group targets by type
  const groupedTargets = useMemo(() => {
    const groups: Record<TargetGroup, Target[]> = { Recovery: [], Fitness: [], Body: [] };
    for (const target of targets) {
      const group = classifyTarget(target.id);
      groups[group].push(target);
    }
    return groups;
  }, [targets]);

  // Top 3 features by tree importance
  const topFeatures = useMemo(() => {
    if (!prediction?.featureImportances) return [];
    return [...prediction.featureImportances]
      .sort((a, b) => b.treeImportance - a.treeImportance)
      .slice(0, 3);
  }, [prediction?.featureImportances]);

  const maxImportance = topFeatures.length > 0 ? topFeatures[0].treeImportance : 1;

  // Prediction timeline data
  const actualValues = useMemo(() => {
    if (!prediction?.predictions) return [];
    return prediction.predictions
      .filter((p): p is PredictionPoint & { actual: number } => p.actual != null)
      .map((p) => p.actual);
  }, [prediction?.predictions]);

  const predictedValues = useMemo(() => {
    if (!prediction?.predictions) return [];
    return prediction.predictions.map(
      (p) => (p.linearPrediction + p.treePrediction) / 2,
    );
  }, [prediction?.predictions]);

  // Tomorrow's prediction
  const tomorrowAvg = prediction?.tomorrowPrediction
    ? (prediction.tomorrowPrediction.linear + prediction.tomorrowPrediction.tree) / 2
    : null;
  const linearFallbackUsed = prediction?.diagnostics.linearFallbackUsed === true;

  const modelsAgree = prediction?.tomorrowPrediction
    ? linearFallbackUsed
      ? false
      : Math.abs(prediction.tomorrowPrediction.linear - prediction.tomorrowPrediction.tree) /
          Math.max(
            Math.abs(prediction.tomorrowPrediction.linear),
            Math.abs(prediction.tomorrowPrediction.tree),
            1,
          ) <=
        0.1
    : false;

  const agreementLabel = linearFallbackUsed
    ? "Tree model only"
    : modelsAgree
      ? "Models agree"
      : "Models diverge";
  const agreementColor = linearFallbackUsed
    ? colors.textSecondary
    : modelsAgree
      ? statusColors.positive
      : statusColors.warning;

  // Diagnostics
  const diagnostics = prediction?.diagnostics;
  const crossValidatedPercent = diagnostics
    ? (diagnostics.crossValidatedRSquared * 100).toFixed(0)
    : null;
  const modelStrength = diagnostics
    ? diagnostics.crossValidatedRSquared > 0.5
      ? "Strong model"
      : diagnostics.crossValidatedRSquared > 0.3
        ? "Moderate model"
        : "Weak model"
    : null;

  const isLoading = targetsQuery.isLoading || (!!activeTarget && predictionQuery.isLoading);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Section 1: Target selector */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipScroller}
        contentContainerStyle={styles.chipScrollerContent}
      >
        {GROUP_ORDER.map((group) => {
          const groupTargets = groupedTargets[group];
          if (groupTargets.length === 0) return null;
          return (
            <View key={group} style={styles.chipGroup}>
              <Text style={styles.chipGroupLabel}>{group}</Text>
              <View style={styles.chipRow}>
                {groupTargets.map((target) => (
                  <TouchableOpacity
                    key={target.id}
                    style={[
                      styles.chip,
                      activeTarget === target.id && styles.chipActive,
                    ]}
                    onPress={() => setSelectedTarget(target.id)}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[
                        styles.chipText,
                        activeTarget === target.id && styles.chipTextActive,
                      ]}
                    >
                      {target.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          );
        })}
      </ScrollView>

      {isLoading ? (
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>Loading predictions...</Text>
        </View>
      ) : !prediction ? (
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>Select a target to see predictions</Text>
        </View>
      ) : (
        <>
          {/* Section 2: Tomorrow's Prediction */}
          {prediction.tomorrowPrediction && tomorrowAvg != null && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Tomorrow's Prediction</Text>
              <Text style={styles.bigValue}>
                {tomorrowAvg.toFixed(1)} {prediction.targetUnit}
              </Text>
              <View style={styles.agreementRow}>
                <View
                  style={[
                    styles.agreementDot,
                    { backgroundColor: agreementColor },
                  ]}
                />
                <Text
                  style={[
                    styles.agreementText,
                    { color: agreementColor },
                  ]}
                >
                  {agreementLabel}
                </Text>
              </View>
            </View>
          )}

          {/* Section 3: Key Factors */}
          {topFeatures.length > 0 && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Key Factors</Text>
              <View style={styles.factorsContainer}>
                {topFeatures.map((feature) => {
                  const directionSymbol =
                    feature.linearCoefficient > 0
                      ? "\u2191"
                      : feature.linearCoefficient < 0
                        ? "\u2193"
                        : "\u2022";
                  const directionColor =
                    feature.linearCoefficient > 0
                      ? statusColors.positive
                      : feature.linearCoefficient < 0
                        ? statusColors.danger
                        : colors.textSecondary;

                  return (
                    <View key={feature.name} style={styles.factorRow}>
                      <View style={styles.factorInfo}>
                        <Text style={styles.factorName}>
                          {humanizeFeatureName(feature.name)}
                        </Text>
                      </View>
                      <View style={styles.factorBarTrack}>
                        <View
                          style={[
                            styles.factorBarFill,
                            {
                              width: `${(feature.treeImportance / maxImportance) * 100}%`,
                              backgroundColor: colors.accent,
                            },
                          ]}
                        />
                      </View>
                      <Text style={[styles.directionArrow, { color: directionColor }]}>
                        {directionSymbol}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </View>
          )}

          {/* Section 4: Model Confidence */}
          {diagnostics && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Model Confidence</Text>
              <View style={styles.confidenceRow}>
                <Text style={styles.confidenceValue}>{crossValidatedPercent}%</Text>
                <Text
                  style={[
                    styles.confidenceLabel,
                    {
                      color:
                        diagnostics.crossValidatedRSquared > 0.5
                          ? statusColors.positive
                          : diagnostics.crossValidatedRSquared > 0.3
                            ? statusColors.warning
                            : statusColors.danger,
                    },
                  ]}
                >
                  {modelStrength}
                </Text>
              </View>
              <Text style={styles.confidenceSubtext}>Cross-validated R-squared</Text>
              <View style={styles.diagnosticsRow}>
                <View style={styles.diagnosticItem}>
                  <Text style={styles.diagnosticValue}>{diagnostics.sampleCount}</Text>
                  <Text style={styles.diagnosticLabel}>Samples</Text>
                </View>
                <View style={styles.diagnosticItem}>
                  <Text style={styles.diagnosticValue}>{diagnostics.featureCount}</Text>
                  <Text style={styles.diagnosticLabel}>Features</Text>
                </View>
              </View>
              {diagnostics.linearFallbackUsed && (
                <Text style={styles.fallbackNote}>
                  The linear model could not be fit for this target because the inputs overlap too
                  much. Impact ranking and confidence are based on the tree model.
                </Text>
              )}
            </View>
          )}

          {/* Section 5: Prediction Timeline */}
          {prediction.predictions.length > 1 && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Prediction Timeline</Text>
              <View style={styles.chartContainer}>
                <TimelineChart
                  actualValues={actualValues}
                  predictedValues={predictedValues}
                  width={chartWidth}
                  height={160}
                />
              </View>
              <View style={styles.legendRow}>
                <View style={styles.legendItem}>
                  <View style={[styles.legendLine, { backgroundColor: colors.text }]} />
                  <Text style={styles.legendText}>Actual</Text>
                </View>
                <View style={styles.legendItem}>
                  <View style={[styles.legendLine, { backgroundColor: colors.blue }]} />
                  <Text style={styles.legendText}>Predicted</Text>
                </View>
              </View>
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

// ── Timeline Chart Component ──

function TimelineChart({
  actualValues,
  predictedValues,
  width,
  height,
}: {
  actualValues: number[];
  predictedValues: number[];
  width: number;
  height: number;
}) {
  const padding = 16;
  const allValues = [...actualValues, ...predictedValues].filter((v) => !Number.isNaN(v));
  if (allValues.length < 2) return null;

  const actualPath = sparklinePath(actualValues, width, height, padding);
  const predictedPath = sparklinePath(predictedValues, width, height, padding);

  return (
    <Svg width={width} height={height}>
      {/* Grid lines */}
      <Line x1={padding} y1={padding} x2={padding} y2={height - padding} stroke={colors.surfaceSecondary} strokeWidth={1} />
      <Line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke={colors.surfaceSecondary} strokeWidth={1} />

      {/* Predicted line (below actual) */}
      {predictedPath ? (
        <Path d={predictedPath} stroke={colors.blue} strokeWidth={2} fill="none" opacity={0.8} />
      ) : null}

      {/* Actual line */}
      {actualPath ? (
        <Path d={actualPath} stroke={colors.text} strokeWidth={2} fill="none" />
      ) : null}
    </Svg>
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
    gap: 16,
  },
  loadingContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 80,
  },
  loadingText: {
    fontSize: 16,
    color: colors.textTertiary,
  },

  // ── Chip selector ──
  chipScroller: {
    flexGrow: 0,
  },
  chipScrollerContent: {
    gap: 16,
    paddingVertical: 4,
  },
  chipGroup: {
    gap: 6,
  },
  chipGroupLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.textTertiary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  chipRow: {
    flexDirection: "row",
    gap: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: colors.surface,
  },
  chipActive: {
    backgroundColor: colors.accent,
  },
  chipText: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  chipTextActive: {
    color: colors.text,
  },

  // ── Cards ──
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    gap: 8,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  bigValue: {
    fontSize: 36,
    fontWeight: "800",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },

  // ── Tomorrow's prediction ──
  agreementRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  agreementDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  agreementText: {
    fontSize: 14,
    fontWeight: "600",
  },

  // ── Key factors ──
  factorsContainer: {
    gap: 12,
    marginTop: 4,
  },
  factorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  factorInfo: {
    width: 120,
  },
  factorName: {
    fontSize: 13,
    color: colors.text,
    fontWeight: "500",
  },
  factorBarTrack: {
    flex: 1,
    height: 8,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 4,
    overflow: "hidden",
  },
  factorBarFill: {
    height: "100%",
    borderRadius: 4,
  },
  directionArrow: {
    fontSize: 18,
    fontWeight: "700",
    width: 24,
    textAlign: "center",
  },

  // ── Model confidence ──
  confidenceRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 10,
  },
  confidenceValue: {
    fontSize: 32,
    fontWeight: "800",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  confidenceLabel: {
    fontSize: 16,
    fontWeight: "600",
  },
  confidenceSubtext: {
    fontSize: 12,
    color: colors.textTertiary,
  },
  diagnosticsRow: {
    flexDirection: "row",
    gap: 24,
    marginTop: 8,
  },
  diagnosticItem: {
    alignItems: "center",
  },
  diagnosticValue: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  diagnosticLabel: {
    fontSize: 11,
    color: colors.textSecondary,
  },
  fallbackNote: {
    marginTop: 10,
    fontSize: 11,
    lineHeight: 16,
    color: colors.textTertiary,
  },

  // ── Timeline chart ──
  chartContainer: {
    alignItems: "center",
    marginTop: 4,
  },
  legendRow: {
    flexDirection: "row",
    gap: 16,
    justifyContent: "center",
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  legendLine: {
    width: 16,
    height: 3,
    borderRadius: 1.5,
  },
  legendText: {
    fontSize: 12,
    color: colors.textSecondary,
  },
});
