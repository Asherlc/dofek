import { formatDurationSeconds, formatRelativeTime, formatTime } from "@dofek/format/format";
import { providerHealth } from "@dofek/providers/provider-health";
import type { ProviderStats } from "@dofek/providers/provider-stats";
import { DATA_TYPE_LABELS } from "@dofek/providers/provider-stats";
import { statusColors } from "@dofek/scoring/colors";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { ProcessingStatusWidget } from "../../components/ProcessingStatusWidget";
import { ProviderLogo } from "../../components/ProviderLogo";
import { ProviderStatsBreakdown } from "../../components/ProviderStatsBreakdown";
import { getQueryErrorMessage, QueryStatePanel } from "../../components/QueryStatePanel";
import { useAuth } from "../../lib/auth-context";
import { captureException } from "../../lib/telemetry";
import { trpc } from "../../lib/trpc";
import { useProcessingStatus } from "../../lib/useProcessingStatus";
import { useRefresh } from "../../lib/useRefresh";
import { colors } from "../../theme";
import { ProviderDetailAuthModals } from "./auth-modals";
import { ProviderDataDeleteControl } from "./provider-data-delete-control";
import { ProviderDetailActionsCard } from "./provider-detail-actions-card";
import { ProviderDetailExtras } from "./provider-detail-extras";
import {
  formatCellValue,
  formatColumnName,
  recordAccessibilityLabel,
} from "./provider-detail-record-format";
import { ProviderRecordDetailModal } from "./provider-record-detail-modal";
import {
  type ProviderDetailActionsResult,
  useProviderDetailActions,
} from "./use-provider-detail-actions";

type DataType = (typeof DATA_TYPE_LABELS)[number]["key"];

function formatProviderName(id: string): string {
  return id
    .split(/[_-]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

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

  const [lastProviderId, setLastProviderId] = useState(providerId);
  if (providerId !== lastProviderId) {
    setPage(0);
    setLastProviderId(providerId);
    setSelectedRecord(null);
  }

  if (records.isLoading) {
    return (
      <View style={recordStyles.emptyContainer}>
        <ActivityIndicator color={colors.accent} size="small" />
      </View>
    );
  }

  if (records.isError) {
    return (
      <View style={recordStyles.emptyContainer}>
        <Text style={recordStyles.errorText}>
          {records.error?.message ?? "Failed to load records."}
        </Text>
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
            accessibilityRole="button"
            accessibilityLabel={recordAccessibilityLabel(row, visibleColumns, idx + 1)}
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
          accessibilityRole="button"
          accessibilityLabel="Previous records page"
          accessibilityState={{ disabled: page === 0 }}
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
          accessibilityRole="button"
          accessibilityLabel="Next records page"
          accessibilityState={{ disabled: rows.length < pageSize }}
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
        <ProviderRecordDetailModal
          record={selectedRecord}
          onClose={() => setSelectedRecord(null)}
          activityId={
            dataType === "activities" && typeof selectedRecord.id === "string"
              ? selectedRecord.id
              : undefined
          }
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
  errorText: {
    fontSize: 13,
    color: colors.danger,
    textAlign: "center",
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
                  <Text style={syncStyles.metaText}>
                    {formatDurationSeconds(row.durationMs / 1000)}
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
          accessibilityRole="button"
          accessibilityLabel="Previous sync history page"
          accessibilityState={{ disabled: page === 0 }}
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
          accessibilityRole="button"
          accessibilityLabel="Next sync history page"
          accessibilityState={{ disabled: rows.length < pageSize }}
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
  const availability = trpc.providerDetail.availableDataTypes.useQuery({ providerId });
  const availableTypes = DATA_TYPE_LABELS.filter((dataType) =>
    availability.data?.includes(dataType.key),
  );

  const [activeTab, setActiveTab] = useState<DataType>("activities");
  const [lastProviderId, setLastProviderId] = useState(providerId);

  if (providerId !== lastProviderId) {
    setLastProviderId(providerId);
    setActiveTab(availableTypes[0]?.key ?? "activities");
  }

  const activeTabAvailable = availableTypes.some((dt) => dt.key === activeTab);
  if (stats && availableTypes.length > 0 && !activeTabAvailable) {
    setActiveTab(availableTypes[0]?.key ?? "activities");
  }

  if (availability.isLoading) {
    return (
      <View>
        <Text style={styles.sectionTitle}>Records</Text>
        <View style={recordStyles.emptyContainer}>
          <ActivityIndicator color={colors.accent} size="small" />
        </View>
      </View>
    );
  }

  if (availability.isError) {
    return (
      <View>
        <Text style={styles.sectionTitle}>Records</Text>
        <QueryStatePanel variant="error" message={getQueryErrorMessage(availability.error)} />
      </View>
    );
  }

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
            accessibilityRole="button"
            accessibilityLabel={dt.label}
            accessibilityState={{ selected: activeTab === dt.key }}
          >
            <Text style={[tabStyles.tabText, activeTab === dt.key && tabStyles.activeTabText]}>
              {dt.label}
              {stats && stats[dt.key] > 0 ? ` (${stats[dt.key].toLocaleString()})` : ""}
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
  const router = useRouter();
  const providerActions = useProviderDetailActions(providerId);

  if (providerActions.isLoading || !providerId) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  if (providerActions.inventoryError && !providerActions.displayProvider) {
    return (
      <ProviderRouteError
        title="Could not load provider"
        message={getQueryErrorMessage(
          providerActions.inventoryError,
          "The provider list is temporarily unavailable.",
        )}
        onBack={() => router.dismissTo("/providers")}
      />
    );
  }

  if (!providerActions.displayProvider) {
    return (
      <ProviderRouteError
        title="Provider not found"
        message="This provider is unavailable. Return to Data Sources to choose another."
        onBack={() => router.dismissTo("/providers")}
      />
    );
  }

  return (
    <ProviderDetailContent
      providerId={providerId}
      providerActions={providerActions}
      displayProvider={providerActions.displayProvider}
    />
  );
}

function ProviderRouteError({
  title,
  message,
  onBack,
}: {
  title: string;
  message: string;
  onBack: () => void;
}) {
  return (
    <View style={styles.routeErrorContainer}>
      <QueryStatePanel variant="error" title={title} message={message} />
      <TouchableOpacity
        style={styles.backToProvidersButton}
        onPress={onBack}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="Back to Data Sources"
      >
        <Text style={styles.backToProvidersButtonText}>Back to Data Sources</Text>
      </TouchableOpacity>
    </View>
  );
}

function ProviderDetailContent({
  providerId,
  providerActions,
  displayProvider,
}: {
  providerId: string;
  providerActions: ProviderDetailActionsResult;
  displayProvider: NonNullable<ProviderDetailActionsResult["displayProvider"]>;
}) {
  const { serverUrl } = useAuth();
  const router = useRouter();
  const trpcUtils = trpc.useUtils();

  const stats = trpc.sync.providerStats.useQuery();
  const processingStatus = useProcessingStatus({ providerId });
  const disconnectMutation = trpc.providerDetail.disconnect.useMutation();
  const providerStats = (stats.data ?? []).find(
    (s: { providerId: string }) => s.providerId === providerId,
  );
  const {
    provider,
    isConnected,
    primaryActionLabel,
    isSyncing,
    syncMessage,
    syncProgress,
    shouldShowActions,
    shouldShowFullSync,
    shouldShowAppleHealthPermissionBanner,
    handlePrimaryAction,
    handleFullSync,
    modals,
  } = providerActions;
  const health = providerHealth({
    authorized: isConnected,
    needsReauth: Boolean(provider?.needsReauth),
    requiresAuthorization: displayProvider.authType !== "none",
  });

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
            } catch (error: unknown) {
              captureException(error, { context: "provider-disconnect" });
              Alert.alert("Error", "Failed to disconnect provider");
            }
          },
        },
      ],
    );
  }, [providerId, disconnectMutation, trpcUtils, router]);

  const { refreshing, onRefresh } = useRefresh({
    invalidate: () =>
      Promise.all([
        trpcUtils.providerDetail.availableDataTypes.invalidate({ providerId }),
        trpcUtils.providerDetail.records.invalidate({ providerId }),
        trpcUtils.providerDetail.logs.invalidate({ providerId }),
        trpcUtils.sync.providers.invalidate(),
        trpcUtils.sync.providerStats.invalidate(),
        trpcUtils.processing.status.invalidate(),
      ]).then(() => undefined),
  });

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
            <View style={styles.providerNameRow}>
              <ProviderLogo provider={providerId} serverUrl={serverUrl} size={28} />
              <Text style={styles.providerName}>
                {displayProvider?.name ?? formatProviderName(providerId)}
              </Text>
            </View>
            {displayProvider && (
              <View style={styles.statusColumn}>
                <View style={styles.statusRow}>
                  <Text style={styles.statusLabel}>Connection</Text>
                  <Text
                    style={
                      health.connection.status === "healthy"
                        ? styles.statusConnected
                        : styles.statusDisconnected
                    }
                  >
                    {health.connection.label}
                  </Text>
                </View>
                <View style={styles.statusRow}>
                  <Text style={styles.statusLabel}>Authorization</Text>
                  <Text
                    style={
                      health.authorization.status === "warning"
                        ? styles.statusWarning
                        : health.authorization.status === "healthy"
                          ? styles.statusConnected
                          : styles.statusDisconnected
                    }
                  >
                    {health.authorization.label}
                  </Text>
                </View>
                {displayProvider.lastSyncedAt &&
                  formatRelativeTime(displayProvider.lastSyncedAt) && (
                    <Text style={styles.lastSync}>
                      Last sync: {formatRelativeTime(displayProvider.lastSyncedAt)}
                    </Text>
                  )}
              </View>
            )}
          </View>
          {health.requiresReconnect && (
            <TouchableOpacity
              style={styles.reauthorizeButton}
              onPress={() => void handlePrimaryAction()}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Reconnect ${displayProvider.name}`}
            >
              <Text style={styles.reauthorizeButtonText}>Reconnect</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      <ProcessingStatusWidget
        data={processingStatus.data}
        error={processingStatus.error}
        loading={processingStatus.isLoading}
        contextLabel={`${formatProviderName(providerId)} data status`}
        alwaysVisible
      />

      {providerActions.inventoryError ? (
        <QueryStatePanel
          variant="error"
          title="Could not refresh provider"
          message={getQueryErrorMessage(providerActions.inventoryError)}
          minHeight={72}
        />
      ) : null}

      {stats.error ? (
        <QueryStatePanel
          variant="error"
          title={
            stats.data === undefined
              ? "Could not load provider statistics"
              : "Could not refresh provider statistics"
          }
          message={getQueryErrorMessage(stats.error)}
          minHeight={72}
        />
      ) : null}

      {/* Actions */}
      {shouldShowActions && (
        <ProviderDetailActionsCard
          primaryActionLabel={primaryActionLabel}
          isSyncing={isSyncing}
          syncMessage={syncMessage}
          syncProgress={syncProgress}
          shouldShowFullSync={shouldShowFullSync}
          shouldShowAppleHealthPermissionBanner={shouldShowAppleHealthPermissionBanner}
          onPrimaryAction={() => void handlePrimaryAction()}
          onFullSync={() => void handleFullSync()}
        />
      )}

      {/* Provider-specific extras */}
      <ProviderDetailExtras providerId={providerId} />

      {/* Stats overview */}
      {providerStats && <ProviderStatsBreakdown stats={providerStats} variant="full" />}

      {/* Sync history */}
      <Text style={styles.sectionTitle}>Sync History</Text>
      <SyncHistory providerId={providerId} />

      {/* Records browser */}
      <RecordsBrowser providerId={providerId} stats={providerStats} />

      {/* Disconnect */}
      <ProviderDataDeleteControl
        providerId={providerId}
        additionalOperations={
          isSyncing
            ? [
                {
                  id: "provider-sync",
                  label: "Provider sync",
                  percentage: syncProgress ?? undefined,
                  message: syncMessage ?? "Syncing provider data...",
                },
              ]
            : []
        }
      />
      {provider?.authorized && (
        <TouchableOpacity
          style={styles.disconnectButton}
          onPress={handleDisconnect}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Disconnect Provider"
        >
          <Text style={styles.disconnectButtonText}>Disconnect Provider</Text>
        </TouchableOpacity>
      )}
      <ProviderDetailAuthModals modals={modals} />
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
  routeErrorContainer: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: "center",
    padding: 16,
    gap: 16,
  },
  backToProvidersButton: {
    alignSelf: "center",
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  backToProvidersButtonText: {
    color: colors.background,
    fontSize: 14,
    fontWeight: "600",
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
  providerNameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
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
  },
  statusColumn: { gap: 4, marginTop: 6 },
  statusLabel: { color: colors.textTertiary, fontSize: 12 },
  statusConnected: {
    fontSize: 13,
    color: colors.positive,
  },
  statusDisconnected: {
    fontSize: 13,
    color: colors.textTertiary,
  },
  statusWarning: { color: colors.warning, fontSize: 13 },
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
    color: statusColors.danger,
  },
});
