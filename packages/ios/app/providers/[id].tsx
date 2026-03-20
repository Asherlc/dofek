import { useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { formatRelativeTime, formatTime } from "@dofek/format/format";
import { useAuth } from "../../lib/auth-context";
import { trpc } from "../../lib/trpc";
import { colors } from "../../theme";

const DATA_TYPES = [
  { key: "activities", label: "Activities" },
  { key: "dailyMetrics", label: "Daily Metrics" },
  { key: "sleepSessions", label: "Sleep" },
  { key: "bodyMeasurements", label: "Body" },
  { key: "foodEntries", label: "Food" },
  { key: "healthEvents", label: "Events" },
  { key: "metricStream", label: "Metric Stream" },
  { key: "nutritionDaily", label: "Nutrition" },
  { key: "labResults", label: "Lab Results" },
  { key: "journalEntries", label: "Journal" },
] as const;

type DataType = (typeof DATA_TYPES)[number]["key"];

function formatProviderName(id: string): string {
  return id
    .split(/[_-]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function formatColumnName(col: string): string {
  return col.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "\u2014";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  const str = String(value);
  if (/^\d{4}-\d{2}-\d{2}T/.test(str)) {
    return formatTime(str);
  }
  return str;
}

// ── Record Detail Modal ──

function RecordDetailModal({
  record,
  onClose,
}: {
  record: Record<string, unknown>;
  onClose: () => void;
}) {
  const rawValue = record.raw;
  const raw = typeof rawValue === "object" && rawValue !== null ? rawValue : null;

  const fields = Object.entries(record).filter(
    ([key]) => key !== "raw" && key !== "user_id",
  );
  const populatedFields = fields.filter(
    ([, value]) => value !== null && value !== undefined,
  );
  const nullFields = fields.filter(
    ([, value]) => value === null || value === undefined,
  );

  const [showNullFields, setShowNullFields] = useState(false);
  const [showRawData, setShowRawData] = useState(true);

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={modalStyles.container}>
        <View style={modalStyles.header}>
          <Text style={modalStyles.title}>Record Detail</Text>
          <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
            <Text style={modalStyles.closeButton}>{"\u00d7"}</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          style={modalStyles.scrollView}
          contentContainerStyle={modalStyles.scrollContent}
        >
          {/* Populated fields */}
          <Text style={modalStyles.sectionTitle}>Fields</Text>
          <View style={modalStyles.fieldsCard}>
            {populatedFields.map(([key, value], index) => (
              <View
                key={key}
                style={[
                  modalStyles.fieldRow,
                  index < populatedFields.length - 1 && modalStyles.fieldRowBorder,
                ]}
              >
                <Text style={modalStyles.fieldLabel}>{formatColumnName(key)}</Text>
                <Text style={modalStyles.fieldValue}>{formatCellValue(value)}</Text>
              </View>
            ))}
          </View>

          {/* Null fields — collapsed by default */}
          {nullFields.length > 0 && (
            <View style={modalStyles.collapsibleSection}>
              <TouchableOpacity
                onPress={() => setShowNullFields(!showNullFields)}
                activeOpacity={0.7}
              >
                <Text style={modalStyles.collapsibleTitle}>
                  {showNullFields ? "\u25bc" : "\u25b6"} Empty Fields ({nullFields.length})
                </Text>
              </TouchableOpacity>
              {showNullFields && (
                <View style={modalStyles.nullFieldsContainer}>
                  {nullFields.map(([key]) => (
                    <Text key={key} style={modalStyles.nullFieldName}>
                      {formatColumnName(key)}
                    </Text>
                  ))}
                </View>
              )}
            </View>
          )}

          {/* Raw provider data */}
          {raw && (
            <View style={modalStyles.collapsibleSection}>
              <TouchableOpacity
                onPress={() => setShowRawData(!showRawData)}
                activeOpacity={0.7}
              >
                <Text style={modalStyles.sectionTitle}>
                  {showRawData ? "\u25bc" : "\u25b6"} Raw Provider Data
                </Text>
              </TouchableOpacity>
              {showRawData && (
                <ScrollView
                  horizontal
                  style={modalStyles.rawDataScroll}
                  contentContainerStyle={modalStyles.rawDataContent}
                >
                  <Text style={modalStyles.rawDataText}>
                    {JSON.stringify(raw, null, 2)}
                  </Text>
                </ScrollView>
              )}
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const modalStyles = StyleSheet.create({
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

// ── Records Table ──

function RecordsTable({
  providerId,
  dataType,
}: {
  providerId: string;
  dataType: DataType;
}) {
  const [page, setPage] = useState(0);
  const [selectedRecord, setSelectedRecord] = useState<Record<
    string,
    unknown
  > | null>(null);
  const pageSize = 25;

  const records = trpc.providerDetail.records.useQuery({
    providerId,
    dataType,
    limit: pageSize,
    offset: page * pageSize,
  });

  const rows = records.data?.rows ?? [];

  const [lastDataType, setLastDataType] = useState(dataType);
  if (dataType !== lastDataType) {
    setPage(0);
    setLastDataType(dataType);
    setSelectedRecord(null);
  }

  if (records.isLoading) {
    return (
      <View style={recordStyles.emptyContainer}>
        <ActivityIndicator color={colors.accent} size="small" />
      </View>
    );
  }

  if (rows.length === 0) {
    return (
      <View style={recordStyles.emptyContainer}>
        <Text style={recordStyles.emptyText}>No records found.</Text>
      </View>
    );
  }

  const excludedColumns = new Set(["raw", "user_id"]);
  const columns = Object.keys(rows[0] ?? {}).filter(
    (col) => !excludedColumns.has(col),
  );
  const priorityCols = [
    "id",
    "name",
    "date",
    "started_at",
    "recorded_at",
    "activity_type",
    "type",
  ];
  const sortedColumns = [
    ...priorityCols.filter((c) => columns.includes(c)),
    ...columns.filter((c) => !priorityCols.includes(c)),
  ];
  const visibleColumns = sortedColumns.slice(0, 3);

  return (
    <View>
      <View style={recordStyles.table}>
        {rows.map((row, idx) => (
          <TouchableOpacity
            key={String(row.id ?? row.date ?? idx)}
            style={[
              recordStyles.row,
              idx < rows.length - 1 && recordStyles.rowBorder,
            ]}
            onPress={() => setSelectedRecord(row)}
            activeOpacity={0.7}
          >
            {visibleColumns.map((col) => (
              <View key={col} style={recordStyles.cell}>
                <Text style={recordStyles.cellLabel}>
                  {formatColumnName(col)}
                </Text>
                <Text style={recordStyles.cellValue} numberOfLines={1}>
                  {formatCellValue(row[col])}
                </Text>
              </View>
            ))}
          </TouchableOpacity>
        ))}
      </View>

      {/* Pagination */}
      <View style={recordStyles.pagination}>
        <TouchableOpacity
          onPress={() => setPage((p) => Math.max(0, p - 1))}
          disabled={page === 0}
          activeOpacity={0.7}
        >
          <Text
            style={[
              recordStyles.pageButton,
              page === 0 && recordStyles.pageButtonDisabled,
            ]}
          >
            Previous
          </Text>
        </TouchableOpacity>
        <Text style={recordStyles.pageLabel}>Page {page + 1}</Text>
        <TouchableOpacity
          onPress={() => setPage((p) => p + 1)}
          disabled={rows.length < pageSize}
          activeOpacity={0.7}
        >
          <Text
            style={[
              recordStyles.pageButton,
              rows.length < pageSize && recordStyles.pageButtonDisabled,
            ]}
          >
            Next
          </Text>
        </TouchableOpacity>
      </View>

      {selectedRecord && (
        <RecordDetailModal
          record={selectedRecord}
          onClose={() => setSelectedRecord(null)}
        />
      )}
    </View>
  );
}

const recordStyles = StyleSheet.create({
  emptyContainer: {
    paddingVertical: 20,
    alignItems: "center",
  },
  emptyText: {
    fontSize: 13,
    color: colors.textTertiary,
  },
  table: {
    backgroundColor: colors.surface,
    borderRadius: 12,
  },
  row: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  rowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfaceSecondary,
  },
  cell: {
    flex: 1,
    gap: 2,
  },
  cellLabel: {
    fontSize: 10,
    color: colors.textTertiary,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  cellValue: {
    fontSize: 13,
    color: colors.text,
  },
  pagination: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 8,
  },
  pageButton: {
    fontSize: 13,
    color: colors.accent,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  pageButtonDisabled: {
    opacity: 0.3,
  },
  pageLabel: {
    fontSize: 12,
    color: colors.textTertiary,
  },
});

// ── Stats Overview ──

interface ProviderStatsData {
  activities: number;
  dailyMetrics: number;
  sleepSessions: number;
  bodyMeasurements: number;
  foodEntries: number;
  healthEvents: number;
  metricStream: number;
  nutritionDaily: number;
  labResults: number;
  journalEntries: number;
}

function getStatCount(stats: ProviderStatsData, key: DataType): number {
  return stats[key];
}

function StatsOverview({ stats }: { stats: ProviderStatsData }) {
  const breakdown = [
    { label: "Activities", count: stats.activities },
    { label: "Metric Stream", count: stats.metricStream },
    { label: "Daily Metrics", count: stats.dailyMetrics },
    { label: "Sleep", count: stats.sleepSessions },
    { label: "Body", count: stats.bodyMeasurements },
    { label: "Food", count: stats.foodEntries },
    { label: "Nutrition", count: stats.nutritionDaily },
    { label: "Events", count: stats.healthEvents },
    { label: "Lab Results", count: stats.labResults },
    { label: "Journal", count: stats.journalEntries },
  ].filter((b) => b.count > 0);

  const total = breakdown.reduce((sum, b) => sum + b.count, 0);

  if (total === 0) return null;

  return (
    <View style={statsStyles.container}>
      <View style={statsStyles.totalRow}>
        <Text style={statsStyles.totalCount}>{total.toLocaleString()}</Text>
        <Text style={statsStyles.totalLabel}>total records</Text>
      </View>
      <View style={statsStyles.grid}>
        {breakdown.map((b) => (
          <View key={b.label} style={statsStyles.statItem}>
            <Text style={statsStyles.statCount}>
              {b.count.toLocaleString()}
            </Text>
            <Text style={statsStyles.statLabel}>{b.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const statsStyles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
  },
  totalRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
    marginBottom: 12,
  },
  totalCount: {
    fontSize: 22,
    fontWeight: "700",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  totalLabel: {
    fontSize: 13,
    color: colors.textTertiary,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  statItem: {
    alignItems: "center",
    minWidth: 60,
  },
  statCount: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  statLabel: {
    fontSize: 11,
    color: colors.textTertiary,
    marginTop: 2,
  },
});

// ── Sync History ──

function SyncHistory({ providerId }: { providerId: string }) {
  const [page, setPage] = useState(0);
  const pageSize = 20;

  const logs = trpc.providerDetail.logs.useQuery({
    providerId,
    limit: pageSize,
    offset: page * pageSize,
  });

  const rows = logs.data ?? [];

  if (logs.isLoading) {
    return (
      <View style={syncStyles.emptyContainer}>
        <ActivityIndicator color={colors.accent} size="small" />
      </View>
    );
  }

  if (rows.length === 0) {
    return (
      <View style={syncStyles.emptyContainer}>
        <Text style={syncStyles.emptyText}>No sync history yet.</Text>
      </View>
    );
  }

  return (
    <View>
      <View style={syncStyles.table}>
        {rows.map((row, idx) => {
          const isError = row.status === "error";
          return (
            <View
              key={row.id}
              style={[
                syncStyles.row,
                idx < rows.length - 1 && syncStyles.rowBorder,
              ]}
            >
              <View style={syncStyles.rowTop}>
                <View style={syncStyles.statusRow}>
                  <View
                    style={[
                      syncStyles.statusDot,
                      {
                        backgroundColor: isError
                          ? colors.danger
                          : colors.positive,
                      },
                    ]}
                  />
                  <Text style={syncStyles.dataType}>{row.dataType}</Text>
                </View>
                <Text style={syncStyles.recordCount}>
                  {row.recordCount ?? "\u2014"} records
                </Text>
              </View>
              <View style={syncStyles.rowBottom}>
                <Text style={syncStyles.metaText}>
                  {formatTime(row.syncedAt)}
                </Text>
                {row.durationMs != null && (
                  <Text style={syncStyles.metaText}>
                    {(row.durationMs / 1000).toFixed(1)}s
                  </Text>
                )}
              </View>
              {isError && row.errorMessage ? (
                <Text style={syncStyles.errorText} numberOfLines={2}>
                  {row.errorMessage}
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>

      {/* Pagination */}
      <View style={recordStyles.pagination}>
        <TouchableOpacity
          onPress={() => setPage((p) => Math.max(0, p - 1))}
          disabled={page === 0}
          activeOpacity={0.7}
        >
          <Text
            style={[
              recordStyles.pageButton,
              page === 0 && recordStyles.pageButtonDisabled,
            ]}
          >
            Previous
          </Text>
        </TouchableOpacity>
        <Text style={recordStyles.pageLabel}>Page {page + 1}</Text>
        <TouchableOpacity
          onPress={() => setPage((p) => p + 1)}
          disabled={rows.length < pageSize}
          activeOpacity={0.7}
        >
          <Text
            style={[
              recordStyles.pageButton,
              rows.length < pageSize && recordStyles.pageButtonDisabled,
            ]}
          >
            Next
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const syncStyles = StyleSheet.create({
  emptyContainer: {
    paddingVertical: 20,
    alignItems: "center",
  },
  emptyText: {
    fontSize: 13,
    color: colors.textTertiary,
  },
  table: {
    backgroundColor: colors.surface,
    borderRadius: 12,
  },
  row: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  rowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfaceSecondary,
  },
  rowTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  dataType: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  recordCount: {
    fontSize: 13,
    color: colors.textSecondary,
    fontVariant: ["tabular-nums"],
  },
  rowBottom: {
    flexDirection: "row",
    gap: 12,
    marginTop: 2,
  },
  metaText: {
    fontSize: 12,
    color: colors.textTertiary,
  },
  errorText: {
    fontSize: 12,
    color: colors.danger,
    marginTop: 4,
  },
});

// ── Records Browser ──

function RecordsBrowser({
  providerId,
  stats,
}: {
  providerId: string;
  stats: ProviderStatsData | undefined;
}) {
  const availableTypes = DATA_TYPES.filter((dt) => {
    if (!stats) return true;
    return getStatCount(stats, dt.key) > 0;
  });

  const [activeTab, setActiveTab] = useState<DataType>(
    availableTypes[0]?.key ?? "activities",
  );

  if (availableTypes.length === 0) {
    return (
      <View>
        <Text style={styles.sectionTitle}>Records</Text>
        <Text style={recordStyles.emptyText}>
          No records yet for this provider.
        </Text>
      </View>
    );
  }

  return (
    <View>
      <Text style={styles.sectionTitle}>Records</Text>

      {/* Tabs */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={tabStyles.scrollView}
        contentContainerStyle={tabStyles.container}
      >
        {availableTypes.map((dt) => (
          <TouchableOpacity
            key={dt.key}
            onPress={() => setActiveTab(dt.key)}
            style={[
              tabStyles.tab,
              activeTab === dt.key && tabStyles.activeTab,
            ]}
            activeOpacity={0.7}
          >
            <Text
              style={[
                tabStyles.tabText,
                activeTab === dt.key && tabStyles.activeTabText,
              ]}
            >
              {dt.label}
              {stats ? ` (${getStatCount(stats, dt.key).toLocaleString()})` : ""}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <RecordsTable providerId={providerId} dataType={activeTab} />
    </View>
  );
}

const tabStyles = StyleSheet.create({
  scrollView: {
    marginBottom: 12,
  },
  container: {
    gap: 6,
  },
  tab: {
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  activeTab: {
    backgroundColor: colors.surfaceSecondary,
  },
  tabText: {
    fontSize: 12,
    color: colors.textTertiary,
  },
  activeTabText: {
    color: colors.text,
  },
});

// ── Main Screen ──

export default function ProviderDetailScreen() {
  const { id: providerId } = useLocalSearchParams<{ id: string }>();
  const { serverUrl } = useAuth();

  const providers = trpc.sync.providers.useQuery();
  const stats = trpc.sync.providerStats.useQuery();

  const provider = (providers.data ?? []).find(
    (p: { id: string }) => p.id === providerId,
  );
  const providerStats = (stats.data ?? []).find(
    (s: { providerId: string }) => s.providerId === providerId,
  );

  const handleReauthorize = useCallback(() => {
    if (!providerId) return;
    Linking.openURL(`${serverUrl}/auth/provider/${providerId}`);
  }, [providerId, serverUrl]);

  if (providers.isLoading || !providerId) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Provider header */}
      <View style={styles.headerCard}>
        <View style={styles.headerRow}>
          <View style={styles.headerInfo}>
            <Text style={styles.providerName}>
              {provider?.name ?? formatProviderName(providerId)}
            </Text>
            {provider && (
              <View style={styles.statusRow}>
                {provider.authorized ? (
                  <Text style={styles.statusConnected}>Connected</Text>
                ) : (
                  <Text style={styles.statusDisconnected}>Not connected</Text>
                )}
                {provider.lastSyncedAt && (
                  <Text style={styles.lastSync}>
                    Last sync: {formatRelativeTime(provider.lastSyncedAt)}
                  </Text>
                )}
              </View>
            )}
          </View>
          {provider?.needsOAuth && provider.authorized && (
            <TouchableOpacity
              style={styles.reauthorizeButton}
              onPress={handleReauthorize}
              activeOpacity={0.7}
            >
              <Text style={styles.reauthorizeButtonText}>Re-authorize</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Stats overview */}
      {providerStats && <StatsOverview stats={providerStats} />}

      {/* Sync history */}
      <Text style={styles.sectionTitle}>Sync History</Text>
      <SyncHistory providerId={providerId} />

      {/* Records browser */}
      <RecordsBrowser providerId={providerId} stats={providerStats} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: 16,
    paddingBottom: 40,
    gap: 16,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: "center",
    alignItems: "center",
  },
  headerCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  headerInfo: {
    flex: 1,
  },
  reauthorizeButton: {
    backgroundColor: colors.surfaceSecondary,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  reauthorizeButtonText: {
    fontSize: 13,
    color: colors.text,
    fontWeight: "500",
  },
  providerName: {
    fontSize: 20,
    fontWeight: "700",
    color: colors.text,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 4,
  },
  statusConnected: {
    fontSize: 13,
    color: colors.positive,
  },
  statusDisconnected: {
    fontSize: 13,
    color: colors.textTertiary,
  },
  lastSync: {
    fontSize: 13,
    color: colors.textTertiary,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
});
