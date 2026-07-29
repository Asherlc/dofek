import { useRouter } from "expo-router";
import { useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors } from "../../theme";
import { formatCellValue, formatColumnName } from "./provider-detail-record-format";

export function ProviderRecordDetailModal({
  record,
  onClose,
  activityId,
}: {
  record: Record<string, unknown>;
  onClose: () => void;
  activityId?: string;
}) {
  const router = useRouter();
  const rawValue = record.raw;
  const raw = typeof rawValue === "object" && rawValue !== null ? rawValue : null;

  const fields = Object.entries(record).filter(([key]) => key !== "raw" && key !== "user_id");
  const populatedFields = fields.filter(([, value]) => value !== null && value !== undefined);
  const nullFields = fields.filter(([, value]) => value === null || value === undefined);

  const [showNullFields, setShowNullFields] = useState(false);
  const [showRawData, setShowRawData] = useState(true);

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Record Detail</Text>
          <TouchableOpacity
            onPress={onClose}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Close record detail"
          >
            <Text style={styles.closeButton}>{"\u00d7"}</Text>
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
          {activityId && (
            <TouchableOpacity
              onPress={() => {
                onClose();
                router.push(`/activity/${activityId}`);
              }}
              style={styles.activityLink}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Open activity"
            >
              <Text style={styles.activityLinkText}>Open activity</Text>
            </TouchableOpacity>
          )}

          <Text style={styles.sectionTitle}>Fields</Text>
          <View style={styles.fieldsCard}>
            {populatedFields.map(([key, value], index) => (
              <View
                key={key}
                style={[
                  styles.fieldRow,
                  index < populatedFields.length - 1 && styles.fieldRowBorder,
                ]}
              >
                <Text style={styles.fieldLabel}>{formatColumnName(key)}</Text>
                <Text style={styles.fieldValue}>{formatCellValue(value)}</Text>
              </View>
            ))}
          </View>

          {nullFields.length > 0 && (
            <View style={styles.collapsibleSection}>
              <TouchableOpacity
                onPress={() => setShowNullFields(!showNullFields)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`${showNullFields ? "Hide" : "Show"} empty fields`}
                accessibilityState={{ expanded: showNullFields }}
              >
                <Text style={styles.collapsibleTitle}>
                  {showNullFields ? "\u25bc" : "\u25b6"} Empty Fields ({nullFields.length})
                </Text>
              </TouchableOpacity>
              {showNullFields && (
                <View style={styles.nullFieldsContainer}>
                  {nullFields.map(([key]) => (
                    <Text key={key} style={styles.nullFieldName}>
                      {formatColumnName(key)}
                    </Text>
                  ))}
                </View>
              )}
            </View>
          )}

          {raw && (
            <View style={styles.collapsibleSection}>
              <TouchableOpacity
                onPress={() => setShowRawData(!showRawData)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`${showRawData ? "Hide" : "Show"} raw provider data`}
                accessibilityState={{ expanded: showRawData }}
              >
                <Text style={styles.sectionTitle}>
                  {showRawData ? "\u25bc" : "\u25b6"} Raw Provider Data
                </Text>
              </TouchableOpacity>
              {showRawData && (
                <ScrollView
                  horizontal
                  style={styles.rawDataScroll}
                  contentContainerStyle={styles.rawDataContent}
                >
                  <Text style={styles.rawDataText}>{JSON.stringify(raw, null, 2)}</Text>
                </ScrollView>
              )}
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfaceSecondary,
  },
  title: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.text,
  },
  closeButton: {
    fontSize: 24,
    color: colors.textSecondary,
    paddingHorizontal: 8,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  activityLink: {
    alignSelf: "flex-start",
  },
  activityLinkText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "600",
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  fieldsCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    marginBottom: 16,
  },
  fieldRow: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 12,
  },
  fieldRowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfaceSecondary,
  },
  fieldLabel: {
    fontSize: 13,
    color: colors.textSecondary,
    width: 140,
    flexShrink: 0,
  },
  fieldValue: {
    fontSize: 13,
    color: colors.text,
    flex: 1,
    flexWrap: "wrap",
  },
  collapsibleSection: {
    marginBottom: 16,
  },
  collapsibleTitle: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textTertiary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  nullFieldsContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  nullFieldName: {
    fontSize: 12,
    color: colors.textTertiary,
  },
  rawDataScroll: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    maxHeight: 400,
  },
  rawDataContent: {
    padding: 12,
  },
  rawDataText: {
    fontSize: 12,
    color: colors.textSecondary,
    fontFamily: "Menlo",
  },
});
