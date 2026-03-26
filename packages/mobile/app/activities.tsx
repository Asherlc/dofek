import { useState } from "react";
import { useRouter } from "expo-router";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { ActivityCard } from "../components/ActivityCard";
import { trpc } from "../lib/trpc";
import { useRefresh } from "../lib/useRefresh";
import { useUnitConverter } from "../lib/units";
import { ActivityRowSchema } from "../types/api";
import { colors } from "../theme";

const PAGE_SIZE = 20;

export default function ActivitiesScreen() {
  const router = useRouter();
  const [page, setPage] = useState(0);
  const units = useUnitConverter();

  const query = trpc.activity.list.useQuery({
    days: 90,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  const parsed = ActivityRowSchema.array()
    .catch([])
    .parse(query.data?.items ?? []);
  const totalCount = (query.data as { totalCount?: number } | undefined)
    ?.totalCount ?? 0;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const { refreshing, onRefresh } = useRefresh();

  return (
    <View style={styles.container}>
      <FlatList
        data={parsed}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textSecondary} />}
        renderItem={({ item }) => (
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={() => router.push(`/activity/${item.id}`)}
          >
            <ActivityCard
              name={item.name ?? ""}
              activityType={item.activity_type ?? ""}
              startedAt={item.started_at}
              endedAt={item.ended_at ?? null}
              avgHr={item.avg_hr ?? null}
              maxHr={item.max_hr ?? null}
              avgPower={item.avg_power ?? null}
              distanceKm={item.distance_meters ? item.distance_meters / 1000 : null}
              calories={item.calories ?? null}
              units={units}
            />
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          query.isLoading ? (
            <ActivityIndicator color={colors.accent} style={styles.loader} />
          ) : (
            <Text style={styles.empty}>No activities found</Text>
          )
        }
        ListFooterComponent={
          totalPages > 1 ? (
            <View style={styles.pagination}>
              <TouchableOpacity
                onPress={() => setPage((p) => p - 1)}
                disabled={page <= 0}
                style={[
                  styles.pageButton,
                  page <= 0 && styles.pageButtonDisabled,
                ]}
              >
                <Text
                  style={[
                    styles.pageButtonText,
                    page <= 0 && styles.pageButtonTextDisabled,
                  ]}
                >
                  Previous
                </Text>
              </TouchableOpacity>
              <Text style={styles.pageInfo}>
                {page + 1} / {totalPages}
              </Text>
              <TouchableOpacity
                onPress={() => setPage((p) => p + 1)}
                disabled={page >= totalPages - 1}
                style={[
                  styles.pageButton,
                  page >= totalPages - 1 && styles.pageButtonDisabled,
                ]}
              >
                <Text
                  style={[
                    styles.pageButtonText,
                    page >= totalPages - 1 && styles.pageButtonTextDisabled,
                  ]}
                >
                  Next
                </Text>
              </TouchableOpacity>
            </View>
          ) : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  list: {
    padding: 16,
    gap: 8,
  },
  loader: {
    marginTop: 40,
  },
  empty: {
    color: colors.textSecondary,
    textAlign: "center",
    marginTop: 40,
    fontSize: 14,
  },
  pagination: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    paddingVertical: 16,
  },
  pageButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: colors.surface,
    borderRadius: 8,
  },
  pageButtonDisabled: {
    opacity: 0.4,
  },
  pageButtonText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "500",
  },
  pageButtonTextDisabled: {
    color: colors.textTertiary,
  },
  pageInfo: {
    color: colors.textSecondary,
    fontSize: 13,
    fontVariant: ["tabular-nums"],
  },
});
