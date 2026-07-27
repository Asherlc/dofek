import { formatDateMedium, formatDateTime } from "@dofek/format/format";
import { formatMeasurementText, UnitConverter } from "@dofek/format/units";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Updates from "expo-updates";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { DataExportSection } from "../components/DataExportSection";
import { MedicationDoseEventsPanel } from "../components/MedicationDoseEventsPanel";
import { MedicationRemindersPanel } from "../components/MedicationRemindersPanel";
import { PersonalizationPanel } from "../components/PersonalizationPanel";
import { ProviderLogo } from "../components/ProviderLogo";
import { getQueryErrorMessage, QueryStatePanel } from "../components/QueryStatePanel";
import { SlackIntegrationPanel } from "../components/SlackIntegrationPanel";
import { ZeppPairingCard } from "../components/ZeppPairingCard";
import { useAuth } from "../lib/auth-context";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { useRefresh } from "../lib/useRefresh";
import { colors } from "../theme";
import { styles } from "./settings.styles";

type UnitSystem = "metric" | "imperial";

const UNIT_OPTIONS: { value: UnitSystem; label: string; description: string }[] = [
  { value: "metric", label: "Metric", description: "kg, km, °C" },
  { value: "imperial", label: "Imperial", description: "lbs, mi, °F" },
];
const reportedUnitReadErrors = new WeakSet<object>();

function formatLocalizedDateTime(date: Date | null | undefined): string {
  if (!date) return "n/a";
  return formatDateTime(date);
}

function formatDateRangeForSignupWeek(startDate: string, endDateExclusive: string): string {
  const endInclusive = new Date(`${endDateExclusive}T12:00:00.000Z`);
  endInclusive.setUTCDate(endInclusive.getUTCDate() - 1);
  const startValue = formatDateMedium(startDate);
  const endValue = formatDateMedium(endInclusive);

  return `${startValue} to ${endValue}`;
}

export default function SettingsScreen() {
  const auth = useAuth();
  const router = useRouter();
  const searchParams = useLocalSearchParams<{ focus?: string; reminderId?: string }>();
  const focusedReminderId =
    typeof searchParams.reminderId === "string" ? searchParams.reminderId : null;
  const { width } = useWindowDimensions();
  const isWide = width >= 600;
  const trpcUtils = trpc.useUtils();

  // ── Data Sources ──
  const providers = trpc.sync.providers.useQuery();

  // ── Password ──
  const passwordStatus = trpc.auth.passwordCredentialStatus.useQuery();
  const setPasswordMutation = trpc.auth.setPassword.useMutation({
    onSuccess: async () => {
      if (passwordStatus.data?.hasPassword) {
        Alert.alert("Password Updated", "Please sign in again.", [
          { text: "OK", onPress: () => void auth.logout() },
        ]);
        return;
      }
      await trpcUtils.auth.passwordCredentialStatus.invalidate();
      Alert.alert("Password Updated", "Your password has been saved.");
    },
    onError: (error) => Alert.alert("Error", error.message),
  });
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  // ── Unit System ──
  const unitSetting = trpc.settings.get.useQuery({ key: "unitSystem" });
  const setSettingMutation = trpc.settings.set.useMutation();
  const lastUnitReadError = useRef<unknown>(null);
  const deleteAllDataMutation = trpc.settings.deleteAllUserData.useMutation({
    onSuccess: async () => {
      await trpcUtils.invalidate();
      Alert.alert("Data Deleted", "All synced and manually-entered data has been deleted.");
    },
    onError: (error) => Alert.alert("Error", error.message),
  });
  const billingStatus = trpc.billing.status.useQuery();
  const medicationDoseEvents = trpc.medicationDoseEvents.list.useQuery({ limit: 50 });
  const checkoutSessionMutation = trpc.billing.createCheckoutSession.useMutation({
    onSuccess: ({ url }) => {
      void Linking.openURL(url);
    },
  });
  const portalSessionMutation = trpc.billing.createPortalSession.useMutation({
    onSuccess: ({ url }) => {
      void Linking.openURL(url);
    },
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
  const units = new UnitConverter(currentUnitSystem);
  const kgToLbs = 2.20462;

  useEffect(() => {
    if (
      unitSetting.error &&
      lastUnitReadError.current !== unitSetting.error &&
      !reportedUnitReadErrors.has(unitSetting.error)
    ) {
      lastUnitReadError.current = unitSetting.error;
      reportedUnitReadErrors.add(unitSetting.error);
      captureException(unitSetting.error, { context: "unit-system-read" });
    }
  }, [unitSetting.error]);

  function handleUnitChange(value: UnitSystem) {
    const previousSetting = trpcUtils.settings.get.getData({ key: "unitSystem" });
    trpcUtils.settings.get.setData({ key: "unitSystem" }, { key: "unitSystem", value });
    setSettingMutation.mutate(
      { key: "unitSystem", value },
      {
        onError: (error) => {
          trpcUtils.settings.get.setData({ key: "unitSystem" }, previousSetting);
          captureException(error, { context: "unit-system-write" });
          Alert.alert("Error", error.message);
        },
        onSettled: () => {
          void trpcUtils.settings.get.invalidate({ key: "unitSystem" });
        },
      },
    );
  }

  function handleSetPassword() {
    if (newPassword !== confirmPassword) {
      Alert.alert("Error", "Passwords do not match");
      return;
    }
    setPasswordMutation.mutate({
      currentPassword: passwordStatus.data?.hasPassword ? currentPassword : undefined,
      newPassword,
    });
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
      {/* ── Data Sources ── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Data Sources</Text>
        <Text style={styles.sectionDescription}>Connect and manage health data providers</Text>
        <TouchableOpacity
          style={styles.card}
          onPress={() => router.push("/providers")}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Data Sources"
          accessibilityState={{ busy: providers.isLoading }}
        >
          <View style={styles.dataSourcesRow}>
            <View style={styles.dataSourcesInfo}>
              {providers.isLoading ? (
                <ActivityIndicator color={colors.accent} size="small" />
              ) : providers.error && providers.data === undefined ? (
                <QueryStatePanel
                  variant="error"
                  title="Could not load data sources"
                  message={getQueryErrorMessage(providers.error)}
                  minHeight={96}
                />
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
        {providers.error && providers.data !== undefined ? (
          <QueryStatePanel
            variant="error"
            title="Could not refresh data sources"
            message={getQueryErrorMessage(providers.error)}
            minHeight={96}
          />
        ) : null}
      </View>

      {/* ── Health Tracking ── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Health Tracking</Text>
        <Text style={styles.sectionDescription}>Log and review personal health events</Text>
        <TouchableOpacity
          style={styles.card}
          onPress={() => router.push("/cycle")}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Cycle Tracking"
        >
          <View style={styles.dataSourcesRow}>
            <Text style={styles.devToolLabel}>Cycle Tracking</Text>
            <Text style={styles.devToolChevron}>›</Text>
          </View>
        </TouchableOpacity>
      </View>

      {/* ── Health Reports ── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Health Reports</Text>
        <Text style={styles.sectionDescription}>
          Review and share weekly or monthly health snapshots
        </Text>
        <TouchableOpacity
          style={styles.card}
          onPress={() => router.push("/reports")}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Health Reports"
        >
          <View style={styles.dataSourcesRow}>
            <Text style={styles.devToolLabel}>Open Health Reports</Text>
            <Text style={styles.devToolChevron}>›</Text>
          </View>
        </TouchableOpacity>
      </View>

      {/* ── Password ── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Password</Text>
        <Text style={styles.sectionDescription}>Set or change your email login password</Text>
        {passwordStatus.isLoading ? (
          <ActivityIndicator color={colors.accent} size="small" />
        ) : passwordStatus.error ? (
          <Text style={styles.passwordErrorText}>{passwordStatus.error.message}</Text>
        ) : (
          <View style={styles.card}>
            {passwordStatus.data?.hasPassword ? (
              <TextInput
                style={styles.passwordInput}
                value={currentPassword}
                onChangeText={setCurrentPassword}
                placeholder="Current password"
                placeholderTextColor={colors.textSecondary}
                secureTextEntry
                autoComplete="password"
              />
            ) : null}
            <TextInput
              style={styles.passwordInput}
              value={newPassword}
              onChangeText={setNewPassword}
              placeholder="New password"
              placeholderTextColor={colors.textSecondary}
              secureTextEntry
              autoComplete="new-password"
            />
            <TextInput
              style={styles.passwordInput}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              placeholder="Confirm password"
              placeholderTextColor={colors.textSecondary}
              secureTextEntry
              autoComplete="new-password"
            />
            <TouchableOpacity
              style={[
                styles.passwordButton,
                setPasswordMutation.isPending && styles.buttonDisabled,
              ]}
              onPress={handleSetPassword}
              disabled={setPasswordMutation.isPending}
              accessibilityRole="button"
              accessibilityLabel={
                passwordStatus.data?.hasPassword ? "Change Password" : "Set Password"
              }
              accessibilityState={{
                busy: setPasswordMutation.isPending,
                disabled: setPasswordMutation.isPending,
              }}
            >
              <Text style={styles.passwordButtonText}>
                {passwordStatus.data?.hasPassword ? "Change Password" : "Set Password"}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      <ZeppPairingCard />

      {/* ── Units ── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Units</Text>
        <Text style={styles.sectionDescription}>Choose how measurements are displayed</Text>
        {unitSetting.error && <Text style={styles.unitErrorText}>{unitSetting.error.message}</Text>}
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
                accessibilityRole="button"
                accessibilityLabel={option.label}
                accessibilityState={{
                  busy: setSettingMutation.isPending,
                  disabled: setSettingMutation.isPending,
                  selected: isSelected,
                }}
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

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Medication Reminders</Text>
        <Text style={styles.sectionDescription}>
          Optional daily reminders with imported logging state
        </Text>
        <View style={styles.card}>
          <MedicationRemindersPanel focusedReminderId={focusedReminderId} />
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Medication Doses</Text>
        <Text style={styles.sectionDescription}>Review imported medication dose events</Text>
        <View style={styles.card}>
          <MedicationDoseEventsPanel queryResult={medicationDoseEvents} />
        </View>
      </View>

      {/* ── Billing ── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Billing</Text>
        <Text style={styles.sectionDescription}>Manage subscription and data access</Text>
        <View style={styles.card}>
          {billingStatus.isLoading ? (
            <ActivityIndicator color={colors.accent} size="small" />
          ) : billingStatus.error ? (
            <Text style={styles.billingErrorText}>{billingStatus.error.message}</Text>
          ) : billingStatus.data ? (
            <>
              <Text style={styles.billingStatusText}>
                {billingStatus.data.access.kind === "limited"
                  ? `Access limited to your signup week (${formatDateRangeForSignupWeek(
                      billingStatus.data.access.startDate,
                      billingStatus.data.access.endDateExclusive,
                    )}).`
                  : "Full access is enabled for this account."}
              </Text>
              {billingStatus.data.access.kind === "full" &&
              billingStatus.data.access.reason === "paid_grant" ? (
                <Text style={styles.billingDetailText}>
                  Existing account access is already granted.
                </Text>
              ) : null}
              {billingStatus.data.access.kind === "full" &&
              billingStatus.data.access.reason === "stripe_subscription" &&
              billingStatus.data.stripeSubscriptionStatus ? (
                <Text style={styles.billingDetailText}>
                  Stripe subscription status: {billingStatus.data.stripeSubscriptionStatus}
                </Text>
              ) : null}
              {checkoutSessionMutation.error ? (
                <Text style={styles.billingErrorText}>{checkoutSessionMutation.error.message}</Text>
              ) : null}
              {portalSessionMutation.error ? (
                <Text style={styles.billingErrorText}>{portalSessionMutation.error.message}</Text>
              ) : null}
              <View style={styles.billingActionRow}>
                {!billingStatus.data.hasFullAccess && (
                  <TouchableOpacity
                    style={[
                      styles.billingPrimaryButton,
                      checkoutSessionMutation.isPending && styles.buttonDisabled,
                    ]}
                    onPress={() => checkoutSessionMutation.mutate()}
                    activeOpacity={0.7}
                    disabled={checkoutSessionMutation.isPending}
                    accessibilityRole="button"
                    accessibilityLabel="Upgrade to Full Access"
                    accessibilityState={{
                      busy: checkoutSessionMutation.isPending,
                      disabled: checkoutSessionMutation.isPending,
                    }}
                  >
                    <Text style={styles.billingButtonText}>
                      {checkoutSessionMutation.isPending
                        ? "Opening checkout..."
                        : "Upgrade to Full Access"}
                    </Text>
                  </TouchableOpacity>
                )}
                {billingStatus.data.canManageBilling && (
                  <TouchableOpacity
                    style={[
                      styles.billingSecondaryButton,
                      portalSessionMutation.isPending && styles.buttonDisabled,
                    ]}
                    onPress={() => portalSessionMutation.mutate()}
                    activeOpacity={0.7}
                    disabled={portalSessionMutation.isPending}
                    accessibilityRole="button"
                    accessibilityLabel="Manage Billing"
                    accessibilityState={{
                      busy: portalSessionMutation.isPending,
                      disabled: portalSessionMutation.isPending,
                    }}
                  >
                    <Text style={styles.billingButtonText}>
                      {portalSessionMutation.isPending
                        ? "Opening billing portal..."
                        : "Manage Billing"}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            </>
          ) : null}
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
                accessibilityRole="button"
                accessibilityLabel="Save goal weight"
                accessibilityState={{ busy: goalWeightMutation.isPending }}
              >
                <Text style={styles.goalSaveText}>Save</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setEditingGoal(false)}
                accessibilityRole="button"
                accessibilityLabel="Cancel goal weight edit"
              >
                <Text style={styles.goalCancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          ) : currentGoalKg != null ? (
            <View style={styles.goalDisplayRow}>
              <Text style={styles.goalDisplayText}>
                {formatMeasurementText(units.formatWeight(currentGoalKg))}
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
                accessibilityRole="button"
                accessibilityLabel="Edit goal weight"
              >
                <Text style={styles.goalEditText}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => goalWeightMutation.mutate({ weightKg: null })}
                accessibilityRole="button"
                accessibilityLabel="Clear goal weight"
                accessibilityState={{ busy: goalWeightMutation.isPending }}
              >
                <Text style={styles.goalCancelText}>Clear</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              onPress={() => {
                setGoalInput("");
                setEditingGoal(true);
              }}
              accessibilityRole="button"
              accessibilityLabel="Set Goal Weight"
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

      <DataExportSection serverUrl={auth.serverUrl} sessionToken={auth.sessionToken} />

      {/* ── Help & Support ── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Help & Support</Text>
        <Text style={styles.sectionDescription}>Get help from our team</Text>
        <TouchableOpacity
          style={styles.card}
          onPress={() => router.push("/support")}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Contact Support"
        >
          <View style={styles.dataSourcesRow}>
            <Text style={styles.devToolLabel}>Contact Support</Text>
            <Text style={styles.devToolChevron}>›</Text>
          </View>
        </TouchableOpacity>
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
            accessibilityRole="button"
            accessibilityLabel="Bluetooth Low Energy probe"
          >
            <Text style={styles.devToolLabel}>Bluetooth Low Energy probe</Text>
            <Text style={styles.devToolChevron}>›</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.devToolRow}
            onPress={() => {
              const { router } = require("expo-router");
              router.push("/imu-visualization");
            }}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Inertial measurement unit visualization"
          >
            <Text style={styles.devToolLabel}>Inertial measurement unit visualization</Text>
            <Text style={styles.devToolChevron}>›</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.devToolRow}
            onPress={() => {
              const { router } = require("expo-router");
              router.push("/heart-rate-visualization");
            }}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Heart Rate Visualization"
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
            accessibilityRole="button"
            accessibilityLabel="Delete All User Data"
            accessibilityState={{
              busy: deleteAllDataMutation.isPending,
              disabled: deleteAllDataMutation.isPending,
            }}
          >
            <Text style={styles.deleteButtonText}>
              {deleteAllDataMutation.isPending ? "Deleting..." : "Delete All User Data"}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Logout ── */}
      <View style={styles.section}>
        <TouchableOpacity
          style={styles.logoutButton}
          onPress={handleLogout}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Log Out"
        >
          <Text style={styles.logoutText}>Log Out</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}
