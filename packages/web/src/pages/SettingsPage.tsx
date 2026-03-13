import { AppHeader } from "../components/AppHeader.tsx";
import { SlackIntegrationPanel } from "../components/SlackIntegrationPanel.tsx";
import { UnitSystemToggle } from "../components/UnitSystemToggle.tsx";

export function SettingsPage() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 overflow-x-hidden">
      <AppHeader />
      <main className="mx-auto max-w-7xl px-3 sm:px-6 py-4 sm:py-6 space-y-6 sm:space-y-8">
        <section>
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-1">Units</h2>
          <p className="text-xs text-zinc-600 mb-4">Choose how measurements are displayed</p>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <UnitSystemToggle />
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
      </main>
    </div>
  );
}
