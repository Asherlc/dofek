import { formatDurationSeconds, formatRelativeTime } from "@dofek/format/format";
import type { ProviderStats } from "@dofek/providers/provider-stats";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import { OperationProgressBar } from "../../components/OperationProgressBar";
import { ProviderLogo } from "../../components/ProviderLogo";
import { ProviderStatsBreakdown } from "../../components/ProviderStatsBreakdown";
import { useAuth } from "../../lib/auth-context";
import { colors } from "../../theme";
import { FileImportButton } from "./file-import-button.tsx";
import { styles } from "./styles.ts";

export type AuthStatus = "connected" | "not_connected" | "expired";

export interface Provider {
  id: string;
  label: string;
  enabled: boolean;
  authStatus: AuthStatus;
  authType: string;
  tokenAuth?: { label: string; instructionsUrl: string } | null;
  lastSyncAt: string | null;
  importOnly: boolean;
  pushOnly: boolean;
}

export interface SyncLog {
  id: string;
  providerId: string;
  dataType: string;
  status: string;
  recordCount: number | null;
  durationMs: number | null;
  errorMessage: string | null;
  authFailureReason: string | null;
  syncedAt: string;
}

function statusDotColor(authStatus: AuthStatus): string {
  switch (authStatus) {
    case "connected":
      return colors.positive;
    case "expired":
      return colors.warning;
    case "not_connected":
      return colors.textTertiary;
  }
}

function statusLabel(authStatus: AuthStatus): string {
  switch (authStatus) {
    case "connected":
      return "Connected";
    case "expired":
      return "Expired";
    case "not_connected":
      return "Not connected";
  }
}

export function providerActionLabel(authStatus: AuthStatus): "Sync" | "Connect" | "Reconnect" {
  return authStatus === "connected" ? "Sync" : authStatus === "expired" ? "Reconnect" : "Connect";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return formatDurationSeconds(ms / 1000);
}

const IMPORT_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  "apple-health": "Apple Health",
  "strong-csv": "Strong",
  "cronometer-csv": "Cronometer",
  "garmin-dump": "Garmin Dump",
  "fit-file": "FIT File",
  "kaya-export": "Kaya",
};

export function importProviderLabel(providerId: string | undefined): string {
  return providerId ? (IMPORT_PROVIDER_LABELS[providerId] ?? "Shared file") : "Shared file";
}

export function ProviderCard({
  provider,
  stats,
  syncing,
  importing = false,
  syncProgress,
  onSync,
  onFullSync,
  onConnect,
  onImport,
  onPress,
}: {
  provider: Provider;
  stats: ProviderStats | undefined;
  syncing: boolean;
  importing?: boolean;
  syncProgress: { percentage?: number; message?: string; failedCount?: number } | undefined;
  onSync: () => void;
  onFullSync?: () => void;
  onConnect: () => void;
  onImport?: () => void;
  onPress: () => void;
}) {
  const { serverUrl } = useAuth();
  const dotColor = statusDotColor(provider.authStatus);
  const lastSyncRelative = provider.lastSyncAt ? formatRelativeTime(provider.lastSyncAt) : null;
  const canRunManualSync = !provider.importOnly && !provider.pushOnly;
  const canImport = onImport !== undefined;
  const showingProgress = (syncing || importing) && syncProgress !== undefined;

  return (
    <View style={styles.card} testID={`provider-card-${provider.id}`}>
      <View style={styles.cardHeader}>
        <TouchableOpacity
          style={styles.cardTitleRow}
          onPress={onPress}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`Open ${provider.label} details`}
        >
          <ProviderLogo provider={provider.id} serverUrl={serverUrl} size={24} />
          <View style={[styles.statusDot, { backgroundColor: dotColor }]} />
          <Text style={styles.cardTitle}>{provider.label}</Text>
        </TouchableOpacity>
        {(canRunManualSync || canImport) && (
          <View style={styles.cardActions}>
            {canRunManualSync ? (
              <TouchableOpacity
                style={[styles.syncButton, syncing && styles.syncButtonDisabled]}
                onPress={provider.authStatus === "connected" ? onSync : onConnect}
                activeOpacity={0.7}
                disabled={syncing}
                accessibilityRole="button"
                accessibilityLabel={`${providerActionLabel(provider.authStatus)} ${provider.label}`}
                accessibilityState={{ busy: syncing, disabled: syncing }}
              >
                {syncing ? (
                  <ActivityIndicator color={colors.text} size="small" />
                ) : (
                  <Text style={styles.syncButtonText}>
                    {providerActionLabel(provider.authStatus)}
                  </Text>
                )}
              </TouchableOpacity>
            ) : null}
            {canImport ? (
              <FileImportButton
                accessibilityLabel={`Import file for ${provider.label}`}
                disabled={importing}
                loading={importing}
                onPress={onImport}
              />
            ) : null}
          </View>
        )}
      </View>

      {showingProgress ? (
        <View style={styles.syncProgressContainer}>
          <OperationProgressBar
            fillTestID={`provider-card-${provider.id}-progress-fill`}
            percentage={syncProgress.percentage}
            message={syncProgress.message}
          />
          {typeof syncProgress.failedCount === "number" && syncProgress.failedCount > 0 && (
            <Text style={styles.syncProgressFailedCount}>
              {syncProgress.failedCount.toLocaleString()} file
              {syncProgress.failedCount === 1 ? "" : "s"} failed
            </Text>
          )}
        </View>
      ) : (
        <View style={styles.cardMeta}>
          {!showingProgress && syncProgress?.message ? (
            <Text style={styles.cardMetaText}>{syncProgress.message}</Text>
          ) : (
            <Text style={styles.cardMetaText}>
              {provider.importOnly
                ? "Import only"
                : provider.pushOnly
                  ? "Push only"
                  : statusLabel(provider.authStatus)}
            </Text>
          )}
          {canRunManualSync &&
            (lastSyncRelative ? (
              <Text style={styles.cardMetaText}>Last sync: {lastSyncRelative}</Text>
            ) : (
              <Text style={styles.cardMetaText}>Never synced</Text>
            ))}
          {canRunManualSync &&
            provider.authStatus === "connected" &&
            onFullSync !== undefined &&
            !syncing && (
              <TouchableOpacity
                onPress={onFullSync}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Full sync"
              >
                <Text style={styles.fullSyncLink}>Full sync</Text>
              </TouchableOpacity>
            )}
        </View>
      )}

      {stats && <ProviderStatsBreakdown stats={stats} />}
    </View>
  );
}

export function SyncLogRow({ log }: { log: SyncLog }) {
  const isError = log.status === "error";

  return (
    <View style={styles.logRow}>
      <View style={styles.logLeft}>
        <View style={styles.logTitleRow}>
          <View
            style={[
              styles.statusDot,
              { backgroundColor: isError ? colors.danger : colors.positive },
            ]}
          />
          <Text style={styles.logProvider}>{log.providerId}</Text>
          <Text style={styles.logDataType}>{log.dataType}</Text>
        </View>
        <View style={styles.logDetails}>
          <Text style={styles.logDetailText}>
            {(log.recordCount ?? 0).toLocaleString()} records
          </Text>
          <Text style={styles.logDetailText}>{formatDuration(log.durationMs ?? 0)}</Text>
          <Text style={styles.logDetailText}>{formatRelativeTime(log.syncedAt) ?? ""}</Text>
        </View>
        {isError && log.errorMessage ? (
          <Text style={styles.logError} numberOfLines={2}>
            {log.errorMessage}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
