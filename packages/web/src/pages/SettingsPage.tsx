import { useState } from "react";
import { DataSourcesPanel } from "../components/DataSourcesPanel.tsx";
import { ExportPanel } from "../components/ExportPanel.tsx";
import { LinkedAccountsPanel } from "../components/LinkedAccountsPanel.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { PageSection } from "../components/PageSection.tsx";
import { PersonalizationPanel } from "../components/PersonalizationPanel.tsx";
import { SlackIntegrationPanel } from "../components/SlackIntegrationPanel.tsx";
import { UnitSystemToggle } from "../components/UnitSystemToggle.tsx";
import { SECTION_LABELS, useDashboardLayout } from "../lib/dashboardLayoutContext.ts";
import { trpc } from "../lib/trpc.ts";

export function SettingsPage() {
  const { layout, toggleHidden, resetLayout } = useDashboardLayout();
  const trpcUtils = trpc.useUtils();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const deleteAllDataMutation = trpc.settings.deleteAllUserData.useMutation({
    onSuccess: async () => {
      setShowDeleteConfirm(false);
      await trpcUtils.invalidate();
    },
  });

  const hiddenSections = layout.hidden;

  return (
    <PageLayout>
      <PageSection title="Data Sources" subtitle="Connect and manage health data providers">
        <DataSourcesPanel />
      </PageSection>

      <PageSection title="Linked Accounts" subtitle="Manage login methods linked to your account">
        <LinkedAccountsPanel />
      </PageSection>

      <PageSection title="Units" subtitle="Choose how measurements are displayed">
        <UnitSystemToggle />
      </PageSection>

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

      <PageSection
        title="Algorithm Personalization"
        subtitle="Parameters are automatically learned from your data to improve accuracy"
      >
        <PersonalizationPanel />
      </PageSection>

      <PageSection title="Integrations" subtitle="Connect external services">
        <SlackIntegrationPanel />
      </PageSection>

      <PageSection title="Data Export" subtitle="Download all your data">
        <ExportPanel />
      </PageSection>

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
    </PageLayout>
  );
}
