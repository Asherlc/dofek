import { formatReadinessDifference } from "@dofek/format/format";
import type { ProviderProvenance } from "@dofek/providers/providers";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Card } from "../components/Card";
import { DaySelector } from "../components/DaySelector";
import { getQueryErrorMessage, QueryStatePanel } from "../components/QueryStatePanel";
import { trpc } from "../lib/trpc";
import { useTimeRangePreference } from "../lib/useTimeRangePreference";
import { colors, spacing } from "../theme";

const DAY_OPTIONS = [
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "180d", value: 180 },
  { label: "1y", value: 365 },
];

function ProviderSourceDetails({ sources }: { sources: ProviderProvenance[] }) {
  const [expanded, setExpanded] = useState(false);
  const sourceNames = sources.map((source) => source.label).join(", ");
  const sourceIds = sources.map((source) => source.providerId).join(", ");
  const sourcePrefix = sources.length === 1 ? "Source" : "Sources";
  const idPrefix = sources.length === 1 ? "Provider ID" : "Provider IDs";
  const action = expanded ? "Hide" : "Show";

  return (
    <View style={styles.sourceDetails}>
      <Text style={styles.source}>
        {sourcePrefix}: {sourceNames}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${action} technical source details for ${sourceNames}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((current) => !current)}
      >
        <Text style={styles.technicalDetails}>Technical details</Text>
      </Pressable>
      {expanded ? (
        <Text style={styles.providerId}>
          {idPrefix}: {sourceIds}
        </Text>
      ) : null}
    </View>
  );
}

export default function BehaviorAssociationsScreen() {
  const { days, description, setDays } = useTimeRangePreference("behavior");
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

      <DaySelector days={days} description={description} onChange={setDays} options={DAY_OPTIONS} />

      <Card title="Evidence">
        <Text style={styles.evidenceText}>
          Method: (mean next-day readiness after Yes − mean after No) ÷ mean after No × 100.
        </Text>
        <Text style={styles.evidenceText}>Association does not establish causation.</Text>
        <Text style={styles.evidenceText}>
          Uncertainty interval: not available for this descriptive comparison.
        </Text>
        <Text style={styles.evidenceText}>Selected window: {days} days</Text>
        {data?.[0] ? (
          <>
            <Text style={styles.evidenceText}>{data[0].association.method}</Text>
            <Text style={styles.evidenceText}>{data[0].association.interpretation}</Text>
            <Text style={styles.evidenceText}>{data[0].association.uncertainty}</Text>
            <Text style={styles.evidenceText}>{data[0].association.observationWindow}</Text>
          </>
        ) : null}
      </Card>

      {query.isLoading && !data ? (
        <QueryStatePanel variant="loading" />
      ) : query.error && (!data || data.length === 0) ? (
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
                {formatReadinessDifference(association.impactPercent)}
              </Text>
              <Text style={styles.sample}>
                Yes n = {association.yesCount} · No n = {association.noCount}
              </Text>
              <ProviderSourceDetails sources={association.sources} />
              <Text style={styles.associationEvidenceText}>
                {association.association.estimateLabel}
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
  associationEvidenceText: {
    color: colors.textTertiary,
    fontSize: 12,
    lineHeight: 17,
  },
  sourceDetails: {
    gap: 2,
  },
  source: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  technicalDetails: {
    color: colors.textTertiary,
    fontSize: 12,
    textDecorationLine: "underline",
  },
  providerId: {
    color: colors.textTertiary,
    fontFamily: "monospace",
    fontSize: 11,
  },
});
