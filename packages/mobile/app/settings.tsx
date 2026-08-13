import {
  getNewPasswordValidationError,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_REQUIREMENT_TEXT,
} from "@dofek/auth/auth";
import { formatDateMedium, formatDateTime } from "@dofek/format/format";
import {
  type ClimbingGradePreference,
  resolveClimbingGradePreference,
} from "@dofek/training/climbing-grades";
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
  type TextInputProps,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { AccountErasurePanel } from "../components/AccountErasurePanel";
import { ClimbingGradeSystemSettings } from "../components/ClimbingGradeSystemSettings";
import { DataExportSection } from "../components/DataExportSection";
import { MedicationDoseEventsPanel } from "../components/MedicationDoseEventsPanel";
import { MedicationRemindersPanel } from "../components/MedicationRemindersPanel";
import { PersonalizationPanel } from "../components/PersonalizationPanel";
import { PrimaryGoalSelector } from "../components/PrimaryGoalSelector";
import { ProviderLogo } from "../components/ProviderLogo";
import { getQueryErrorMessage, QueryStatePanel } from "../components/QueryStatePanel";
import { ZeppPairingCard } from "../components/ZeppPairingCard";
import { useAuth } from "../lib/auth-context";
import {
  clearMobileBillingCheckoutOperation,
  getOrCreateMobileBillingCheckoutOperationId,
} from "../lib/billing-checkout-operation";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { useRefresh } from "../lib/useRefresh";
import { colors } from "../theme";
import { styles } from "./settings.styles";
import { GoalWeightSettingsSection } from "./settings-goal-weight";

type UnitSystem = "metric" | "imperial";
type SettingsCategory =
  | "account"
  | "data-sources"
  | "goals-models"
  | "privacy-export"
  | "notifications"
  | "billing"
  | "advanced";

const UNIT_OPTIONS: { value: UnitSystem; label: string; description: string }[] = [
  { value: "metric", label: "Metric", description: "kg, km, °C" },
  { value: "imperial", label: "Imperial", description: "lbs, mi, °F" },
];
const SETTINGS_CATEGORIES: readonly {
  id: SettingsCategory;
  label: string;
  searchText: string;
}[] = [
  {
    id: "account",
    label: "Account",
    searchText: "account linked accounts password help support",
  },
  {
    id: "data-sources",
    label: "Data Sources",
    searchText: "data sources providers Zepp integrations",
  },
  {
    id: "goals-models",
    label: "Goals & Models",
    searchText:
      "goals models primary goal units cycle tracking journal trends health reports goal weight algorithm personalization",
  },
  {
    id: "privacy-export",
    label: "Privacy/Export",
    searchText: "privacy export data export download delete danger zone",
  },
  {
    id: "notifications",
    label: "Notifications",
    searchText: "notifications medication reminders medication doses",
  },
  {
    id: "billing",
    label: "Billing",
    searchText: "billing subscription access checkout",
  },
  {
    id: "advanced",
    label: "Advanced",
    searchText: "advanced dashboard layout developer tools diagnostics",
  },
];
const reportedUnitReadErrors = new WeakSet<object>();
const IOS_PASSWORD_RULES = `minlength: ${PASSWORD_MIN_LENGTH}; maxlength: ${PASSWORD_MAX_LENGTH};`;

interface SettingsPasswordInputProps {
  autoComplete: NonNullable<TextInputProps["autoComplete"]>;
  label: string;
  maxLength?: number;
  onChangeText: (value: string) => void;
  passwordRules?: string;
  value: string;
}

function SettingsPasswordInput({
  autoComplete,
  label,
  maxLength,
  onChangeText,
  passwordRules,
  value,
}: SettingsPasswordInputProps) {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <View style={styles.passwordInputContainer}>
      <TextInput
        accessibilityLabel={label}
        style={styles.passwordInput}
        value={value}
        onChangeText={onChangeText}
        placeholder={label}
        placeholderTextColor={colors.textSecondary}
        secureTextEntry={!isVisible}
        autoComplete={autoComplete}
        passwordRules={passwordRules}
        maxLength={maxLength}
      />
      <TouchableOpacity
        onPress={() => setIsVisible((visible) => !visible)}
        accessibilityRole="button"
        accessibilityLabel={`${isVisible ? "Hide" : "Show"} ${label.toLowerCase()}`}
        style={styles.passwordVisibilityButton}
      >
        <Text style={styles.passwordVisibilityText}>{isVisible ? "Hide" : "Show"}</Text>
      </TouchableOpacity>
    </View>
  );
}

function isSettingsCategory(value: unknown): value is SettingsCategory {
  return SETTINGS_CATEGORIES.some((category) => category.id === value);
}

const LEGACY_SETTINGS_CATEGORY_MAP: Readonly<Record<string, SettingsCategory>> = {
  connections: "data-sources",
  general: "goals-models",
  health: "goals-models",
};

function normalizeSettingsCategory(value: unknown): SettingsCategory | undefined {
  if (isSettingsCategory(value)) return value;
  return typeof value === "string" ? LEGACY_SETTINGS_CATEGORY_MAP[value] : undefined;
}

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
  const searchParams = useLocalSearchParams<{
    focus?: string;
    reminderId?: string;
    tab?: string;
  }>();
  const focusedReminderId =
    typeof searchParams.reminderId === "string" ? searchParams.reminderId : null;
  const normalizedRequestedCategory = normalizeSettingsCategory(searchParams.tab);
  const requestedCategory: SettingsCategory = normalizedRequestedCategory
    ? normalizedRequestedCategory
    : searchParams.focus === "medicationReminders"
      ? "notifications"
      : "account";
  const [categorySearch, setCategorySearch] = useState("");
  const normalizedCategorySearch = categorySearch.trim().toLowerCase();
  const visibleCategories = SETTINGS_CATEGORIES.filter(
    (category) =>
      normalizedCategorySearch.length === 0 ||
      `${category.label} ${category.searchText}`.toLowerCase().includes(normalizedCategorySearch),
  );
  const [selectedCategory, setSelectedCategory] = useState<SettingsCategory>(requestedCategory);
  useEffect(() => {
    setSelectedCategory(requestedCategory);
  }, [requestedCategory]);
  const activeCategory =
    visibleCategories.find((category) => category.id === selectedCategory)?.id ??
    visibleCategories[0]?.id ??
    null;
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
  const [passwordFormError, setPasswordFormError] = useState<string | null>(null);

  // ── Unit System ──
  const unitSetting = trpc.settings.get.useQuery({ key: "unitSystem" });
  const climbingGradeSetting = trpc.settings.get.useQuery({ key: "climbingGradeSystems" });
  const setSettingMutation = trpc.settings.set.useMutation();
  const lastUnitReadError = useRef<unknown>(null);
  const billingStatus = trpc.billing.status.useQuery();
  const medicationDoseEvents = trpc.medicationDoseEvents.list.useQuery({ limit: 50 });
  const [checkoutClientError, setCheckoutClientError] = useState<string | null>(null);
  const checkoutSessionMutation = trpc.billing.createCheckoutSession.useMutation({
    onSuccess: async ({ url }, { operationId }) => {
      try {
        await clearMobileBillingCheckoutOperation(operationId);
      } catch (error: unknown) {
        captureException(error, { context: "billing-checkout-operation-clear" });
      }
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
  const climbingGradePreference = climbingGradeSetting.data
    ? resolveClimbingGradePreference(climbingGradeSetting.data.value)
    : null;

  async function startCheckout(): Promise<void> {
    setCheckoutClientError(null);
    try {
      const operationId = await getOrCreateMobileBillingCheckoutOperationId();
      checkoutSessionMutation.mutate({ operationId });
    } catch (error: unknown) {
      captureException(error, { context: "billing-checkout-operation-create" });
      setCheckoutClientError(
        error instanceof Error ? error.message : "Checkout could not be started on this device.",
      );
    }
  }

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

  function handleClimbingGradeChange(next: ClimbingGradePreference) {
    const key = "climbingGradeSystems" as const;
    const previousSetting = trpcUtils.settings.get.getData({ key });
    trpcUtils.settings.get.setData({ key }, { key, value: next });
    setSettingMutation.mutate(
      { key, value: next },
      {
        onError: (error) => {
          trpcUtils.settings.get.setData({ key }, previousSetting);
          captureException(error, { context: "climbing-grade-systems-write" });
          Alert.alert("Error", error.message);
        },
        onSettled: () => {
          void trpcUtils.settings.get.invalidate({ key });
        },
      },
    );
  }

  function handleSetPassword() {
    if (passwordStatus.data?.hasPassword && !currentPassword) {
      setPasswordFormError("Enter your current password.");
      return;
    }
    const passwordError = getNewPasswordValidationError(newPassword);
    if (passwordError) {
      setPasswordFormError(passwordError);
      return;
    }
    setPasswordFormError(null);
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

  function handleCategoryChange(category: SettingsCategory) {
    setCategorySearch("");
    setSelectedCategory(category);
    router.setParams({ tab: category });
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
      <TextInput
        accessibilityLabel="Search settings"
        value={categorySearch}
        onChangeText={setCategorySearch}
        placeholder="Search settings"
        placeholderTextColor={colors.textSecondary}
        style={styles.searchInput}
        returnKeyType="search"
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabsScrollView}
        contentContainerStyle={styles.tabs}
      >
        {visibleCategories.map((category) => {
          const isActive = activeCategory === category.id;
          return (
            <TouchableOpacity
              key={category.id}
              style={[styles.tab, isActive && styles.tabSelected]}
              onPress={() => handleCategoryChange(category.id)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={category.label}
              accessibilityState={{ selected: isActive }}
              aria-selected={isActive}
            >
              <Text style={[styles.tabText, isActive && styles.tabTextSelected]}>
                {category.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      {visibleCategories.length === 0 ? (
        <Text style={styles.noSearchResults}>No settings categories match “{categorySearch}”.</Text>
      ) : null}

      {/* ── Data Sources ── */}
      {activeCategory === "data-sources" ? (
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
      ) : null}

      {/* ── Health Tracking ── */}
      {activeCategory === "goals-models" ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Health Tracking</Text>
          <Text style={styles.sectionDescription}>Log and review personal health events</Text>
          <View style={styles.healthTrackingCards}>
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
            <TouchableOpacity
              style={styles.card}
              onPress={() => router.push("/tracking")}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Journal Trends"
            >
              <View style={styles.dataSourcesRow}>
                <Text style={styles.devToolLabel}>Journal Trends</Text>
                <Text style={styles.devToolChevron}>›</Text>
              </View>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      {activeCategory === "goals-models" ? (
        <ClimbingGradeSystemSettings
          errorMessage={climbingGradeSetting.error?.message ?? null}
          onChange={handleClimbingGradeChange}
          preference={climbingGradePreference}
          saving={setSettingMutation.isPending}
        />
      ) : null}

      {/* ── Health Reports ── */}
      {activeCategory === "goals-models" ? (
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
      ) : null}

      {/* ── Password ── */}
      {activeCategory === "account" ? (
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
                <SettingsPasswordInput
                  label="Current password"
                  value={currentPassword}
                  onChangeText={(value) => {
                    setCurrentPassword(value);
                    setPasswordFormError(null);
                  }}
                  autoComplete="current-password"
                />
              ) : null}
              <SettingsPasswordInput
                label="New password"
                value={newPassword}
                onChangeText={(value) => {
                  setNewPassword(value);
                  setPasswordFormError(null);
                }}
                autoComplete="new-password"
                passwordRules={IOS_PASSWORD_RULES}
                maxLength={PASSWORD_MAX_LENGTH}
              />
              <SettingsPasswordInput
                label="Confirm password"
                value={confirmPassword}
                onChangeText={(value) => {
                  setConfirmPassword(value);
                  setPasswordFormError(null);
                }}
                autoComplete="new-password"
                passwordRules={IOS_PASSWORD_RULES}
                maxLength={PASSWORD_MAX_LENGTH}
              />
              <Text
                style={
                  passwordFormError ? styles.passwordErrorText : styles.passwordRequirementText
                }
                accessibilityLiveRegion="polite"
                accessibilityRole={passwordFormError ? "alert" : undefined}
              >
                {passwordFormError ?? PASSWORD_REQUIREMENT_TEXT}
              </Text>
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
      ) : null}

      {activeCategory === "data-sources" ? <ZeppPairingCard /> : null}

      {/* ── Primary Goal ── */}
      {activeCategory === "goals-models" ? (
        <View style={styles.section}>
          <PrimaryGoalSelector />
        </View>
      ) : null}

      {/* ── Units ── */}
      {activeCategory === "goals-models" ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Units</Text>
          <Text style={styles.sectionDescription}>Choose how measurements are displayed</Text>
          {unitSetting.error && (
            <Text style={styles.unitErrorText}>{unitSetting.error.message}</Text>
          )}
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
      ) : null}

      {activeCategory === "notifications" ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Medication Reminders</Text>
          <Text style={styles.sectionDescription}>
            Optional daily reminders with imported logging state
          </Text>
          <View style={styles.card}>
            <MedicationRemindersPanel focusedReminderId={focusedReminderId} />
          </View>
        </View>
      ) : null}

      {activeCategory === "notifications" ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Medication Doses</Text>
          <Text style={styles.sectionDescription}>Review imported medication dose events</Text>
          <View style={styles.card}>
            <MedicationDoseEventsPanel queryResult={medicationDoseEvents} />
          </View>
        </View>
      ) : null}

      {/* ── Billing ── */}
      {activeCategory === "billing" ? (
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
                  <Text style={styles.billingErrorText}>
                    {checkoutSessionMutation.error.message}
                  </Text>
                ) : null}
                {checkoutClientError ? (
                  <Text style={styles.billingErrorText}>{checkoutClientError}</Text>
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
                      onPress={() => void startCheckout()}
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
      ) : null}

      {activeCategory === "goals-models" ? (
        <GoalWeightSettingsSection unitSystem={currentUnitSystem} />
      ) : null}

      {/* ── Algorithm Personalization ── */}
      {activeCategory === "goals-models" ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Algorithm Personalization</Text>
          <Text style={styles.sectionDescription}>
            Parameters are automatically learned from your data
          </Text>
          <View style={styles.card}>
            <PersonalizationPanel />
          </View>
        </View>
      ) : null}

      {activeCategory === "privacy-export" ? (
        <DataExportSection serverUrl={auth.serverUrl} sessionToken={auth.sessionToken} />
      ) : null}

      {/* ── Help & Support ── */}
      {activeCategory === "account" ? (
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
      ) : null}

      {/* ── Developer Tools ── */}
      {activeCategory === "advanced" ? (
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
      ) : null}

      {/* ── Danger Zone ── */}
      {activeCategory === "privacy-export" ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Danger Zone</Text>
          <Text style={styles.sectionDescription}>
            Permanently close your account and delete Dofek-held account and health data
          </Text>
          <View style={styles.dangerCard}>
            <AccountErasurePanel />
          </View>
        </View>
      ) : null}

      {/* ── Logout ── */}
      {activeCategory === "privacy-export" ? (
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
      ) : null}
    </ScrollView>
  );
}
