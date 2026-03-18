import { AppHeader } from "../components/AppHeader.tsx";
import { ExportPanel } from "../components/ExportPanel.tsx";
import { LinkedAccountsPanel } from "../components/LinkedAccountsPanel.tsx";
import { PersonalizationPanel } from "../components/PersonalizationPanel.tsx";
import { SlackIntegrationPanel } from "../components/SlackIntegrationPanel.tsx";
import { UnitSystemToggle } from "../components/UnitSystemToggle.tsx";
import { SECTION_LABELS, useDashboardLayout } from "../lib/dashboardLayoutContext.ts";

export function SettingsPage() {
  const { layout, toggleHidden, resetLayout } = useDashboardLayout();

  const hiddenSections = layout.hidden;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 overflow-x-hidden">
      <AppHeader />
      <main className="mx-auto max-w-7xl px-3 sm:px-6 py-4 sm:py-6 space-y-6 sm:space-y-8">
        <section>
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-1">
            Linked Accounts
          </h2>
          <p className="text-xs text-zinc-600 mb-4">Manage login methods linked to your account</p>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <LinkedAccountsPanel />
          </div>
        </section>

        <section>
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-1">Units</h2>
          <p className="text-xs text-zinc-600 mb-4">Choose how measurements are displayed</p>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <UnitSystemToggle />
          </div>
        </section>

        <section>
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-1">
            Dashboard Layout
          </h2>
          <p className="text-xs text-zinc-600 mb-4">
            Manage hidden sections and reset layout to defaults
          </p>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 space-y-4">
            {hiddenSections.length > 0 ? (
              <div className="space-y-2">
                <h3 className="text-xs font-medium text-zinc-500 uppercase">Hidden Sections</h3>
                <ul className="space-y-1">
                  {hiddenSections.map((id) => (
                    <li
                      key={id}
                      className="flex items-center justify-between py-1.5 px-2 rounded bg-zinc-800/50"
                    >
                      <span className="text-sm text-zinc-300">{SECTION_LABELS[id] ?? id}</span>
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
              <p className="text-sm text-zinc-500">No hidden sections</p>
            )}

            <button
              type="button"
              onClick={resetLayout}
              className="text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded px-3 py-1.5 transition-colors cursor-pointer"
            >
              Reset to Default
            </button>
          </div>
        </section>

        <section>
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-1">
            Algorithm Personalization
          </h2>
          <p className="text-xs text-zinc-600 mb-4">
            Parameters are automatically learned from your data to improve accuracy
          </p>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <PersonalizationPanel />
          </div>
        </section>

        <section>
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-1">
            Integrations
          </h2>
          <p className="text-xs text-zinc-600 mb-4">Connect external services</p>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <SlackIntegrationPanel />
          </div>
        </section>
        <section>
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-1">
            Data Export
          </h2>
          <p className="text-xs text-zinc-600 mb-4">Download all your data</p>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <ExportPanel />
          </div>
        </section>
      </main>
    </div>
  );
}
