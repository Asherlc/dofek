import { AppHeader } from "../components/AppHeader.tsx";
import { LifeEventsPanel } from "../components/LifeEventsPanel.tsx";

export function TrackingPage() {
  return (
    <div className="min-h-screen bg-page text-foreground overflow-x-hidden">
      <AppHeader />
      <main className="mx-auto max-w-7xl px-3 sm:px-6 py-4 sm:py-6 space-y-6 sm:space-y-8">
        <section>
          <h2 className="text-sm font-medium text-muted uppercase tracking-wider mb-1">
            Life Events
          </h2>
          <p className="text-xs text-dim mb-4">Track changes and see their impact</p>
          <div className="card p-2 sm:p-4">
            <LifeEventsPanel />
          </div>
        </section>
      </main>
    </div>
  );
}
