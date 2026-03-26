import { PageLayout } from "../components/PageLayout.tsx";
import { PageSection } from "../components/PageSection.tsx";
import { trpc } from "../lib/trpc.ts";

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function SyncStatusPanel() {
  const { data, isLoading } = trpc.accelerometer.getSyncStatus.useQuery();

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (!data || data.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-center">
        <p className="text-muted-foreground">
          No accelerometer data yet. Install the iOS app and grant motion permission to start
          recording.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {data.map((device) => (
        <div
          key={`${device.device_id}-${device.device_type}`}
          className="rounded-lg border border-border bg-card p-4"
        >
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-muted-foreground">{device.device_id}</p>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {device.device_type === "apple_watch" ? "Apple Watch" : "iPhone"}
            </span>
          </div>
          <p className="text-2xl font-bold">{formatNumber(device.sample_count)} samples</p>
          <p className="text-xs text-muted-foreground">
            {device.earliest_sample
              ? `${new Date(device.earliest_sample).toLocaleDateString()} — ${new Date(device.latest_sample ?? "").toLocaleDateString()}`
              : "No data"}
          </p>
        </div>
      ))}
    </div>
  );
}

function DailyCoveragePanel() {
  const { data, isLoading } = trpc.accelerometer.getDailyCounts.useQuery({ days: 30 });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (!data || data.length === 0) {
    return <p className="text-sm text-muted-foreground">No daily data available.</p>;
  }

  const maxHours = Math.max(...data.map((day) => day.hours_covered), 1);

  return (
    <div className="space-y-1">
      {data.map((day) => (
        <div key={day.date} className="flex items-center gap-3 text-sm">
          <span className="w-24 text-muted-foreground">{day.date}</span>
          <div className="flex-1">
            <div
              className="h-4 rounded bg-blue-500/80"
              style={{ width: `${(day.hours_covered / maxHours) * 100}%` }}
            />
          </div>
          <span className="w-16 text-right text-muted-foreground">
            {day.hours_covered.toFixed(1)}h
          </span>
        </div>
      ))}
    </div>
  );
}

export function AccelerometerPage() {
  return (
    <PageLayout>
      <PageSection
        title="Accelerometer"
        subtitle="Continuous 50 Hz motion data from iPhone and Apple Watch"
      >
        <SyncStatusPanel />
      </PageSection>
      <PageSection title="Daily Coverage" subtitle="Hours of accelerometer data recorded per day">
        <DailyCoveragePanel />
      </PageSection>
    </PageLayout>
  );
}
