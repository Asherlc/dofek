import { useState, useMemo, useCallback } from "react";
import { LayoutAnimation, ScrollView, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import { formatNumber, formatSigned } from "@dofek/format/format";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";
import { statusColors } from "@dofek/scoring/colors";

// ── Types ──

type Confidence = "strong" | "emerging" | "early" | "insufficient";

interface Insight {
  id: string;
  type: "conditional" | "correlation" | "discovery";
  confidence: Confidence;
  metric: string;
  action: string;
  message: string;
  detail: string;
  whenTrue: { mean: number; n: number };
  whenFalse: { mean: number; n: number };
  effectSize: number;
  pValue: number;
  explanation?: string;
}

// ── Constants ──

const DAY_OPTIONS = [
  { label: "90d", value: 90 },
  { label: "180d", value: 180 },
  { label: "365d", value: 365 },
];

const CONFIDENCE_FILTERS = ["all", "strong", "emerging", "early"] as const;
type ConfidenceFilter = (typeof CONFIDENCE_FILTERS)[number];

const CONFIDENCE_COLORS: Record<Confidence, string> = {
  strong: statusColors.positive,
  emerging: statusColors.warning,
  early: "#636366",
  insufficient: "#636366",
};

const CATEGORY_EMOJIS: Record<string, string> = {
  Recovery: "\u2764\uFE0F",
  Sleep: "\uD83D\uDE34",
  Body: "\u2696\uFE0F",
  Performance: "\u26A1",
  Other: "\uD83D\uDCCA",
};

// ── Helpers ──

function categorize(metric: string): string {
  const m = metric.toLowerCase();
  if (m.includes("hr") || m.includes("hrv")) return "Recovery";
  if (m.includes("sleep") || m.includes("deep") || m.includes("rem") || m.includes("efficiency")) return "Sleep";
  if (m.includes("weight") || m.includes("body") || m.includes("bmi")) return "Body";
  if (m.includes("step") || m.includes("energy") || m.includes("vo2") || m.includes("power")) return "Performance";
  return "Other";
}

function formatPercentDifference(whenTrue: number, whenFalse: number): string {
  if (whenFalse === 0) return "--";
  const percentage = ((whenTrue - whenFalse) / Math.abs(whenFalse)) * 100;
  return `${formatSigned(percentage)}%`;
}

// ── Components ──

function DaySelector({ days, onChange }: { days: number; onChange: (d: number) => void }) {
  return (
    <View style={styles.selectorRow}>
      {DAY_OPTIONS.map((opt) => (
        <TouchableOpacity
          key={opt.value}
          style={[styles.selectorButton, days === opt.value && styles.selectorButtonActive]}
          onPress={() => onChange(opt.value)}
          activeOpacity={0.7}
        >
          <Text style={[styles.selectorText, days === opt.value && styles.selectorTextActive]}>
            {opt.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function ConfidenceFilterRow({
  selected,
  onChange,
}: {
  selected: ConfidenceFilter;
  onChange: (f: ConfidenceFilter) => void;
}) {
  return (
    <View style={styles.selectorRow}>
      {CONFIDENCE_FILTERS.map((f) => (
        <TouchableOpacity
          key={f}
          style={[styles.selectorButton, selected === f && styles.selectorButtonActive]}
          onPress={() => onChange(f)}
          activeOpacity={0.7}
        >
          <Text style={[styles.selectorText, selected === f && styles.selectorTextActive]}>
            {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function EffectSizeBar({ effectSize }: { effectSize: number }) {
  const absEffect = Math.min(Math.abs(effectSize), 2);
  const fillPercent = (absEffect / 2) * 100;
  const barColor = absEffect >= 0.8 ? statusColors.positive : absEffect >= 0.5 ? statusColors.warning : "#636366";

  return (
    <View style={styles.effectBarContainer}>
      <View style={styles.effectBarTrack}>
        <View style={[styles.effectBarFill, { width: `${fillPercent}%`, backgroundColor: barColor }]} />
      </View>
      <Text style={styles.effectBarLabel}>{formatNumber(Math.abs(effectSize), 2)}</Text>
    </View>
  );
}

function InsightCard({ insight }: { insight: Insight }) {
  const category = categorize(insight.metric);
  const emoji = CATEGORY_EMOJIS[category] ?? CATEGORY_EMOJIS.Other;
  const confidenceColor = CONFIDENCE_COLORS[insight.confidence];

  return (
    <View style={styles.insightCard}>
      {/* Header: emoji + message + confidence badge */}
      <View style={styles.insightHeader}>
        <View style={styles.insightTitleRow}>
          <Text style={styles.insightEmoji}>{emoji}</Text>
          <Text style={styles.insightMessage}>{insight.message}</Text>
        </View>
        <View style={[styles.confidenceBadge, { backgroundColor: `${confidenceColor}22` }]}>
          <Text style={[styles.confidenceBadgeText, { color: confidenceColor }]}>
            {insight.confidence}
          </Text>
        </View>
      </View>

      {/* Effect size bar */}
      <EffectSizeBar effectSize={insight.effectSize} />

      {/* Conditional comparison */}
      {insight.type === "conditional" && (
        <View style={styles.comparisonContainer}>
          <View style={styles.comparisonRow}>
            <Text style={styles.comparisonLabel}>With {insight.action}:</Text>
            <Text style={styles.comparisonValue}>
              {formatNumber(insight.whenTrue.mean)} (n={insight.whenTrue.n})
            </Text>
          </View>
          <View style={styles.comparisonRow}>
            <Text style={styles.comparisonLabel}>Without:</Text>
            <Text style={styles.comparisonValue}>
              {formatNumber(insight.whenFalse.mean)} (n={insight.whenFalse.n})
            </Text>
          </View>
          <Text style={styles.comparisonDiff}>
            {formatPercentDifference(insight.whenTrue.mean, insight.whenFalse.mean)} difference
          </Text>
        </View>
      )}

      {/* Detail text */}
      <Text style={styles.detailText}>{insight.detail}</Text>

      {/* Explanation */}
      {insight.explanation != null && (
        <Text style={styles.explanationText}>{insight.explanation}</Text>
      )}
    </View>
  );
}

// ── Main Screen ──

export default function InsightsScreen() {
  const [days, setDays] = useState(365);
  const [confidenceFilter, setConfidenceFilter] = useState<ConfidenceFilter>("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const { width } = useWindowDimensions();
  const isWide = width >= 600;

  const toggleCategory = useCallback((category: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  }, []);

  const query = trpc.insights.compute.useQuery({ days });
  const insights = query.data ?? [];

  // Filter by confidence
  const filtered = useMemo(() => {
    const filtered =
      confidenceFilter === "all"
        ? insights
        : insights.filter((i) => i.confidence === confidenceFilter);

    // Sort by absolute effect size descending
    return [...filtered].sort((a, b) => Math.abs(b.effectSize) - Math.abs(a.effectSize));
  }, [insights, confidenceFilter]);

  // Group by category
  const grouped = useMemo(() => {
    const groups: Record<string, Insight[]> = {};
    for (const insight of filtered) {
      const category = categorize(insight.metric);
      if (!groups[category]) groups[category] = [];
      groups[category].push(insight);
    }
    // Return in stable order
    const order = ["Recovery", "Sleep", "Body", "Performance", "Other"];
    return order
      .filter((cat) => groups[cat] != null && groups[cat].length > 0)
      .map((cat) => ({ category: cat, insights: groups[cat] ?? [] }));
  }, [filtered]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={[styles.content, isWide && styles.contentWide]}>
      {/* Days selector */}
      <Text style={styles.sectionLabel}>Time Range</Text>
      <DaySelector days={days} onChange={setDays} />

      {/* Confidence filter */}
      <Text style={styles.sectionLabel}>Confidence</Text>
      <ConfidenceFilterRow selected={confidenceFilter} onChange={setConfidenceFilter} />

      {/* Loading state */}
      {query.isLoading && (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>Analyzing your data...</Text>
        </View>
      )}

      {/* Empty states */}
      {!query.isLoading && insights.length === 0 && (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyEmoji}>{"\uD83D\uDCCA"}</Text>
          <Text style={styles.emptyTitle}>Not enough data</Text>
          <Text style={styles.emptyText}>
            Keep tracking and insights will appear as patterns emerge in your data.
          </Text>
        </View>
      )}

      {!query.isLoading && insights.length > 0 && filtered.length === 0 && (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyTitle}>No insights match filter</Text>
          <Text style={styles.emptyText}>
            Try a different confidence level or longer time range.
          </Text>
        </View>
      )}

      {/* Grouped insight cards */}
      {grouped.map(({ category, insights: categoryInsights }) => {
        const isCollapsed = collapsed.has(category);
        return (
          <View key={category} style={styles.categoryGroup}>
            <TouchableOpacity
              style={styles.categoryHeader}
              onPress={() => toggleCategory(category)}
              activeOpacity={0.7}
            >
              <Text style={styles.categoryTitle}>
                {CATEGORY_EMOJIS[category] ?? ""} {category}
              </Text>
              <View style={styles.categoryRight}>
                <View style={styles.countBadge}>
                  <Text style={styles.countBadgeText}>{categoryInsights.length}</Text>
                </View>
                <Text style={styles.chevron}>{isCollapsed ? "\u25B6" : "\u25BC"}</Text>
              </View>
            </TouchableOpacity>
            {!isCollapsed &&
              categoryInsights.map((insight) => (
                <InsightCard key={insight.id} insight={insight} />
              ))}
          </View>
        );
      })}
    </ScrollView>
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
    paddingBottom: 100,
    gap: 12,
  },
  contentWide: {
    maxWidth: 700,
    alignSelf: "center",
    width: "100%",
  },

  // Section labels
  sectionLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 4,
  },

  // Selector row (days + confidence)
  selectorRow: {
    flexDirection: "row",
    gap: 8,
  },
  selectorButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: colors.surface,
  },
  selectorButtonActive: {
    backgroundColor: colors.accent,
  },
  selectorText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  selectorTextActive: {
    color: colors.text,
  },

  // Category groups
  categoryGroup: {
    gap: 10,
    marginTop: 8,
  },
  categoryHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  categoryTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.text,
  },
  categoryRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  countBadge: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
    minWidth: 24,
    alignItems: "center",
  },
  countBadgeText: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.textSecondary,
  },
  chevron: {
    fontSize: 12,
    color: colors.textTertiary,
  },

  // Insight cards
  insightCard: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    gap: 10,
  },
  insightHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 8,
  },
  insightTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flex: 1,
  },
  insightEmoji: {
    fontSize: 16,
  },
  insightMessage: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.text,
    flex: 1,
  },

  // Confidence badge
  confidenceBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  confidenceBadgeText: {
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },

  // Effect size bar
  effectBarContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  effectBarTrack: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceSecondary,
    overflow: "hidden",
  },
  effectBarFill: {
    height: "100%",
    borderRadius: 3,
  },
  effectBarLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textTertiary,
    fontVariant: ["tabular-nums"],
    width: 36,
    textAlign: "right",
  },

  // Comparison (conditional type)
  comparisonContainer: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 10,
    padding: 10,
    gap: 4,
  },
  comparisonRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  comparisonLabel: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  comparisonValue: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  comparisonDiff: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.accent,
    marginTop: 2,
  },

  // Detail + explanation text
  detailText: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  explanationText: {
    fontSize: 13,
    color: colors.textTertiary,
    fontStyle: "italic",
    lineHeight: 18,
  },

  // Empty states
  emptyContainer: {
    alignItems: "center",
    paddingVertical: 48,
    gap: 8,
  },
  emptyEmoji: {
    fontSize: 40,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.text,
  },
  emptyText: {
    fontSize: 14,
    color: colors.textTertiary,
    textAlign: "center",
    maxWidth: 280,
  },
});
