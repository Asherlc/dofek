import type { AppRouterOutputs } from "dofek-server/router";
import { Stack, useRouter } from "expo-router";
import { useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { getQueryErrorMessage, QueryStatePanel } from "../components/QueryStatePanel";
import { trpc } from "../lib/trpc";
import { colors, fontSize, fontWeight, radius, spacing } from "../theme";
import { rootStackScreenOptions } from "./_layout-options";

const PAGE_SIZE = 20;

type ClinicalRecordSummary = AppRouterOutputs["clinicalRecords"]["list"]["records"][number];

interface ClinicalRecordGroup {
  key: string;
  records: ClinicalRecordSummary[];
  sourceLabel: string;
  typeLabel: string;
}

function groupRecords(records: ClinicalRecordSummary[]): ClinicalRecordGroup[] {
  const groups = new Map<string, ClinicalRecordGroup>();
  for (const record of records) {
    const key = JSON.stringify([record.typeLabel, record.sourceLabel]);
    const group = groups.get(key);
    if (group) {
      group.records.push(record);
    } else {
      groups.set(key, {
        key,
        records: [record],
        sourceLabel: record.sourceLabel,
        typeLabel: record.typeLabel,
      });
    }
  }
  return [...groups.values()];
}

export default function ClinicalRecordsScreen() {
  const router = useRouter();
  const [offset, setOffset] = useState(0);
  const recordsQuery = trpc.clinicalRecords.list.useQuery({ limit: PAGE_SIZE, offset });
  const records = recordsQuery.data?.records;

  return (
    <>
      <Stack.Screen options={{ ...rootStackScreenOptions, title: "Clinical Records" }} />
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <View style={styles.introCard}>
          <Text style={styles.title}>Clinical Records</Text>
          <Text style={styles.subtitle}>Read-only records synced explicitly from Apple Health</Text>
        </View>

        {recordsQuery.isLoading && records === undefined ? (
          <QueryStatePanel variant="loading" />
        ) : recordsQuery.error && records === undefined ? (
          <QueryStatePanel
            variant="error"
            title="Clinical records are unavailable"
            message={getQueryErrorMessage(recordsQuery.error)}
            onRetry={() => void recordsQuery.refetch()}
            retrying={recordsQuery.isFetching}
          />
        ) : recordsQuery.error && records?.length === 0 ? (
          <QueryStatePanel
            variant="error"
            title="Clinical records refresh failed"
            message={getQueryErrorMessage(recordsQuery.error)}
            onRetry={() => void recordsQuery.refetch()}
            retrying={recordsQuery.isFetching}
          />
        ) : records?.length === 0 ? (
          <QueryStatePanel
            variant="empty"
            title="No clinical records"
            message="No clinical records have been synced yet."
          />
        ) : records ? (
          <View style={styles.groups}>
            {recordsQuery.error ? (
              <QueryStatePanel
                variant="error"
                title="Clinical records refresh failed"
                message={getQueryErrorMessage(recordsQuery.error)}
                minHeight={80}
                onRetry={() => void recordsQuery.refetch()}
                retrying={recordsQuery.isFetching}
              />
            ) : null}

            {groupRecords(records).map((group) => (
              <View key={group.key} style={styles.group}>
                <View>
                  <Text style={styles.groupTitle}>{group.typeLabel}</Text>
                  <Text style={styles.groupSource}>{group.sourceLabel}</Text>
                </View>
                <View style={styles.card}>
                  {group.records.map((record) => (
                    <TouchableOpacity
                      key={record.id}
                      accessibilityLabel={record.displayName}
                      accessibilityRole="link"
                      activeOpacity={0.7}
                      onPress={() => router.push(`/clinical-record/${record.id}`)}
                      style={styles.record}
                    >
                      <Text style={styles.recordName}>{record.displayName}</Text>
                      <Text style={styles.recordDate}>{record.dateLabel}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            ))}

            <View
              accessibilityRole="navigation"
              accessibilityLabel="Clinical record pages"
              style={styles.pagination}
            >
              <TouchableOpacity
                accessibilityLabel="Previous"
                accessibilityRole="button"
                accessibilityState={{ disabled: offset === 0 }}
                disabled={offset === 0}
                onPress={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
                style={[styles.pageButton, offset === 0 ? styles.disabled : null]}
              >
                <Text style={styles.pageButtonText}>Previous</Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityLabel="Next"
                accessibilityRole="button"
                accessibilityState={{ disabled: recordsQuery.data?.nextOffset === null }}
                disabled={recordsQuery.data?.nextOffset === null}
                onPress={() => {
                  if (recordsQuery.data?.nextOffset != null) {
                    setOffset(recordsQuery.data.nextOffset);
                  }
                }}
                style={[
                  styles.pageButton,
                  recordsQuery.data?.nextOffset === null ? styles.disabled : null,
                ]}
              >
                <Text style={styles.pageButtonText}>Next</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <QueryStatePanel variant="empty" message="No clinical records have been synced yet." />
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1 },
  content: { gap: spacing.md, padding: spacing.md, paddingBottom: spacing.xl },
  introCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    padding: spacing.md,
  },
  title: { color: colors.text, fontSize: fontSize.xl, fontWeight: fontWeight.bold },
  subtitle: { color: colors.textSecondary, fontSize: fontSize.sm },
  groups: { gap: spacing.lg },
  group: { gap: spacing.sm },
  groupTitle: { color: colors.text, fontSize: fontSize.base, fontWeight: fontWeight.bold },
  groupSource: { color: colors.textSecondary, fontSize: fontSize.xs },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  record: {
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    padding: spacing.md,
  },
  recordName: { color: colors.text, fontSize: fontSize.base, fontWeight: fontWeight.semibold },
  recordDate: { color: colors.textSecondary, fontSize: fontSize.xs },
  pagination: { flexDirection: "row", justifyContent: "space-between" },
  pageButton: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  pageButtonText: { color: colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  disabled: { opacity: 0.5 },
});
