import { Stack, useLocalSearchParams } from "expo-router";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { getQueryErrorMessage, QueryStatePanel } from "../../components/QueryStatePanel";
import { trpc } from "../../lib/trpc";
import { colors, fontSize, fontWeight, radius, spacing } from "../../theme";
import { rootStackScreenOptions } from "../_layout-options";

export default function ClinicalRecordDetailScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = typeof params.id === "string" && params.id.length > 0 ? params.id : null;
  const recordQuery = trpc.clinicalRecords.detail.useQuery(
    { id: id ?? "" },
    { enabled: id !== null },
  );
  const record = recordQuery.data;

  return (
    <>
      <Stack.Screen
        options={{
          ...rootStackScreenOptions,
          title: record?.displayName ?? "Clinical Record",
        }}
      />
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        {!id ? (
          <QueryStatePanel
            variant="error"
            title="Clinical record is unavailable"
            message="Clinical record ID is missing."
          />
        ) : recordQuery.isLoading && record === undefined ? (
          <QueryStatePanel variant="loading" />
        ) : recordQuery.error && record === undefined ? (
          <QueryStatePanel
            variant="error"
            title="Clinical record is unavailable"
            message={getQueryErrorMessage(recordQuery.error)}
            onRetry={() => void recordQuery.refetch()}
            retrying={recordQuery.isFetching}
          />
        ) : record ? (
          <>
            {recordQuery.error ? (
              <QueryStatePanel
                variant="error"
                title="Clinical record refresh failed"
                message={getQueryErrorMessage(recordQuery.error)}
                minHeight={80}
                onRetry={() => void recordQuery.refetch()}
                retrying={recordQuery.isFetching}
              />
            ) : null}

            <View style={styles.card}>
              <Text accessibilityRole="header" style={styles.title}>
                {record.displayName}
              </Text>
              <View style={styles.field}>
                <Text style={styles.label}>Type</Text>
                <Text style={styles.value}>{record.typeLabel}</Text>
              </View>
              <View style={styles.field}>
                <Text style={styles.label}>Source</Text>
                <Text style={styles.value}>{record.sourceLabel}</Text>
              </View>
              <View style={styles.field}>
                <Text style={styles.label}>Date</Text>
                <Text style={styles.value}>{record.dateLabel}</Text>
              </View>
            </View>

            <View style={styles.card}>
              <Text accessibilityRole="header" style={styles.sectionTitle}>
                FHIR resource
              </Text>
              <Text style={styles.fhirVersion}>FHIR version {record.fhirVersion}</Text>
              <ScrollView horizontal accessibilityLabel="FHIR resource JSON">
                <Text selectable style={styles.fhirJson}>
                  {JSON.stringify(record.fhir, null, 2)}
                </Text>
              </ScrollView>
            </View>
          </>
        ) : (
          <QueryStatePanel variant="empty" message="Clinical record not found." />
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1 },
  content: { gap: spacing.md, padding: spacing.md, paddingBottom: spacing.xl },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    padding: spacing.md,
  },
  title: { color: colors.text, fontSize: fontSize.xl, fontWeight: fontWeight.bold },
  sectionTitle: { color: colors.text, fontSize: fontSize.base, fontWeight: fontWeight.bold },
  field: { gap: spacing.xs },
  label: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    textTransform: "uppercase",
  },
  value: { color: colors.text, fontSize: fontSize.sm },
  fhirVersion: { color: colors.textSecondary, fontSize: fontSize.xs },
  fhirJson: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    color: colors.text,
    fontFamily: "monospace",
    fontSize: fontSize.xs,
    padding: spacing.md,
  },
});
