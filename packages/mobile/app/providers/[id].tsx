import { formatRelativeTime, formatTime } from "@dofek/format/format";
import type { ProviderStats } from "@dofek/providers/provider-stats";
import { DATA_TYPE_LABELS } from "@dofek/providers/provider-stats";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { ProviderStatsBreakdown } from "../../components/ProviderStatsBreakdown";
import { useAuth } from "../../lib/auth-context";
import { trpc } from "../../lib/trpc";
import { useRefresh } from "../../lib/useRefresh";
import { colors } from "../../theme";

type DataType = (typeof DATA_TYPE_LABELS)[number]["key"];

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

  const fields = Object.entries(record).filter(([key]) => key !== "raw" && key !== "user_id");
  const populatedFields = fields.filter(([, value]) => value !== null && value !== undefined);
  const nullFields = fields.filter(([, value]) => value === null || value === undefined);

  const [showNullFields, setShowNullFields] = useState(false);
  const [showRawData, setShowRawData] = useState(true);

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
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
              <TouchableOpacity onPress={() => setShowRawData(!showRawData)} activeOpacity={0.7}>
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
                  <Text style={modalStyles.rawDataText}>{JSON.stringify(raw, null, 2)}</Text>
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

function RecordsTable({ providerId, dataType }: { providerId: string; dataType: DataType }) {
  const [page, setPage] = useState(0);
  const [selectedRecord, setSelectedRecord] = useState<Record<string, unknown> | null>(null);
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
  const columns = Object.keys(rows[0] ?? {}).filter((col) => !excludedColumns.has(col));
  const priorityCols = ["id", "name", "date", "started_at", "recorded_at", "activity_type", "type"];
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
            style={[recordStyles.row, idx < rows.length - 1 && recordStyles.rowBorder]}
            onPress={() => setSelectedRecord(row)}
            activeOpacity={0.7}
          >
            {visibleColumns.map((col) => (
              <View key={col} style={recordStyles.cell}>
                <Text style={recordStyles.cellLabel}>{formatColumnName(col)}</Text>
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
          <Text style={[recordStyles.pageButton, page === 0 && recordStyles.pageButtonDisabled]}>
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
        <RecordDetailModal record={selectedRecord} onClose={() => setSelectedRecord(null)} />
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
              style={[syncStyles.row, idx < rows.length - 1 && syncStyles.rowBorder]}
            >
              <View style={syncStyles.rowTop}>
                <View style={syncStyles.statusRow}>
                  <View
                    style={[
                      syncStyles.statusDot,
                      {
                        backgroundColor: isError ? colors.danger : colors.positive,
                      },
                    ]}
                  />
                  <Text style={syncStyles.dataType}>{row.dataType}</Text>
                </View>
                <Text style={syncStyles.recordCount}>{row.recordCount ?? "\u2014"} records</Text>
              </View>
              <View style={syncStyles.rowBottom}>
                <Text style={syncStyles.metaText}>{formatTime(row.syncedAt)}</Text>
                {row.durationMs != null && (
                  <Text style={syncStyles.metaText}>{(row.durationMs / 1000).toFixed(1)}s</Text>
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
          <Text style={[recordStyles.pageButton, page === 0 && recordStyles.pageButtonDisabled]}>
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
  stats: ProviderStats | undefined;
}) {
  const availableTypes = DATA_TYPE_LABELS.filter((dt) => {
    if (!stats) return true;
    return stats[dt.key] > 0;
  });

  const [activeTab, setActiveTab] = useState<DataType>(availableTypes[0]?.key ?? "activities");

  if (availableTypes.length === 0) {
    return (
      <View>
        <Text style={styles.sectionTitle}>Records</Text>
        <Text style={recordStyles.emptyText}>No records yet for this provider.</Text>
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
            style={[tabStyles.tab, activeTab === dt.key && tabStyles.activeTab]}
            activeOpacity={0.7}
          >
            <Text style={[tabStyles.tabText, activeTab === dt.key && tabStyles.activeTabText]}>
              {dt.label}
              {stats ? ` (${stats[dt.key].toLocaleString()})` : ""}
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
  const router = useRouter();
  const trpcUtils = trpc.useUtils();

  const providers = trpc.sync.providers.useQuery();
  const stats = trpc.sync.providerStats.useQuery();
  const syncMutation = trpc.sync.triggerSync.useMutation();
  const disconnectMutation = trpc.providerDetail.disconnect.useMutation();

  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<number | null>(null);
  const [customDays, setCustomDays] = useState("30");
  const pollingRef = useRef(false);

  const provider = (providers.data ?? []).find((p: { id: string }) => p.id === providerId);
  const providerStats = (stats.data ?? []).find(
    (s: { providerId: string }) => s.providerId === providerId,
  );

  const pollSyncJob = useCallback(
    async (jobId: string) => {
      if (pollingRef.current) return;
      pollingRef.current = true;

      const poll = async (): Promise<void> => {
        let status: Awaited<ReturnType<typeof trpcUtils.sync.syncStatus.fetch>>;
        try {
          status = await trpcUtils.sync.syncStatus.fetch({ jobId }, { staleTime: 0 });
        } catch {
          pollingRef.current = false;
          setIsSyncing(false);
          setSyncMessage("Sync failed");
          return;
        }

        if (!status) {
          pollingRef.current = false;
          setIsSyncing(false);
          return;
        }

        setSyncProgress(status.percentage);
        const providerStatus = providerId ? status.providers[providerId] : null;
        if (providerStatus?.message) {
          setSyncMessage(providerStatus.message);
        }

        if (status.status === "done" || status.status === "error") {
          pollingRef.current = false;
          setIsSyncing(false);
          setSyncMessage(status.status === "done" ? "Sync complete" : "Sync failed");
          trpcUtils.sync.providers.invalidate();
          trpcUtils.sync.providerStats.invalidate();
          trpcUtils.sync.logs.invalidate();
          return;
        }

        await new Promise((r) => setTimeout(r, 1000));
        return poll();
      };

      return poll();
    },
    [trpcUtils, providerId],
  );

  const handleSync = useCallback(
    async (sinceDays: number | undefined) => {
      if (!providerId || isSyncing) return;
      setIsSyncing(true);
      setSyncMessage("Starting sync...");
      setSyncProgress(0);
      try {
        const { jobId } = await syncMutation.mutateAsync({
          providerId,
          sinceDays,
        });
        await pollSyncJob(jobId);
      } catch {
        setIsSyncing(false);
        setSyncMessage("Failed to start sync");
      }
    },
    [providerId, isSyncing, syncMutation, pollSyncJob],
  );

  const handleDisconnect = useCallback(() => {
    if (!providerId) return;
    Alert.alert(
      "Disconnect Provider",
      "This will permanently delete all synced data from this provider. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disconnect",
          style: "destructive",
          onPress: async () => {
            try {
              await disconnectMutation.mutateAsync({ providerId });
              trpcUtils.sync.providers.invalidate();
              trpcUtils.sync.providerStats.invalidate();
              router.back();
            } catch {
              Alert.alert("Error", "Failed to disconnect provider");
            }
          },
        },
      ],
    );
  }, [providerId, disconnectMutation, trpcUtils, router]);

  const handleReauthorize = useCallback(() => {
    if (!providerId) return;
    Linking.openURL(`${serverUrl}/auth/provider/${providerId}`);
  }, [providerId, serverUrl]);

  const { refreshing, onRefresh } = useRefresh();

  if (providers.isLoading || !providerId) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.textSecondary}
        />
      }
    >
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
                {provider.lastSyncedAt && formatRelativeTime(provider.lastSyncedAt) && (
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

      {/* Sync controls */}
      {provider?.authorized && !provider.importOnly && (
        <View style={styles.syncControlsCard}>
          <Text style={styles.syncControlsTitle}>Sync Controls</Text>
          <View style={styles.syncButtonRow}>
            <TouchableOpacity
              style={[styles.syncButton, isSyncing && styles.syncButtonDisabled]}
              onPress={() => handleSync(7)}
              activeOpacity={0.7}
              disabled={isSyncing}
            >
              <Text style={styles.syncButtonText}>Sync Last 7 Days</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.syncButton, isSyncing && styles.syncButtonDisabled]}
              onPress={() => handleSync(undefined)}
              activeOpacity={0.7}
              disabled={isSyncing}
            >
              <Text style={styles.syncButtonText}>Full Sync</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.customSyncRow}>
            <TextInput
              style={styles.customDaysInput}
              value={customDays}
              onChangeText={setCustomDays}
              keyboardType="number-pad"
              placeholder="Days"
              placeholderTextColor={colors.textTertiary}
            />
            <TouchableOpacity
              style={[
                styles.syncButton,
                styles.syncRangeButton,
                isSyncing && styles.syncButtonDisabled,
              ]}
              onPress={() => {
                const days = Number.parseInt(customDays, 10);
                if (days >= 1 && days <= 3650) {
                  handleSync(days);
                }
              }}
              activeOpacity={0.7}
              disabled={isSyncing}
            >
              <Text style={styles.syncButtonText}>Sync Range</Text>
            </TouchableOpacity>
          </View>
          {isSyncing && (
            <View style={styles.syncProgressContainer}>
              <View style={styles.syncProgressTrack}>
                <View style={[styles.syncProgressFill, { width: `${syncProgress ?? 0}%` }]} />
              </View>
              {syncMessage != null && <Text style={styles.syncMessageText}>{syncMessage}</Text>}
            </View>
          )}
          {!isSyncing && syncMessage != null && (
            <Text style={styles.syncMessageText}>{syncMessage}</Text>
          )}
        </View>
      )}

      {/* Stats overview */}
      {providerStats && <ProviderStatsBreakdown stats={providerStats} variant="full" />}

      {/* Sync history */}
      <Text style={styles.sectionTitle}>Sync History</Text>
      <SyncHistory providerId={providerId} />

      {/* Records browser */}
      <RecordsBrowser providerId={providerId} stats={providerStats} />

      {/* Disconnect */}
      {provider?.authorized && (
        <TouchableOpacity
          style={styles.disconnectButton}
          onPress={handleDisconnect}
          activeOpacity={0.7}
        >
          <Text style={styles.disconnectButtonText}>Disconnect Provider</Text>
        </TouchableOpacity>
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

  // Sync controls
  syncControlsCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
    gap: 12,
  },
  syncControlsTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.text,
  },
  syncButtonRow: {
    flexDirection: "row",
    gap: 8,
  },
  syncButton: {
    flex: 1,
    backgroundColor: colors.accent,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
  },
  syncButtonDisabled: {
    opacity: 0.5,
  },
  syncButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  customSyncRow: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
  },
  customDaysInput: {
    flex: 1,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.text,
  },
  syncRangeButton: {
    flex: 0,
    paddingHorizontal: 16,
  },
  syncProgressContainer: {
    gap: 4,
  },
  syncProgressTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.surfaceSecondary,
    overflow: "hidden",
  },
  syncProgressFill: {
    height: "100%",
    borderRadius: 2,
    backgroundColor: colors.accent,
  },
  syncMessageText: {
    fontSize: 12,
    color: colors.textSecondary,
  },

  // Disconnect
  disconnectButton: {
    backgroundColor: "rgba(239, 68, 68, 0.15)",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 8,
  },
  disconnectButtonText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#ef4444",
  },
});
