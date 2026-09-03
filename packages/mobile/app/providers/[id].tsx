import { formatRelativeTime } from "@dofek/format/format";
import { providerHealth } from "@dofek/providers/provider-health";
import type { ProviderStats } from "@dofek/providers/provider-stats";
import { DATA_TYPE_LABELS } from "@dofek/providers/provider-stats";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
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
import { ProviderSyncHistoryEntry } from "../../components/ProviderSyncHistoryEntry";
import { getQueryErrorMessage, QueryStatePanel } from "../../components/QueryStatePanel";
import { useAuth } from "../../lib/auth-context";
import { trpc } from "../../lib/trpc";
import { useProcessingStatus } from "../../lib/useProcessingStatus";
import { useRefresh } from "../../lib/useRefresh";
import { colors } from "../../theme";
import { ProviderDetailAuthModals } from "./auth-modals";
import { ProviderDangerZone } from "./provider-danger-zone";
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
  const priorityCols = [
    "id",
    "name",
    "date",
    "started_at",
    "recorded_at",
    "canonical_type",
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

function SyncHistory({ providerId, providerName }: { providerId: string; providerName: string }) {
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
        {rows.map((row) => (
          <ProviderSyncHistoryEntry key={row.id} providerName={providerName} entry={row} />
        ))}
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
    gap: 8,
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
        accessibilityRole="tablist"
        accessibilityLabel="Record types"
      >
        {availableTypes.map((dt) => (
          <TouchableOpacity
            key={dt.key}
            onPress={() => setActiveTab(dt.key)}
            style={[tabStyles.tab, activeTab === dt.key && tabStyles.activeTab]}
            activeOpacity={0.7}
            accessibilityRole="tab"
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
      onOpenClinicalRecords={() => router.push("/clinical-records")}
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
  onOpenClinicalRecords,
}: {
  providerId: string;
  providerActions: ProviderDetailActionsResult;
  displayProvider: NonNullable<ProviderDetailActionsResult["displayProvider"]>;
  onOpenClinicalRecords: () => void;
}) {
  const { serverUrl } = useAuth();
  const trpcUtils = trpc.useUtils();

  const stats = trpc.sync.providerStats.useQuery();
  const processingStatus = useProcessingStatus({ providerId });
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
    syncDateRange,
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
          syncDateRange={syncDateRange}
          shouldShowFullSync={shouldShowFullSync}
          shouldShowAppleHealthPermissionBanner={shouldShowAppleHealthPermissionBanner}
          shouldShowAppleHealthClinicalRecords={providerId === "apple_health"}
          shouldShowClinicalRecordsLink={
            providerId === "apple_health" && (providerStats?.clinicalRecords ?? 0) > 0
          }
          onPrimaryAction={() => void handlePrimaryAction()}
          onFullSync={() => void handleFullSync()}
          onOpenClinicalRecords={onOpenClinicalRecords}
        />
      )}

      {/* Provider-specific extras */}
      <ProviderDetailExtras providerId={providerId} />

      {/* Stats overview */}
      {providerStats && <ProviderStatsBreakdown stats={providerStats} variant="full" />}

      {/* Sync history */}
      <Text style={styles.sectionTitle}>Sync History</Text>
      <SyncHistory providerId={providerId} providerName={displayProvider.name} />

      {/* Records browser */}
      <RecordsBrowser providerId={providerId} stats={providerStats} />

      {/* Disconnect */}
      <ProviderDangerZone
        canDisconnect={Boolean(provider?.authorized)}
        providerId={providerId}
        providerName={displayProvider.name}
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
    color: colors.textInverse,
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
});
