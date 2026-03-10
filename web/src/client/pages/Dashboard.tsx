import { ActivityList } from "../components/ActivityList.js";
import { HealthStatusBar } from "../components/HealthStatusBar.js";
import { InsightsPanel } from "../components/InsightsPanel.js";
import { NutritionChart } from "../components/NutritionChart.js";
import { SleepChart } from "../components/SleepChart.js";
import { TimeSeriesChart } from "../components/TimeSeriesChart.js";
import { trpc } from "../lib/trpc.js";

export function Dashboard() {
  const trends = trpc.dailyMetrics.trends.useQuery({ days: 30 });
  const dailyMetrics = trpc.dailyMetrics.list.useQuery({ days: 30 });
  const activities = trpc.activity.list.useQuery({ days: 30 });
  const sleepData = trpc.sleep.list.useQuery({ days: 14 });
  const bodyData = trpc.body.list.useQuery({ days: 90 });
  const nutritionData = trpc.nutrition.daily.useQuery({ days: 14 });
  const insightsData = trpc.insights.compute.useQuery({ days: 90 });

  const t = trends.data as any;

  const healthMetrics = t
    ? [
        {
          label: "Resting HR",
          value: t.latest_resting_hr,
          avg: t.avg_resting_hr,
          stddev: t.stddev_resting_hr,
          unit: "bpm",
          lowerBetter: true,
        },
        {
          label: "HRV",
          value: t.latest_hrv,
          avg: t.avg_hrv,
          stddev: t.stddev_hrv,
          unit: "ms",
        },
        {
          label: "SpO2",
          value: t.latest_spo2,
          avg: t.avg_spo2,
          stddev: t.stddev_spo2,
          unit: "%",
        },
        {
          label: "Steps",
          value: t.latest_steps,
          avg: t.avg_steps,
          stddev: null,
          unit: "",
        },
        {
          label: "Active Energy",
          value: t.latest_active_energy,
          avg: t.avg_active_energy,
          stddev: null,
          unit: "kcal",
        },
        {
          label: "Skin Temp",
          value: t.latest_skin_temp,
          avg: t.avg_skin_temp,
          stddev: t.stddev_skin_temp,
          unit: "°C",
        },
      ]
    : [];

  const metrics = (dailyMetrics.data ?? []) as any[];

  const hrvSeries = {
    name: "HRV",
    data: metrics.map((d) => [d.date, d.hrv] as [string, number | null]),
    color: "#22c55e",
    areaStyle: true,
  };

  const restingHrSeries = {
    name: "Resting HR",
    data: metrics.map((d) => [d.date, d.resting_hr] as [string, number | null]),
    color: "#ef4444",
  };

  const spo2Series = {
    name: "SpO2",
    data: metrics.map((d) => [d.date, d.spo2_avg] as [string, number | null]),
    color: "#3b82f6",
    areaStyle: true,
  };

  const skinTempSeries = {
    name: "Skin Temp",
    data: metrics.map((d) => [d.date, d.skin_temp_c] as [string, number | null]),
    color: "#f59e0b",
  };

  const stepsSeries = {
    name: "Steps",
    data: metrics.map((d) => [d.date, d.steps] as [string, number | null]),
    color: "#8b5cf6",
    areaStyle: true,
  };

  const body = (bodyData.data ?? []) as any[];
  const weightSeries = {
    name: "Weight",
    data: body
      .filter((d) => d.weight_kg != null)
      .map((d) => [d.recorded_at, d.weight_kg] as [string, number | null]),
    color: "#06b6d4",
  };
  const bodyFatSeries = {
    name: "Body Fat",
    data: body
      .filter((d) => d.body_fat_pct != null)
      .map((d) => [d.recorded_at, d.body_fat_pct] as [string, number | null]),
    color: "#f97316",
    yAxisIndex: 1,
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-6 py-4">
        <h1 className="text-xl font-semibold tracking-tight">Health Dashboard</h1>
        <p className="text-xs text-zinc-500 mt-1">
          {t?.latest_date
            ? `Latest: ${new Date(t.latest_date).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}`
            : ""}
        </p>
      </header>

      <main className="mx-auto max-w-7xl p-6 space-y-8">
        {/* Health Monitor */}
        <section>
          <SectionHeader title="Health Monitor" subtitle="30-day baseline comparison" />
          <HealthStatusBar metrics={healthMetrics} loading={trends.isLoading} />
        </section>

        {/* Insights */}
        <section>
          <SectionHeader title="Insights" subtitle="Actionable patterns from your data (90 days)" />
          <InsightsPanel
            insights={(insightsData.data ?? []) as any[]}
            loading={insightsData.isLoading}
          />
        </section>

        {/* HRV & Resting HR */}
        <section>
          <SectionHeader title="Heart Rate Variability & Resting HR" />
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <TimeSeriesChart
              series={[hrvSeries, restingHrSeries]}
              height={250}
              yAxis={[
                { name: "HRV (ms)", min: "dataMin" },
                { name: "RHR (bpm)", min: "dataMin" },
              ]}
              loading={dailyMetrics.isLoading}
            />
          </div>
        </section>

        {/* Two-column: SpO2 + Skin Temp | Steps */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <section>
            <SectionHeader title="SpO2 & Skin Temperature" />
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
              <TimeSeriesChart
                series={[spo2Series, skinTempSeries]}
                height={200}
                yAxis={[{ name: "SpO2 (%)", min: 90 }, { name: "°C" }]}
                loading={dailyMetrics.isLoading}
              />
            </div>
          </section>

          <section>
            <SectionHeader title="Daily Steps" />
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
              <TimeSeriesChart
                series={[stepsSeries]}
                height={200}
                yAxis={[{ name: "steps" }]}
                loading={dailyMetrics.isLoading}
              />
            </div>
          </section>
        </div>

        {/* Sleep */}
        <section>
          <SectionHeader title="Sleep" subtitle="Stage breakdown (14 days)" />
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <SleepChart data={(sleepData.data ?? []) as any[]} loading={sleepData.isLoading} />
          </div>
        </section>

        {/* Nutrition */}
        <section>
          <SectionHeader title="Nutrition" subtitle="Calories & macros (14 days)" />
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <NutritionChart
              data={(nutritionData.data ?? []) as any[]}
              loading={nutritionData.isLoading}
            />
          </div>
        </section>

        {/* Body Composition */}
        <section>
          <SectionHeader title="Body Composition" subtitle="90-day trend" />
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <TimeSeriesChart
              series={[weightSeries, bodyFatSeries]}
              height={200}
              yAxis={[{ name: "kg", min: "dataMin" }, { name: "% fat" }]}
              loading={bodyData.isLoading}
            />
          </div>
        </section>

        {/* Recent Activities */}
        <section>
          <SectionHeader title="Recent Activities" subtitle="Last 30 days" />
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <ActivityList
              activities={(activities.data ?? []) as any[]}
              loading={activities.isLoading}
            />
          </div>
        </section>
      </main>
    </div>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider">{title}</h2>
      {subtitle && <p className="text-xs text-zinc-600 mt-0.5">{subtitle}</p>}
    </div>
  );
}
