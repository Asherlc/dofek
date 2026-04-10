import { formatRelativeTime } from "@dofek/format/format";
import type { ProviderStats } from "@dofek/providers/provider-stats";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import { ProviderLogo } from "../../components/ProviderLogo";
import { ProviderStatsBreakdown } from "../../components/ProviderStatsBreakdown";
import { useAuth } from "../../lib/auth-context";
import { colors } from "../../theme";
import { styles } from "./styles.ts";

export type AuthStatus = "connected" | "not_connected" | "expired";

export interface Provider {
  id: string;
  label: string;
  enabled: boolean;
  authStatus: AuthStatus;
  authType: string;
  lastSyncAt: string | null;
  importOnly: boolean;
}

export interface SyncLog {
  id: string;
  providerId: string;
  dataType: string;
  status: string;
  recordCount: number | null;
  durationMs: number | null;
  errorMessage: string | null;
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

export function providerActionLabel(authStatus: AuthStatus): "Sync" | "Connect" {
  return authStatus === "connected" ? "Sync" : "Connect";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function importProviderLabel(providerId: string | undefined): string {
  switch (providerId) {
    case "apple-health":
      return "Apple Health";
    case "strong-csv":
      return "Strong";
    case "cronometer-csv":
      return "Cronometer";
    default:
      return "Shared file";
  }
}

export function ProviderCard({
  provider,
  stats,
  syncing,
  syncProgress,
  onSync,
  onFullSync,
  onConnect,
  onPress,
}: {
  provider: Provider;
  stats: ProviderStats | undefined;
  syncing: boolean;
  syncProgress: { percentage?: number; message?: string } | undefined;
  onSync: () => void;
  onFullSync: () => void;
  onConnect: () => void;
  onPress: () => void;
}) {
  const { serverUrl } = useAuth();
  const dotColor = statusDotColor(provider.authStatus);
  const lastSyncRelative = provider.lastSyncAt ? formatRelativeTime(provider.lastSyncAt) : null;

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={onPress}
      activeOpacity={0.7}
      testID={`provider-card-${provider.id}`}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleRow}>
          <ProviderLogo provider={provider.id} serverUrl={serverUrl} size={24} />
          <View style={[styles.statusDot, { backgroundColor: dotColor }]} />
          <Text style={styles.cardTitle}>{provider.label}</Text>
        </View>
        {!provider.importOnly && (
          <TouchableOpacity
            style={[styles.syncButton, syncing && styles.syncButtonDisabled]}
            onPress={provider.authStatus === "connected" ? onSync : onConnect}
            activeOpacity={0.7}
            disabled={syncing}
          >
            {syncing ? (
              <ActivityIndicator color={colors.text} size="small" />
            ) : (
              <Text style={styles.syncButtonText}>{providerActionLabel(provider.authStatus)}</Text>
            )}
          </TouchableOpacity>
        )}
      </View>

      {syncing && syncProgress ? (
        <View style={styles.syncProgressContainer}>
          {syncProgress.percentage != null && (
            <View style={styles.syncProgressTrack}>
              <View
                style={[
                  styles.syncProgressFill,
                  {
                    width: `${Math.max(0, Math.min(100, syncProgress.percentage))}%`,
                  },
                ]}
              />
            </View>
          )}
          {syncProgress.message ? (
            <Text style={styles.syncProgressMessage}>{syncProgress.message}</Text>
          ) : null}
        </View>
      ) : (
        <View style={styles.cardMeta}>
          {!syncing && syncProgress?.message ? (
            <Text style={styles.cardMetaText}>{syncProgress.message}</Text>
          ) : (
            <Text style={styles.cardMetaText}>
              {provider.importOnly ? "Import only" : statusLabel(provider.authStatus)}
            </Text>
          )}
          {!provider.importOnly &&
            (lastSyncRelative ? (
              <Text style={styles.cardMetaText}>Last sync: {lastSyncRelative}</Text>
            ) : (
              <Text style={styles.cardMetaText}>Never synced</Text>
            ))}
          {provider.authStatus === "connected" && !syncing && !provider.importOnly && (
            <TouchableOpacity onPress={onFullSync} activeOpacity={0.7}>
              <Text style={styles.fullSyncLink}>Full sync</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {stats && <ProviderStatsBreakdown stats={stats} />}
    </TouchableOpacity>
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
