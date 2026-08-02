import { useRouter } from "expo-router";
import { ScrollView, StyleSheet, Text } from "react-native";
import type { DataQualityCheckKey } from "../../server/src/repositories/data-quality-repository";
import { DataQualityCenter } from "../components/DataQualityCenter";
import { getQueryErrorMessage, QueryStatePanel } from "../components/QueryStatePanel";
import { trpc } from "../lib/trpc";
import { useTodayQueryDate } from "../lib/useTodayQueryDate";
import { colors, spacing } from "../theme";

const reviewRoutes = {
  coverage: "/nutrition-analytics",
  source_overlap: "/nutrition-analytics",
  sync_freshness: "/(tabs)",
  outliers: "/(tabs)",
  manual_edits: "/tracking",
} as const satisfies Record<DataQualityCheckKey, string>;

export default function DataQualityScreen() {
  const endDate = useTodayQueryDate();
  const query = trpc.processing.dataQuality.useQuery({ endDate });
  const router = useRouter();

  function review(key: DataQualityCheckKey) {
    router.push(reviewRoutes[key]);
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.intro}>
        Understand what is missing, overlapping, stale, unusual, or manually entered before you
        interpret your health data.
      </Text>
      {query.isLoading && !query.data ? (
        <QueryStatePanel variant="loading" />
      ) : query.error && !query.data ? (
        <QueryStatePanel
          variant="error"
          title="Data quality is unavailable"
          message={getQueryErrorMessage(query.error)}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : !query.data ? (
        <QueryStatePanel variant="empty" message="No data quality checks are available yet." />
      ) : (
        <>
          <DataQualityCenter data={query.data} onReview={review} />
          {query.error ? (
            <QueryStatePanel
              variant="error"
              title="Data quality refresh failed"
              message={getQueryErrorMessage(query.error)}
              onRetry={() => void query.refetch()}
              retrying={query.isFetching}
            />
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { gap: spacing.md, padding: spacing.md, paddingBottom: spacing.xl },
  intro: { color: colors.textSecondary, fontSize: 14, lineHeight: 20 },
});
