import { AppHeader } from "../components/AppHeader.tsx";
import { LifeEventsPanel } from "../components/LifeEventsPanel.tsx";
import { SupplementStackPanel } from "../components/SupplementStackPanel.tsx";

export function SettingsPage() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 overflow-x-hidden">
      <AppHeader />
      <main className="mx-auto max-w-7xl px-3 sm:px-6 py-4 sm:py-6 space-y-6 sm:space-y-8">
        <section>
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-1">
            Life Events
          </h2>
          <p className="text-xs text-zinc-600 mb-4">Track changes and see their impact</p>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-2 sm:p-4">
            <LifeEventsPanel />
          </div>
        </section>

        <section>
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-1">
            Supplement Stack
          </h2>
          <p className="text-xs text-zinc-600 mb-4">Daily supplements synced as nutrition data</p>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-2 sm:p-4">
            <SupplementStackPanel />
          </div>
        </section>
      </main>
    </div>
  );
}
