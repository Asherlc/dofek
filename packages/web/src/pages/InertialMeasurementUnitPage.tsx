import { PageLayout } from "../components/PageLayout.tsx";
import { PageSection } from "../components/PageSection.tsx";
import { trpc } from "../lib/trpc.ts";

function formatNumber(n: number): string {
  return n.toLocaleString();
}

/** Map raw device_type from the server to a user-friendly label */
function deviceLabel(deviceType: string, deviceId: string): string {
  switch (deviceType) {
    case "iphone":
      return "iPhone";
    case "apple_watch":
      return "Apple Watch";
    case "whoop":
      return "WHOOP Strap";
    default:
      return deviceId;
  }
}

function SyncStatusPanel() {
  const { data, isLoading, isError } = trpc.inertialMeasurementUnit.getSyncStatus.useQuery();

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (isError) return <p className="text-sm text-red-400">Failed to load motion data.</p>;
  if (!data || data.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-center">
        <p className="text-muted-foreground">
          No motion data yet. Install the iOS app and grant motion permission to start recording.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {data.map((device) => (
        <div
          key={`${device.deviceId}-${device.deviceType}`}
          className="rounded-lg border border-border bg-card p-4"
        >
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{deviceLabel(device.deviceType, device.deviceId)}</p>
          </div>
          <p className="text-2xl font-bold">{formatNumber(device.sampleCount)} samples</p>
          <p className="text-xs text-muted-foreground">
            {device.earliestSample
              ? `${new Date(device.earliestSample).toLocaleDateString()} — ${new Date(device.latestSample ?? "").toLocaleDateString()}`
              : "No data"}
          </p>
        </div>
      ))}
    </div>
  );
}

function DailyCoveragePanel() {
  const { data, isLoading, isError } = trpc.inertialMeasurementUnit.getDailyCounts.useQuery({
    days: 30,
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (isError) return <p className="text-sm text-red-400">Failed to load daily coverage data.</p>;
  if (!data || data.length === 0) {
    return <p className="text-sm text-muted-foreground">No daily data available.</p>;
  }

  const maxHours = Math.max(...data.map((day) => day.hoursCovered), 1);

  return (
    <div className="space-y-1">
      {data.map((day) => (
        <div key={day.date} className="flex items-center gap-3 text-sm">
          <span className="w-24 text-muted-foreground">{day.date}</span>
          <div className="flex-1">
            <div
              className="h-4 rounded bg-blue-500/80"
              style={{ width: `${(day.hoursCovered / maxHours) * 100}%` }}
            />
          </div>
          <span className="w-16 text-right text-muted-foreground">
            {day.hoursCovered.toFixed(1)}h
          </span>
        </div>
      ))}
    </div>
  );
}

export function InertialMeasurementUnitPage() {
  return (
    <PageLayout>
      <PageSection
        title="Motion Tracking"
        subtitle="Continuous 50 Hz motion data (accelerometer + gyroscope) from iPhone, Apple Watch, and WHOOP"
      >
        <SyncStatusPanel />
      </PageSection>
      <PageSection title="Daily Coverage" subtitle="Hours of motion data recorded per day">
        <DailyCoveragePanel />
      </PageSection>
    </PageLayout>
  );
}
