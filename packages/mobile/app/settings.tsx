import { File as ExpoFile, Paths } from "expo-file-system";
import { useRouter } from "expo-router";
import * as Sharing from "expo-sharing";
import * as Updates from "expo-updates";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { z } from "zod";
import { PersonalizationPanel } from "../components/PersonalizationPanel";
import { ProviderLogo } from "../components/ProviderLogo";
import { SlackIntegrationPanel } from "../components/SlackIntegrationPanel";
import { useAuth } from "../lib/auth-context";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { useRefresh } from "../lib/useRefresh";
import { colors } from "../theme";

type UnitSystem = "metric" | "imperial";

const UNIT_OPTIONS: { value: UnitSystem; label: string; description: string }[] = [
  { value: "metric", label: "Metric", description: "kg, km, °C" },
  { value: "imperial", label: "Imperial", description: "lbs, mi, °F" },
];

type ExportState = "idle" | "processing" | "done" | "error";

const ExportTriggerSchema = z.object({
  exportId: z.string(),
  status: z.literal("queued"),
});

const DataExportSchema = z.object({
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  errorMessage: z.string().nullable(),
  expiresAt: z.string(),
  filename: z.string(),
  id: z.string(),
  sizeBytes: z.number().nullable(),
  startedAt: z.string().nullable(),
  status: z.enum(["queued", "processing", "completed", "failed"]),
});

const ExportListSchema = z.object({ exports: z.array(DataExportSchema) });
type DataExport = z.infer<typeof DataExportSchema>;

function formatLocalizedDateTime(date: Date | null | undefined): string {
  if (!date) return "n/a";
  return date.toLocaleString();
}

function formatExportSize(sizeBytes: number | null): string {
  if (sizeBytes == null) return "Size pending";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatExportDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function SettingsScreen() {
  const auth = useAuth();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const isWide = width >= 600;
  const trpcUtils = trpc.useUtils();

  // ── Data Sources ──
  const providers = trpc.sync.providers.useQuery();

  // ── Data Export ──
  const [exportState, setExportState] = useState<ExportState>("idle");
  const [exportMessage, setExportMessage] = useState("");
  const [dataExports, setDataExports] = useState<DataExport[]>([]);
  const [exportsLoading, setExportsLoading] = useState(true);
  const [downloadingExportId, setDownloadingExportId] = useState<string | null>(null);

  // ── Unit System ──
  const unitSetting = trpc.settings.get.useQuery({ key: "unitSystem" });
  const setSettingMutation = trpc.settings.set.useMutation();
  const deleteAllDataMutation = trpc.settings.deleteAllUserData.useMutation({
    onSuccess: async () => {
      await trpcUtils.invalidate();
      Alert.alert("Data Deleted", "All synced and manually-entered data has been deleted.");
    },
    onError: (error) => Alert.alert("Error", error.message),
  });

  const currentUnitSystem: UnitSystem =
    unitSetting.data?.value === "imperial" ? "imperial" : "metric";

  // ── Goal Weight ──
  const goalWeightSetting = trpc.settings.get.useQuery({ key: "goalWeight" });
  const goalWeightMutation = trpc.bodyAnalytics.setGoalWeight.useMutation({
    onSuccess: () => {
      goalWeightSetting.refetch();
      trpcUtils.bodyAnalytics.weightPrediction.invalidate();
    },
  });
  const currentGoalKg =
    goalWeightSetting.data?.value != null ? Number(goalWeightSetting.data.value) : null;
  const [goalInput, setGoalInput] = useState("");
  const [editingGoal, setEditingGoal] = useState(false);
  const isImperial = currentUnitSystem === "imperial";
  const kgToLbs = 2.20462;

  function handleUnitChange(value: UnitSystem) {
    trpcUtils.settings.get.setData({ key: "unitSystem" }, { key: "unitSystem", value });
    setSettingMutation.mutate(
      { key: "unitSystem", value },
      {
        onSuccess: () => unitSetting.refetch(),
        onError: () => unitSetting.refetch(),
      },
    );
  }

  function handleLogout() {
    Alert.alert("Log Out", "Are you sure you want to log out?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Log Out",
        style: "destructive",
        onPress: () => auth.logout(),
      },
    ]);
  }

  const loadExports = useCallback(async () => {
    try {
      const response = await fetch(`${auth.serverUrl}/api/export`, {
        headers: { Authorization: `Bearer ${auth.sessionToken}` },
      });
      if (!response.ok) {
        throw new Error("Failed to load exports");
      }
      const parsed = ExportListSchema.parse(await response.json());
      setDataExports(parsed.exports);
      setExportMessage("");
    } catch (error: unknown) {
      captureException(error, { context: "data-export-list" });
      setExportMessage(error instanceof Error ? error.message : "Failed to load exports");
    } finally {
      setExportsLoading(false);
    }
  }, [auth.serverUrl, auth.sessionToken]);

  useEffect(() => {
    loadExports();
  }, [loadExports]);

  async function handleExport() {
    setExportState("processing");
    setExportMessage("Starting export...");

    try {
      const triggerRes = await fetch(`${auth.serverUrl}/api/export`, {
        method: "POST",
        headers: { Authorization: `Bearer ${auth.sessionToken}` },
      });

      if (!triggerRes.ok) {
        setExportState("error");
        setExportMessage("Failed to start export");
        return;
      }

      ExportTriggerSchema.parse(await triggerRes.json());
      setExportState("done");
      await loadExports();
    } catch (error: unknown) {
      captureException(error, { context: "data-export" });
      setExportState("error");
      setExportMessage("Network error during export");
    }
  }

  async function handleDownloadExport(dataExport: DataExport) {
    setDownloadingExportId(dataExport.id);
    setExportMessage("Downloading...");
    try {
      const downloadRes = await fetch(`${auth.serverUrl}/api/export/download/${dataExport.id}`, {
        headers: { Authorization: `Bearer ${auth.sessionToken}` },
      });
      if (!downloadRes.ok) {
        throw new Error("Failed to download export");
      }
      const blob = await downloadRes.blob();
      const file = new ExpoFile(Paths.cache, "health-export.zip");
      const arrayBuffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      file.write(bytes);
      setExportState("done");
      setExportMessage("Export ready");
      await Sharing.shareAsync(file.uri, {
        mimeType: "application/zip",
        dialogTitle: "Save Health Data Export",
      });
    } catch (error: unknown) {
      captureException(error, { context: "data-export-download" });
      setExportState("error");
      setExportMessage(error instanceof Error ? error.message : "Failed to download export");
    } finally {
      setDownloadingExportId(null);
    }
  }

  function handleDeleteAllUserData() {
    Alert.alert(
      "Delete All User Data",
      "Delete all synced and manually-entered data? This action cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => deleteAllDataMutation.mutate(),
        },
      ],
    );
  }

  const { refreshing, onRefresh } = useRefresh();
  const activeExports = dataExports.filter(
    (dataExport) => dataExport.status === "queued" || dataExport.status === "processing",
  );
  const completedExports = dataExports.filter((dataExport) => dataExport.status === "completed");
  const hasActiveExport = activeExports.length > 0;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, isWide && styles.contentWide]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.textSecondary}
        />
      }
    >
      {/* ── Data Sources ── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Data Sources</Text>
        <Text style={styles.sectionDescription}>Connect and manage health data providers</Text>
        <TouchableOpacity
          style={styles.card}
          onPress={() => router.push("/providers")}
          activeOpacity={0.7}
        >
          <View style={styles.dataSourcesRow}>
            <View style={styles.dataSourcesInfo}>
              {providers.isLoading ? (
                <ActivityIndicator color={colors.accent} size="small" />
              ) : (
                <>
                  <View style={styles.providerLogos}>
                    {(providers.data ?? [])
                      .filter((provider) => provider.authorized)
                      .slice(0, 5)
                      .map((provider) => (
                        <ProviderLogo
                          key={provider.id}
                          provider={provider.id}
                          serverUrl={auth.serverUrl}
                          size={20}
                        />
                      ))}
                  </View>
                  <Text style={styles.dataSourcesCount}>
                    {(providers.data ?? []).filter((provider) => provider.authorized).length}{" "}
                    connected
                  </Text>
                </>
              )}
            </View>
            <Text style={styles.devToolChevron}>›</Text>
          </View>
        </TouchableOpacity>
      </View>

      {/* ── Units ── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Units</Text>
        <Text style={styles.sectionDescription}>Choose how measurements are displayed</Text>
        <View style={styles.unitRow}>
          {UNIT_OPTIONS.map((option) => {
            const isSelected = currentUnitSystem === option.value;
            return (
              <TouchableOpacity
                key={option.value}
                style={[styles.unitButton, isSelected && styles.unitButtonSelected]}
                onPress={() => handleUnitChange(option.value)}
                activeOpacity={0.7}
                disabled={setSettingMutation.isPending}
              >
                <Text style={[styles.unitLabel, isSelected && styles.unitLabelSelected]}>
                  {option.label}
                </Text>
                <Text style={styles.unitDescription}>{option.description}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* ── Goal Weight ── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Goal Weight</Text>
        <Text style={styles.sectionDescription}>
          Set a target weight to see projected completion dates
        </Text>
        <View style={styles.card}>
          {editingGoal ? (
            <View style={styles.goalEditRow}>
              <TextInput
                style={styles.goalInput}
                value={goalInput}
                onChangeText={setGoalInput}
                keyboardType="decimal-pad"
                placeholder={isImperial ? "lbs" : "kg"}
                placeholderTextColor={colors.textSecondary}
              />
              <TouchableOpacity
                style={styles.goalSaveButton}
                onPress={() => {
                  const parsed = Number.parseFloat(goalInput);
                  if (!Number.isNaN(parsed) && parsed > 0) {
                    const weightKg = isImperial ? parsed / kgToLbs : parsed;
                    goalWeightMutation.mutate({ weightKg });
                  }
                  setEditingGoal(false);
                }}
              >
                <Text style={styles.goalSaveText}>Save</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setEditingGoal(false)}>
                <Text style={styles.goalCancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          ) : currentGoalKg != null ? (
            <View style={styles.goalDisplayRow}>
              <Text style={styles.goalDisplayText}>
                {(isImperial ? currentGoalKg * kgToLbs : currentGoalKg).toFixed(1)}{" "}
                {isImperial ? "lbs" : "kg"}
              </Text>
              <TouchableOpacity
                onPress={() => {
                  setGoalInput(
                    String(
                      Math.round((isImperial ? currentGoalKg * kgToLbs : currentGoalKg) * 10) / 10,
                    ),
                  );
                  setEditingGoal(true);
                }}
              >
                <Text style={styles.goalEditText}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => goalWeightMutation.mutate({ weightKg: null })}>
                <Text style={styles.goalCancelText}>Clear</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              onPress={() => {
                setGoalInput("");
                setEditingGoal(true);
              }}
            >
              <Text style={styles.goalEditText}>Set Goal Weight</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* ── Algorithm Personalization ── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Algorithm Personalization</Text>
        <Text style={styles.sectionDescription}>
          Parameters are automatically learned from your data
        </Text>
        <View style={styles.card}>
          <PersonalizationPanel />
        </View>
      </View>

      {/* ── Integrations ── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Integrations</Text>
        <Text style={styles.sectionDescription}>Connect external services</Text>
        <View style={styles.card}>
          <SlackIntegrationPanel />
        </View>
      </View>

      {/* ── Data Export ── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Data Export</Text>
        <Text style={styles.sectionDescription}>
          Create a ZIP file containing CSV files for your health data
        </Text>
        <View style={styles.card}>
          {hasActiveExport && (
            <View style={styles.exportStatusContainer}>
              <Text style={styles.exportStatusTitle}>Export in progress</Text>
              <Text style={styles.exportMessageText}>We'll email you when it finishes.</Text>
            </View>
          )}
          {exportState === "done" && !hasActiveExport && (
            <Text style={styles.exportDoneText}>{exportMessage}</Text>
          )}
          {exportState === "error" && <Text style={styles.exportErrorText}>{exportMessage}</Text>}
          <TouchableOpacity
            style={[
              styles.exportButton,
              (exportState === "processing" || hasActiveExport) && styles.exportButtonDisabled,
            ]}
            onPress={handleExport}
            activeOpacity={0.7}
            disabled={exportState === "processing" || hasActiveExport}
          >
            <Text style={styles.exportButtonText}>
              {exportState === "processing"
                ? "Starting..."
                : hasActiveExport
                  ? "Export Running"
                  : "Start Export"}
            </Text>
          </TouchableOpacity>
          <View style={styles.exportListContainer}>
            <Text style={styles.exportListTitle}>Available exports</Text>
            {exportsLoading ? (
              <Text style={styles.exportMessageText}>Loading exports...</Text>
            ) : completedExports.length === 0 ? (
              <Text style={styles.exportMessageText}>No exports available.</Text>
            ) : (
              completedExports.map((dataExport) => (
                <View key={dataExport.id} style={styles.exportListRow}>
                  <View style={styles.exportListInfo}>
                    <Text style={styles.exportFilename}>{dataExport.filename}</Text>
                    <Text style={styles.exportMessageText}>
                      {formatExportSize(dataExport.sizeBytes)} - Expires{" "}
                      {formatExportDate(dataExport.expiresAt)}
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => handleDownloadExport(dataExport)}
                    activeOpacity={0.7}
                    disabled={downloadingExportId === dataExport.id}
                  >
                    <Text style={styles.exportDownloadText}>
                      {downloadingExportId === dataExport.id
                        ? "Downloading..."
                        : `Download ${dataExport.filename}`}
                    </Text>
                  </TouchableOpacity>
                </View>
              ))
            )}
          </View>
        </View>
      </View>

      {/* ── Developer Tools ── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Developer Tools</Text>
        <Text style={styles.sectionDescription}>Debugging and diagnostics</Text>
        <View style={styles.card}>
          <TouchableOpacity
            style={styles.devToolRow}
            onPress={() => {
              const { router } = require("expo-router");
              router.push("/ble-probe");
            }}
            activeOpacity={0.7}
          >
            <Text style={styles.devToolLabel}>BLE Probe</Text>
            <Text style={styles.devToolChevron}>›</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.devToolRow}
            onPress={() => {
              const { router } = require("expo-router");
              router.push("/inertial-measurement-unit");
            }}
            activeOpacity={0.7}
          >
            <Text style={styles.devToolLabel}>Accelerometer Status</Text>
            <Text style={styles.devToolChevron}>›</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.devToolRow}
            onPress={() => {
              const { router } = require("expo-router");
              router.push("/imu-visualization");
            }}
            activeOpacity={0.7}
          >
            <Text style={styles.devToolLabel}>IMU Visualization</Text>
            <Text style={styles.devToolChevron}>›</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.devToolRow}
            onPress={() => {
              const { router } = require("expo-router");
              router.push("/heart-rate-visualization");
            }}
            activeOpacity={0.7}
          >
            <Text style={styles.devToolLabel}>Heart Rate Visualization</Text>
            <Text style={styles.devToolChevron}>›</Text>
          </TouchableOpacity>
          <View style={[styles.devToolRow, styles.devToolRowLast]}>
            <View>
              <Text style={styles.devToolLabel}>OTA Update</Text>
              <Text style={styles.devToolDetail}>
                {Updates.updateId ?? "embedded bundle"}
                {"\n"}
                Channel: {Updates.channel ?? "none"}
                {"\n"}
                Runtime: {Updates.runtimeVersion ?? "unknown"}
                {"\n"}
                Created: {formatLocalizedDateTime(Updates.createdAt)}
              </Text>
            </View>
          </View>
        </View>
      </View>

      {/* ── Danger Zone ── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Danger Zone</Text>
        <Text style={styles.sectionDescription}>
          Permanently delete all synced and manually-entered data for your account
        </Text>
        <View style={styles.dangerCard}>
          <TouchableOpacity
            style={[
              styles.deleteButton,
              deleteAllDataMutation.isPending && styles.deleteButtonDisabled,
            ]}
            onPress={handleDeleteAllUserData}
            activeOpacity={0.7}
            disabled={deleteAllDataMutation.isPending}
          >
            <Text style={styles.deleteButtonText}>
              {deleteAllDataMutation.isPending ? "Deleting..." : "Delete All User Data"}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Logout ── */}
      <View style={styles.section}>
        <TouchableOpacity style={styles.logoutButton} onPress={handleLogout} activeOpacity={0.7}>
          <Text style={styles.logoutText}>Log Out</Text>
        </TouchableOpacity>
      </View>
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
    paddingTop: 24,
    paddingBottom: 40,
  },
  contentWide: {
    maxWidth: 600,
    alignSelf: "center",
    width: "100%",
  },

  // ── Sections ──
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  sectionDescription: {
    fontSize: 13,
    color: colors.textTertiary,
    marginBottom: 10,
  },

  // ── Card ──
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
  },
  emptyText: {
    fontSize: 14,
    color: colors.textTertiary,
  },

  // ── Data Sources ──
  dataSourcesRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  dataSourcesInfo: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  providerLogos: {
    flexDirection: "row",
    gap: 6,
  },
  dataSourcesCount: {
    fontSize: 14,
    color: colors.textSecondary,
  },

  // ── Toggle Row ──
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  toggleInfo: {
    flex: 1,
    marginRight: 12,
  },
  toggleLabel: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.text,
  },
  toggleDescription: {
    fontSize: 13,
    color: colors.textTertiary,
    marginTop: 2,
  },

  // ── Unit System ──
  unitRow: {
    flexDirection: "row",
    gap: 10,
  },
  unitButton: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.surfaceSecondary,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  unitButtonSelected: {
    borderColor: colors.accent,
    backgroundColor: `${colors.accent}15`,
  },
  unitLabel: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  unitLabelSelected: {
    color: colors.text,
  },
  unitDescription: {
    fontSize: 12,
    color: colors.textTertiary,
    marginTop: 2,
  },

  // ── Goal Weight ──
  goalEditRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  goalInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: colors.text,
    fontSize: 14,
  },
  goalSaveButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  goalSaveText: {
    color: colors.blue,
    fontSize: 14,
    fontWeight: "600",
  },
  goalCancelText: {
    color: colors.textSecondary,
    fontSize: 14,
    paddingHorizontal: 8,
  },
  goalDisplayRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  goalDisplayText: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
  goalEditText: {
    color: colors.blue,
    fontSize: 14,
    fontWeight: "600",
  },

  // ── Data Export ──
  exportStatusContainer: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 10,
    gap: 2,
    marginBottom: 12,
    padding: 12,
  },
  exportStatusTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  exportMessageText: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  exportDoneText: {
    fontSize: 13,
    color: colors.positive,
    marginBottom: 12,
  },
  exportErrorText: {
    fontSize: 13,
    color: colors.danger,
    marginBottom: 12,
  },
  exportButton: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  exportButtonDisabled: {
    opacity: 0.5,
  },
  exportButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
  },
  exportListContainer: {
    gap: 10,
    marginTop: 16,
  },
  exportListTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.text,
  },
  exportListRow: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingTop: 10,
  },
  exportListInfo: {
    flex: 1,
    gap: 2,
  },
  exportFilename: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.text,
  },
  exportDownloadText: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.blue,
  },

  // ── Developer Tools ──
  devToolRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfaceSecondary,
  },
  devToolRowLast: {
    borderBottomWidth: 0,
  },
  devToolLabel: {
    fontSize: 15,
    fontWeight: "500",
    color: colors.text,
  },
  devToolChevron: {
    fontSize: 18,
    color: colors.textTertiary,
  },
  devToolDetail: {
    fontSize: 11,
    color: colors.textTertiary,
    marginTop: 2,
    fontVariant: ["tabular-nums"],
  },

  // ── Danger Zone ──
  dangerCard: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  deleteButton: {
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.danger,
    paddingVertical: 12,
    alignItems: "center",
  },
  deleteButtonDisabled: {
    opacity: 0.6,
  },
  deleteButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.danger,
  },

  // ── Logout ──
  logoutButton: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.danger,
    paddingVertical: 14,
    alignItems: "center",
  },
  logoutText: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.danger,
  },
});
