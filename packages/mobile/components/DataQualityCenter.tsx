import {
  type DataQualityCheck,
  type DataQualityCheckKey,
  type DataQualityOverview,
  getDataQualityDetailItems,
  getDataQualityReview,
  getDataQualityStatusLabel,
} from "@dofek/format/data-quality";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radius, spacing } from "../theme";

interface DataQualityCenterProps {
  data?: DataQualityOverview;
  loading?: boolean;
  onReview?: (key: DataQualityCheckKey) => void;
}

function statusStyle(status: DataQualityCheck["status"]) {
  switch (status) {
    case "attention":
      return styles.attention;
    case "informational":
      return styles.informational;
    case "healthy":
      return styles.healthy;
  }
}

function DataQualityCheckCard({
  qualityCheck,
  onReview,
}: {
  qualityCheck: DataQualityCheck;
  onReview?: (key: DataQualityCheckKey) => void;
}) {
  const review = getDataQualityReview(qualityCheck.key);
  return (
    <View style={styles.checkCard}>
      <View style={styles.checkHeader}>
        <View style={styles.checkTitleBlock}>
          <Text style={styles.checkTitle}>{qualityCheck.title}</Text>
          <Text style={styles.message}>{qualityCheck.message}</Text>
        </View>
        <Text style={[styles.status, statusStyle(qualityCheck.status)]}>
          {getDataQualityStatusLabel(qualityCheck.status)}
        </Text>
      </View>
      {qualityCheck.count > 0 ? (
        <Text style={styles.count}>
          {qualityCheck.count} {qualityCheck.label.toLowerCase()}
        </Text>
      ) : null}
      {qualityCheck.details.length > 0 ? (
        <View style={styles.details}>
          {getDataQualityDetailItems(qualityCheck.key, qualityCheck.details).map((detail) => (
            <Text key={detail.key} style={styles.detail}>
              {detail.text}
            </Text>
          ))}
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={review.label}
        onPress={() => onReview?.(qualityCheck.key)}
        style={({ pressed }) => [styles.reviewButton, pressed && styles.reviewButtonPressed]}
      >
        <Text style={styles.reviewText}>{review.label}</Text>
      </Pressable>
    </View>
  );
}

export function DataQualityCenter({ data, loading = false, onReview }: DataQualityCenterProps) {
  if (loading) {
    return (
      <View
        style={styles.card}
        accessibilityLabel="Loading data quality"
        accessibilityLiveRegion="polite"
      >
        <Text style={styles.message}>Loading data quality…</Text>
      </View>
    );
  }

  if (!data) {
    return (
      <View style={styles.card} accessibilityRole="summary">
        <Text style={styles.title}>Data quality</Text>
        <Text style={styles.message}>No data quality checks are available yet.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container} accessibilityRole="summary">
      <View style={styles.card}>
        <View style={styles.checkHeader}>
          <View style={styles.checkTitleBlock}>
            <Text style={styles.title}>Data quality</Text>
            <Text style={styles.message}>{data.overallMessage}</Text>
          </View>
          <Text
            style={[
              styles.status,
              data.overallStatus === "attention" ? styles.attention : styles.healthy,
            ]}
          >
            {getDataQualityStatusLabel(data.overallStatus)}
          </Text>
        </View>
        <Text style={styles.window}>
          Last {data.window.days} days · through {data.window.endDate}
        </Text>
      </View>
      <View style={styles.checks}>
        {data.checks.map((qualityCheck) => (
          <DataQualityCheckCard
            key={qualityCheck.key}
            qualityCheck={qualityCheck}
            onReview={onReview}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.md },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.md,
  },
  checks: { gap: spacing.sm },
  checkCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.md,
  },
  checkHeader: { alignItems: "flex-start", flexDirection: "row", gap: spacing.sm },
  checkTitleBlock: { flex: 1, gap: spacing.xs },
  title: { color: colors.text, fontSize: 18, fontWeight: "700" },
  checkTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  message: { color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  window: { color: colors.textTertiary, fontSize: 12 },
  status: {
    borderRadius: radius.full,
    borderWidth: 1,
    fontSize: 11,
    fontWeight: "600",
    overflow: "hidden",
    paddingHorizontal: spacing.xs,
    paddingVertical: 3,
  },
  healthy: {
    backgroundColor: "rgba(22, 163, 74, 0.12)",
    borderColor: "rgba(22, 163, 74, 0.4)",
    color: "#15803d",
  },
  attention: {
    backgroundColor: "rgba(217, 119, 6, 0.12)",
    borderColor: "rgba(217, 119, 6, 0.4)",
    color: "#b45309",
  },
  informational: {
    backgroundColor: colors.surfaceSecondary,
    borderColor: colors.border,
    color: colors.textSecondary,
  },
  count: { color: colors.textTertiary, fontSize: 12, fontWeight: "600" },
  details: { gap: 2 },
  detail: { color: colors.textTertiary, fontSize: 12, lineHeight: 18 },
  reviewButton: { alignSelf: "flex-start", marginTop: spacing.xs, paddingVertical: spacing.xs },
  reviewButtonPressed: { opacity: 0.7 },
  reviewText: { color: colors.accent, fontSize: 12, fontWeight: "700" },
});
