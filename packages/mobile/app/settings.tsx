import { providerLabel } from "@dofek/providers/providers";
import { File as ExpoFile, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { z } from "zod";
import { PersonalizationPanel } from "../components/PersonalizationPanel";
import { SlackIntegrationPanel } from "../components/SlackIntegrationPanel";
import { useAuth } from "../lib/auth-context";
import { trpc } from "../lib/trpc";
import { useRefresh } from "../lib/useRefresh";
import { colors } from "../theme";

type UnitSystem = "metric" | "imperial";

const UNIT_OPTIONS: { value: UnitSystem; label: string; description: string }[] = [
  { value: "metric", label: "Metric", description: "kg, km, °C" },
  { value: "imperial", label: "Imperial", description: "lbs, mi, °F" },
];

type ExportState = "idle" | "processing" | "done" | "error";

const ExportTriggerSchema = z.object({ jobId: z.string() });

const ExportStatusSchema = z.object({
  status: z.string(),
  progress: z.number().optional(),
  message: z.string().optional(),
  downloadUrl: z.string().optional(),
});

export default function SettingsScreen() {
  const auth = useAuth();
  const { width } = useWindowDimensions();
  const isWide = width >= 600;
  const trpcUtils = trpc.useUtils();

  // ── Data Export ──
  const [exportState, setExportState] = useState<ExportState>("idle");
  const [exportProgress, setExportProgress] = useState(0);
  const [exportMessage, setExportMessage] = useState("");

  // ── Linked Accounts ──
  const linkedAccounts = trpc.auth.linkedAccounts.useQuery();
  const unlinkMutation = trpc.auth.unlinkAccount.useMutation({
    onSuccess: () => linkedAccounts.refetch(),
    onError: (error) => Alert.alert("Error", error.message),
  });

  const accounts = linkedAccounts.data ?? [];
  const canUnlink = accounts.length > 1;

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

  // ── WHOOP Accelerometer ──
  const whoopImuSetting = trpc.settings.get.useQuery({ key: "whoopAlwaysOnImu" });
  const whoopImuEnabled = whoopImuSetting.data?.value === true;

  function handleWhoopImuToggle(enabled: boolean) {
    trpcUtils.settings.get.setData(
      { key: "whoopAlwaysOnImu" },
      { key: "whoopAlwaysOnImu", value: enabled },
    );
    setSettingMutation.mutate(
      { key: "whoopAlwaysOnImu", value: enabled },
      {
        onSuccess: () => whoopImuSetting.refetch(),
        onError: () => whoopImuSetting.refetch(),
      },
    );
  }

  function handleUnlink(accountId: string) {
    Alert.alert("Unlink Account", "Are you sure you want to unlink this account?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Unlink",
        style: "destructive",
        onPress: () => unlinkMutation.mutate({ accountId }),
      },
    ]);
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

  async function handleExport() {
    setExportState("processing");
    setExportProgress(0);
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

      const triggerData = ExportTriggerSchema.parse(await triggerRes.json());
      const { jobId } = triggerData;

      // Poll for status
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));

        const statusRes = await fetch(`${auth.serverUrl}/api/export/status/${jobId}`, {
          headers: { Authorization: `Bearer ${auth.sessionToken}` },
        });

        if (!statusRes.ok) {
          setExportState("error");
          setExportMessage("Failed to check export status");
          return;
        }

        const status = ExportStatusSchema.parse(await statusRes.json());
        setExportProgress(status.progress ?? 0);
        setExportMessage(status.message ?? "");

        if (status.status === "done" && status.downloadUrl) {
          setExportMessage("Downloading...");
          const downloadUrl = status.downloadUrl.startsWith("http")
            ? status.downloadUrl
            : `${auth.serverUrl}${status.downloadUrl}`;
          const downloadRes = await fetch(downloadUrl, {
            headers: { Authorization: `Bearer ${auth.sessionToken}` },
          });
          if (!downloadRes.ok) {
            setExportState("error");
            setExportMessage("Failed to download export");
            return;
          }
          const blob = await downloadRes.blob();
          const file = new ExpoFile(Paths.cache, "health-export.zip");
          const arrayBuffer = await blob.arrayBuffer();
          const bytes = new Uint8Array(arrayBuffer);
          file.write(bytes);
          setExportState("done");
          setExportMessage("Export complete");
          await Sharing.shareAsync(file.uri, {
            mimeType: "application/zip",
            dialogTitle: "Save Health Data Export",
          });
          return;
        }

        if (status.status === "error") {
          setExportState("error");
          setExportMessage(status.message ?? "Export failed");
          return;
        }
      }

      setExportState("error");
      setExportMessage("Export timed out");
    } catch {
      setExportState("error");
      setExportMessage("Network error during export");
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
      {/* ── Linked Accounts ── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Linked Accounts</Text>
        <Text style={styles.sectionDescription}>Manage login methods linked to your account</Text>
        <View style={styles.card}>
          {linkedAccounts.isLoading ? (
            <ActivityIndicator color={colors.accent} size="small" />
          ) : accounts.length === 0 ? (
            <Text style={styles.emptyText}>No linked accounts</Text>
          ) : (
            accounts.map((account) => (
              <View key={account.id} style={styles.accountRow}>
                <View style={styles.accountInfo}>
                  <Text style={styles.accountProvider}>{providerLabel(account.authProvider)}</Text>
                  {account.email ? <Text style={styles.accountEmail}>{account.email}</Text> : null}
                </View>
                <TouchableOpacity
                  onPress={() => handleUnlink(account.id)}
                  disabled={!canUnlink || unlinkMutation.isPending}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[
                      styles.unlinkText,
                      (!canUnlink || unlinkMutation.isPending) && styles.unlinkTextDisabled,
                    ]}
                  >
                    Unlink
                  </Text>
                </TouchableOpacity>
              </View>
            ))
          )}
        </View>
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

      {/* ── WHOOP Accelerometer ── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>WHOOP Accelerometer</Text>
        <Text style={styles.sectionDescription}>
          Record accelerometer data from your WHOOP strap continuously via Bluetooth. Reduces strap
          battery life from ~5 days to ~3-4 days.
        </Text>
        <View style={styles.card}>
          <View style={styles.toggleRow}>
            <View style={styles.toggleInfo}>
              <Text style={styles.toggleLabel}>Always-on recording</Text>
              <Text style={styles.toggleDescription}>
                Streams accelerometer data whenever the app is open
              </Text>
            </View>
            <Switch
              value={whoopImuEnabled}
              onValueChange={handleWhoopImuToggle}
              disabled={setSettingMutation.isPending}
              trackColor={{ false: colors.surfaceSecondary, true: colors.accent }}
            />
          </View>
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
          Download all your health data as a ZIP file containing JSON files
        </Text>
        <View style={styles.card}>
          {exportState === "processing" && (
            <View style={styles.exportProgressContainer}>
              <View style={styles.exportProgressTrack}>
                <View style={[styles.exportProgressFill, { width: `${exportProgress}%` }]} />
              </View>
              <Text style={styles.exportMessageText}>{exportMessage}</Text>
            </View>
          )}
          {exportState === "done" && <Text style={styles.exportDoneText}>Export complete</Text>}
          {exportState === "error" && <Text style={styles.exportErrorText}>{exportMessage}</Text>}
          <TouchableOpacity
            style={[
              styles.exportButton,
              exportState === "processing" && styles.exportButtonDisabled,
            ]}
            onPress={handleExport}
            activeOpacity={0.7}
            disabled={exportState === "processing"}
          >
            <Text style={styles.exportButtonText}>
              {exportState === "processing" ? "Exporting..." : "Download My Data"}
            </Text>
          </TouchableOpacity>
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

  // ── Linked Accounts ──
  accountRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfaceSecondary,
  },
  accountInfo: {
    flex: 1,
    marginRight: 12,
  },
  accountProvider: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.text,
  },
  accountEmail: {
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: 2,
  },
  unlinkText: {
    fontSize: 14,
    fontWeight: "500",
    color: colors.danger,
  },
  unlinkTextDisabled: {
    color: colors.textTertiary,
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

  // ── Data Export ──
  exportProgressContainer: {
    gap: 4,
    marginBottom: 12,
  },
  exportProgressTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.surfaceSecondary,
    overflow: "hidden",
  },
  exportProgressFill: {
    height: "100%",
    borderRadius: 2,
    backgroundColor: colors.accent,
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
