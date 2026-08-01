import { formatDateMedium, parseValidDate } from "@dofek/format/format";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { DataSourcesPanel } from "../components/DataSourcesPanel.tsx";
import { ExportPanel } from "../components/ExportPanel.tsx";
import { LinkedAccountsPanel } from "../components/LinkedAccountsPanel.tsx";
import { MedicationDoseEventsPanel } from "../components/MedicationDoseEventsPanel.tsx";
import { MedicationRemindersPanel } from "../components/MedicationRemindersPanel.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { PageSection } from "../components/PageSection.tsx";
import { PasswordSettingsPanel } from "../components/PasswordSettingsPanel.tsx";
import { PersonalizationPanel } from "../components/PersonalizationPanel.tsx";
import { PrimaryGoalSelector } from "../components/PrimaryGoalSelector.tsx";
import { SlackIntegrationPanel } from "../components/SlackIntegrationPanel.tsx";
import { UnitSystemToggle } from "../components/UnitSystemToggle.tsx";
import { SECTION_LABELS, useDashboardLayout } from "../lib/dashboardLayoutContext.ts";
import { trpc } from "../lib/trpc.ts";
import { McpTokensPanel } from "./McpTokensPanel.tsx";

export type SettingsTab = "general" | "health" | "connections" | "account" | "advanced";

const SETTINGS_TABS: readonly { id: SettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "health", label: "Health" },
  { id: "connections", label: "Connections" },
  { id: "account", label: "Account" },
  { id: "advanced", label: "Advanced" },
];

export function isSettingsTab(value: unknown): value is SettingsTab {
  return SETTINGS_TABS.some((tab) => tab.id === value);
}

function getSignupWeekLabel(startDate: string, endDateExclusive: string): string {
  const endInclusive = parseValidDate(`${endDateExclusive}T12:00:00.000Z`);
  if (!endInclusive) return `${formatDateMedium(startDate)} to --`;
  endInclusive.setUTCDate(endInclusive.getUTCDate() - 1);

  return `${formatDateMedium(startDate)} to ${formatDateMedium(endInclusive)}`;
}

const billingRegionClassName = "min-h-44 sm:min-h-32 lg:min-h-28";

export function SettingsPage() {
  const search = useSearch({ from: "/settings" });
  const navigate = useNavigate({ from: "/settings" });
  const activeTab = search.zeppPair ? "connections" : (search.tab ?? "general");
  const { layout, toggleHidden, resetLayout } = useDashboardLayout();
  const trpcUtils = trpc.useUtils();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [zeppPairingCode, setZeppPairingCode] = useState("");
  const zeppConnections = trpc.companionToken.list.useQuery();
  const revokeZeppConnection = trpc.companionToken.revoke.useMutation({
    onSuccess: async () => {
      await zeppConnections.refetch();
    },
  });
  const deleteAllDataMutation = trpc.settings.deleteAllUserData.useMutation({
    onSuccess: async () => {
      setShowDeleteConfirm(false);
      await trpcUtils.invalidate();
    },
  });
  const billingStatus = trpc.billing.status.useQuery();
  const checkoutSessionMutation = trpc.billing.createCheckoutSession.useMutation({
    onSuccess: ({ url }) => {
      window.location.assign(url);
    },
  });
  const portalSessionMutation = trpc.billing.createPortalSession.useMutation({
    onSuccess: ({ url }) => {
      window.location.assign(url);
    },
  });
  const zeppPairingMutation = trpc.companionPairing.claim.useMutation({
    onSuccess: async () => {
      setZeppPairingCode("");
      await zeppConnections.refetch();
    },
  });

  useEffect(() => {
    const pairingCode = search.zeppPair;
    if (pairingCode) {
      setZeppPairingCode(pairingCode);
      void navigate({
        search: (previous) => ({
          ...previous,
          tab: "connections",
          zeppPair: undefined,
        }),
        replace: true,
      });
    }
  }, [navigate, search.zeppPair]);

  function handleClaimZeppPairing() {
    zeppPairingMutation.mutate({ code: zeppPairingCode });
  }

  const hiddenSections = layout.hidden;

  return (
    <PageLayout title="Settings">
      <div
        role="tablist"
        aria-label="Settings sections"
        className="flex gap-1 overflow-x-auto rounded-lg border border-border bg-surface/60 p-1 scrollbar-hide"
      >
        {SETTINGS_TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              id={`settings-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls="settings-panel"
              onClick={() =>
                void navigate({
                  search: (previous) => ({ ...previous, tab: tab.id }),
                })
              }
              className={`min-w-fit flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-accent/15 text-foreground"
                  : "text-subtle hover:bg-surface-hover hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        id="settings-panel"
        role="tabpanel"
        aria-labelledby={`settings-tab-${activeTab}`}
        className="space-y-6 sm:space-y-7"
      >
        {activeTab === "connections" ? (
          <PageSection title="Data Sources" subtitle="Connect and manage health data providers">
            <DataSourcesPanel />
          </PageSection>
        ) : null}

        {activeTab === "account" ? (
          <PageSection
            title="Linked Accounts"
            subtitle="Manage login methods linked to your account"
          >
            <LinkedAccountsPanel />
          </PageSection>
        ) : null}

        {activeTab === "account" ? (
          <PageSection title="Password" subtitle="Set or change your email login password">
            <PasswordSettingsPanel />
          </PageSection>
        ) : null}

        {activeTab === "connections" ? (
          <PageSection
            title="Zepp App Pairing"
            subtitle="Connect the Zepp watch app to this account"
          >
            <div className="space-y-3">
              <div className="space-y-2 rounded border border-border bg-surface-solid p-3">
                <p className="text-xs font-medium text-foreground">Current connections</p>
                {zeppConnections.isLoading ? (
                  <p className="text-xs text-subtle">Checking connections…</p>
                ) : zeppConnections.error ? (
                  <p className="text-xs text-red-400">{zeppConnections.error.message}</p>
                ) : zeppConnections.data?.length ? (
                  zeppConnections.data.map((connection) => {
                    const connectionLabel =
                      connection.connectionType === "zepp-main" ? "Zepp app" : "Workout extension";
                    return (
                      <div
                        key={connection.connectionType}
                        className="flex items-center justify-between gap-3"
                      >
                        <span className="text-xs text-accent">{connectionLabel}: Connected</span>
                        <button
                          type="button"
                          aria-label={`Disconnect ${connectionLabel}`}
                          className="text-xs text-red-400 hover:text-red-300"
                          onClick={() =>
                            revokeZeppConnection.mutate({
                              connectionType: connection.connectionType,
                            })
                          }
                        >
                          Disconnect
                        </button>
                      </div>
                    );
                  })
                ) : (
                  <p className="text-xs text-subtle">No Zepp apps connected</p>
                )}
                {revokeZeppConnection.error ? (
                  <p className="text-xs text-red-400">{revokeZeppConnection.error.message}</p>
                ) : null}
              </div>
              <label className="block space-y-1">
                <span className="text-xs text-subtle">Short code</span>
                <input
                  type="text"
                  value={zeppPairingCode}
                  onChange={(event) => setZeppPairingCode(event.target.value)}
                  className="w-full rounded border border-border bg-surface-solid px-3 py-2 text-sm text-foreground"
                  placeholder="ABC234"
                  autoCapitalize="characters"
                />
              </label>
              <button
                type="button"
                onClick={handleClaimZeppPairing}
                disabled={zeppPairingMutation.isPending || !zeppPairingCode.trim()}
                className="rounded bg-accent px-3 py-2 text-sm text-on-accent transition-colors hover:bg-accent/90 disabled:opacity-50"
              >
                {zeppPairingMutation.isPending ? "Connecting..." : "Connect Zepp App"}
              </button>
              {zeppPairingMutation.isSuccess ? (
                <p className="text-xs text-accent">
                  {zeppPairingMutation.data?.connectionType === "zepp-workout"
                    ? "Workout extension"
                    : "Zepp app"}{" "}
                  connected. Return to Zepp to sync.
                </p>
              ) : null}
              {zeppPairingMutation.error ? (
                <p className="text-xs text-red-400">{zeppPairingMutation.error.message}</p>
              ) : null}
            </div>
          </PageSection>
        ) : null}

        {activeTab === "advanced" ? (
          <PageSection title="MCP" subtitle="Connect remote MCP clients and manage access tokens">
            <McpTokensPanel />
          </PageSection>
        ) : null}

        {activeTab === "general" ? (
          <PageSection
            title="Primary goal"
            subtitle="Choose the outcome Dofek should optimize toward"
          >
            <PrimaryGoalSelector showHeading={false} />
          </PageSection>
        ) : null}

        {activeTab === "general" ? (
          <PageSection title="Units" subtitle="Choose how measurements are displayed">
            <UnitSystemToggle />
          </PageSection>
        ) : null}

        {activeTab === "health" ? (
          <PageSection
            title="Medication Reminders"
            subtitle="Optional daily reminders with imported logging state"
          >
            <MedicationRemindersPanel />
          </PageSection>
        ) : null}

        {activeTab === "health" ? (
          <PageSection title="Medication Doses" subtitle="Review imported medication dose events">
            <MedicationDoseEventsPanel />
          </PageSection>
        ) : null}

        {activeTab === "general" ? (
          <PageSection
            title="Dashboard Layout"
            subtitle="Manage hidden sections and reset layout to defaults"
          >
            <div className="space-y-4">
              {hiddenSections.length > 0 ? (
                <div className="space-y-2">
                  <h3 className="text-xs font-medium text-subtle uppercase">Hidden Sections</h3>
                  <ul className="space-y-1">
                    {hiddenSections.map((id) => (
                      <li
                        key={id}
                        className="flex items-center justify-between py-1.5 px-2 rounded bg-accent/10"
                      >
                        <span className="text-sm text-foreground">{SECTION_LABELS[id] ?? id}</span>
                        <button
                          type="button"
                          onClick={() => toggleHidden(id)}
                          className="text-xs text-blue-400 hover:text-blue-300 transition-colors cursor-pointer"
                        >
                          Show
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-sm text-subtle">No hidden sections</p>
              )}

              <button
                type="button"
                onClick={resetLayout}
                className="text-xs text-muted hover:text-foreground border border-border-strong rounded px-3 py-1.5 transition-colors cursor-pointer"
              >
                Reset to Default
              </button>
            </div>
          </PageSection>
        ) : null}

        {activeTab === "general" ? (
          <PageSection
            title="Algorithm Personalization"
            subtitle="Parameters are automatically learned from your data to improve accuracy"
          >
            <PersonalizationPanel />
          </PageSection>
        ) : null}

        {activeTab === "connections" ? (
          <PageSection title="Integrations" subtitle="Connect external services">
            <SlackIntegrationPanel />
          </PageSection>
        ) : null}

        {activeTab === "account" ? (
          <PageSection title="Data Export" subtitle="Download all your data">
            <ExportPanel />
          </PageSection>
        ) : null}

        {activeTab === "account" ? (
          <PageSection title="Billing" subtitle="Manage subscription and access window">
            {billingStatus.isLoading ? (
              <p className={`${billingRegionClassName} text-sm text-subtle`}>
                Loading subscription status...
              </p>
            ) : billingStatus.error ? (
              <p className={`${billingRegionClassName} text-sm text-red-400`}>
                {billingStatus.error.message}
              </p>
            ) : billingStatus.data ? (
              <div className={`${billingRegionClassName} space-y-3`}>
                <p className="text-sm text-subtle">
                  {billingStatus.data.access.kind === "limited"
                    ? `Your access is limited to your signup week (${getSignupWeekLabel(
                        billingStatus.data.access.startDate,
                        billingStatus.data.access.endDateExclusive,
                      )}).`
                    : "You currently have full access to your data."}
                </p>
                <div className="space-y-1">
                  {billingStatus.data.access.kind === "limited" ? (
                    <p className="text-xs text-muted">
                      New data is available only for this first 7 calendar days after account
                      creation.
                    </p>
                  ) : billingStatus.data.access.reason === "stripe_subscription" &&
                    billingStatus.data.stripeSubscriptionStatus ? (
                    <p className="text-xs text-muted">
                      Stripe subscription status: {billingStatus.data.stripeSubscriptionStatus}
                    </p>
                  ) : null}
                  {billingStatus.data.access.reason === "paid_grant" ? (
                    <p className="text-xs text-muted">
                      Existing account access is already granted.
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  {!billingStatus.data.hasFullAccess && (
                    <button
                      type="button"
                      onClick={() => checkoutSessionMutation.mutate()}
                      disabled={checkoutSessionMutation.isPending}
                      className="px-3 py-2 rounded bg-accent text-on-accent hover:bg-accent/90 disabled:opacity-50 transition-colors cursor-pointer"
                    >
                      {checkoutSessionMutation.isPending
                        ? "Opening checkout..."
                        : "Subscribe to Full Access"}
                    </button>
                  )}
                  {billingStatus.data.canManageBilling && (
                    <button
                      type="button"
                      onClick={() => portalSessionMutation.mutate()}
                      disabled={portalSessionMutation.isPending}
                      className="px-3 py-2 rounded border border-border-strong text-foreground hover:bg-surface-hover disabled:opacity-50 transition-colors cursor-pointer"
                    >
                      {portalSessionMutation.isPending
                        ? "Opening billing portal..."
                        : "Manage Billing"}
                    </button>
                  )}
                </div>
                {checkoutSessionMutation.error ? (
                  <p className="text-sm text-red-400">{checkoutSessionMutation.error.message}</p>
                ) : null}
                {portalSessionMutation.error ? (
                  <p className="text-sm text-red-400">{portalSessionMutation.error.message}</p>
                ) : null}
              </div>
            ) : (
              <div className={billingRegionClassName} />
            )}
          </PageSection>
        ) : null}

        {activeTab === "account" ? (
          <PageSection title="Help & Support" subtitle="Get help from our team">
            <Link
              to="/support"
              className="inline-flex items-center gap-2 rounded border border-border-strong px-4 py-2 text-sm text-foreground transition-colors hover:bg-accent/10"
            >
              Contact Support
            </Link>
          </PageSection>
        ) : null}

        {activeTab === "account" ? (
          <PageSection
            title="Danger Zone"
            subtitle="Permanently delete all synced and manually-entered data for your account"
            card={false}
          >
            <div className="rounded-lg border border-red-900/60 bg-surface-solid p-4 space-y-3">
              {showDeleteConfirm ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted">
                    Delete all your data? This action cannot be undone.
                  </span>
                  <button
                    type="button"
                    onClick={() => deleteAllDataMutation.mutate()}
                    disabled={deleteAllDataMutation.isPending}
                    className="px-3 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 transition-colors cursor-pointer"
                  >
                    {deleteAllDataMutation.isPending ? "Deleting..." : "Confirm Delete"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowDeleteConfirm(false)}
                    disabled={deleteAllDataMutation.isPending}
                    className="px-3 py-1.5 text-xs rounded bg-accent/10 text-foreground hover:bg-surface-hover disabled:opacity-50 transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(true)}
                  className="px-3 py-1.5 text-xs rounded bg-accent/10 text-red-400 hover:bg-surface-hover transition-colors cursor-pointer"
                >
                  Delete All User Data
                </button>
              )}
              {deleteAllDataMutation.error && (
                <p className="text-xs text-red-400">{deleteAllDataMutation.error.message}</p>
              )}
              {deleteAllDataMutation.isSuccess && !showDeleteConfirm && (
                <p className="text-xs text-accent">All user data has been deleted.</p>
              )}
            </div>
          </PageSection>
        ) : null}
      </div>
    </PageLayout>
  );
}
