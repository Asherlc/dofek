import { routeComparisonsSchema } from "@dofek/training/route-comparison";
import { useRouter } from "expo-router";
import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import { isTransientNetworkError } from "../lib/query-client";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { useUnitConverter } from "../lib/units";
import { colors } from "../theme";
import { QueryStatePanel } from "./QueryStatePanel";
import { RouteComparisonChart } from "./RouteComparisonChart";

export function RouteComparisonCard({ days, enabled }: { days: number; enabled: boolean }) {
  const router = useRouter();
  const units = useUnitConverter();
  const query = trpc.hiking.activityComparison.useQuery(
    { days },
    { enabled, select: routeComparisonsSchema.parse, placeholderData: (previous) => previous },
  );
  useEffect(() => {
    if (query.error && !isTransientNetworkError(query.error)) captureException(query.error);
  }, [query.error]);
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Route comparison</Text>
      {query.error ? <QueryStatePanel variant="error" message={query.error.message} /> : null}
      {query.isLoading && query.data === undefined ? <QueryStatePanel variant="loading" /> : null}
      {query.isFetching && query.data !== undefined ? (
        <Text accessibilityLiveRegion="polite" style={styles.text}>
          Updating route comparison…
        </Text>
      ) : null}
      {query.data?.length ? (
        <RouteComparisonChart
          routes={query.data}
          units={units}
          onActivityPress={(activityId) => router.push(`/activity/${activityId}`)}
        />
      ) : query.data && !query.error ? (
        <QueryStatePanel variant="empty" message="No repeated GPS routes in this period" />
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  card: { padding: 16, gap: 12, backgroundColor: colors.surface, borderRadius: 12 },
  title: { color: colors.text, fontWeight: "600", fontSize: 16 },
  text: { color: colors.textSecondary },
});
