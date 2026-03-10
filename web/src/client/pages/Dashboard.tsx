import { ActivityList } from "../components/ActivityList.js";
import { MetricCard } from "../components/MetricCard.js";
import { trpc } from "../lib/trpc.js";

export function Dashboard() {
  const latest = trpc.dailyMetrics.latest.useQuery();
  const activities = trpc.activity.list.useQuery({ days: 7 });
  const sleep = trpc.sleep.list.useQuery({ days: 7 });

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-6 py-4">
        <h1 className="text-xl font-semibold tracking-tight">Health Dashboard</h1>
      </header>

      <main className="mx-auto max-w-7xl p-6 space-y-8">
        {/* Today's metrics */}
        <section>
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-4">Today</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
            <MetricCard
              label="Resting HR"
              value={latest.data?.resting_hr}
              unit="bpm"
              loading={latest.isLoading}
            />
            <MetricCard label="HRV" value={latest.data?.hrv} unit="ms" loading={latest.isLoading} />
            <MetricCard
              label="SpO2"
              value={latest.data?.spo2_avg}
              unit="%"
              loading={latest.isLoading}
            />
            <MetricCard label="Steps" value={latest.data?.steps} loading={latest.isLoading} />
            <MetricCard
              label="Active Energy"
              value={latest.data?.active_energy_kcal}
              unit="kcal"
              loading={latest.isLoading}
            />
            <MetricCard
              label="Skin Temp"
              value={latest.data?.skin_temp_c}
              unit="°C"
              loading={latest.isLoading}
            />
          </div>
        </section>

        {/* Recent sleep */}
        <section>
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-4">
            Recent Sleep
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {sleep.isLoading && <div className="text-zinc-500">Loading...</div>}
            {sleep.data?.map((s: any) => (
              <div
                key={s.id}
                className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 space-y-2"
              >
                <div className="text-sm text-zinc-400">
                  {new Date(s.started_at).toLocaleDateString()}
                </div>
                <div className="text-2xl font-semibold">
                  {s.duration_minutes
                    ? `${Math.floor(s.duration_minutes / 60)}h ${s.duration_minutes % 60}m`
                    : "—"}
                </div>
                <div className="flex gap-3 text-xs text-zinc-500">
                  <span>Deep: {s.deep_minutes ?? "—"}m</span>
                  <span>REM: {s.rem_minutes ?? "—"}m</span>
                  <span>Efficiency: {s.efficiency_pct ?? "—"}%</span>
                </div>
                {s.source_providers && (
                  <div className="text-xs text-zinc-600">{s.source_providers.join(", ")}</div>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Recent activities */}
        <section>
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-4">
            Recent Activities
          </h2>
          <ActivityList activities={activities.data ?? []} loading={activities.isLoading} />
        </section>
      </main>
    </div>
  );
}
