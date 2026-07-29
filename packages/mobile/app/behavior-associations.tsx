import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Card } from "../components/Card";
import { DaySelector } from "../components/DaySelector";
import { getQueryErrorMessage, QueryStatePanel } from "../components/QueryStatePanel";
import { trpc } from "../lib/trpc";
import { colors, spacing } from "../theme";

const DAY_OPTIONS = [
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "180d", value: 180 },
  { label: "1y", value: 365 },
];

function formatDifference(value: number): string {
  if (value > 0) return `${Math.abs(value).toFixed(1)}% higher`;
  if (value < 0) return `${Math.abs(value).toFixed(1)}% lower`;
  return "0.0% difference";
}

export default function BehaviorAssociationsScreen() {
  const [days, setDays] = useState(90);
  const query = trpc.behaviorImpact.impactSummary.useQuery({ days });
  const data = query.data;

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.container}>
      <View style={styles.heading}>
        <Text style={styles.title}>Behavior Associations</Text>
        <Text style={styles.subtitle}>
          How your daily behaviors are associated with next-day readiness
        </Text>
      </View>

      <DaySelector days={days} onChange={setDays} options={DAY_OPTIONS} />

      <Card title="Evidence">
        <Text style={styles.evidenceText}>
          Method: (mean next-day readiness after Yes − mean after No) ÷ mean after No × 100.
        </Text>
        <Text style={styles.evidenceText}>Association does not establish causation.</Text>
        <Text style={styles.evidenceText}>
          Uncertainty interval: not available for this descriptive comparison.
        </Text>
        <Text style={styles.evidenceText}>Selected window: {days} days</Text>
      </Card>

      {query.isLoading && !data ? (
        <QueryStatePanel variant="loading" />
      ) : query.error && !data ? (
        <QueryStatePanel
          variant="error"
          message={getQueryErrorMessage(query.error)}
          onRetry={() => void query.refetch()}
          retryLabel="Retry behavior associations"
        />
      ) : !data || data.length === 0 ? (
        <QueryStatePanel
          variant="empty"
          title="Not enough journal data yet"
          message="Log boolean journal entries (Yes/No) for at least 5 days in each group to describe their association with next-day readiness."
        />
      ) : (
        <>
          {query.error ? (
            <QueryStatePanel
              variant="error"
              message={getQueryErrorMessage(query.error)}
              onRetry={() => void query.refetch()}
              retryLabel="Retry behavior associations"
            />
          ) : null}
          {data.map((association) => (
            <Card key={association.questionSlug} title={association.displayName}>
              <Text style={styles.category}>{association.category}</Text>
              <Text style={styles.difference}>
                {formatDifference(association.readinessDifferencePercent)}
              </Text>
              <Text style={styles.sample}>
                Yes n = {association.yesCount} · No n = {association.noCount}
              </Text>
            </Card>
          ))}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: spacing.md,
    paddingBottom: 100,
    gap: spacing.md,
  },
  heading: {
    gap: spacing.xs,
  },
  title: {
    color: colors.text,
    fontSize: 24,
    fontWeight: "700",
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  evidenceText: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  category: {
    color: colors.textTertiary,
    fontSize: 12,
    textTransform: "capitalize",
  },
  difference: {
    color: colors.blue,
    fontSize: 22,
    fontWeight: "700",
  },
  sample: {
    color: colors.textSecondary,
    fontSize: 12,
  },
});
