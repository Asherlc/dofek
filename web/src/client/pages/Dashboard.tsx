import { useMemo, useState } from "react";
import { ActivityList } from "../components/ActivityList.tsx";
import { AppHeader } from "../components/AppHeader.tsx";
import { HealthStatusBar } from "../components/HealthStatusBar.tsx";
import { HrvBaselineChart } from "../components/HrvBaselineChart.tsx";
import { NutritionChart } from "../components/NutritionChart.tsx";
import { SleepChart } from "../components/SleepChart.tsx";
import { TimeRangeSelector } from "../components/TimeRangeSelector.tsx";
import { TimeSeriesChart } from "../components/TimeSeriesChart.tsx";
import { trpc } from "../lib/trpc.ts";

export function Dashboard() {
  const [days, setDays] = useState(30);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    bodyComp: true,
  });

  const toggle = (key: string) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

  const trends = trpc.dailyMetrics.trends.useQuery({ days });
  const dailyMetrics = trpc.dailyMetrics.list.useQuery({ days });
  const activities = trpc.activity.list.useQuery({ days });
  const sleepData = trpc.sleep.list.useQuery({ days });
  const hrvBaseline = trpc.dailyMetrics.hrvBaseline.useQuery({ days });
  const bodyData = trpc.body.list.useQuery({ days: Math.max(days, 90) });
  const nutritionData = trpc.nutrition.daily.useQuery({ days });
  const t = trends.data as any;

  const healthMetrics = useMemo(
    () =>
      t
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
            t.latest_spo2 != null && {
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
            t.latest_skin_temp != null && {
              label: "Skin Temp",
              value: t.latest_skin_temp,
              avg: t.avg_skin_temp,
              stddev: t.stddev_skin_temp,
              unit: "°C",
            },
          ].filter(
            (
              m,
            ): m is {
              label: string;
              value: any;
              avg: any;
              stddev: any;
              unit: string;
              lowerBetter?: boolean;
            } => Boolean(m),
          )
        : [],
    [t],
  );

  const metrics = (dailyMetrics.data ?? []) as any[];

  const hasSpO2 = metrics.some((d) => d.spo2_avg != null);
  const hasSkinTemp = metrics.some((d) => d.skin_temp_c != null);

  const spo2Series = useMemo(
    () => ({
      name: "SpO2",
      data: metrics.map((d) => [d.date, d.spo2_avg] as [string, number | null]),
      color: "#3b82f6",
      areaStyle: true,
    }),
    [metrics],
  );

  const skinTempSeries = useMemo(
    () => ({
      name: "Skin Temp",
      data: metrics.map((d) => [d.date, d.skin_temp_c] as [string, number | null]),
      color: "#f59e0b",
    }),
    [metrics],
  );

  const stepsSeries = useMemo(
    () => ({
      name: "Steps",
      data: metrics.map((d) => [d.date, d.steps] as [string, number | null]),
      color: "#8b5cf6",
      areaStyle: true,
    }),
    [metrics],
  );

  const body = (bodyData.data ?? []) as any[];
  const weightSeries = useMemo(
    () => ({
      name: "Weight",
      data: body
        .filter((d) => d.weight_kg != null)
        .map(
          (d) => [new Date(d.recorded_at).toISOString(), d.weight_kg] as [string, number | null],
        ),
      color: "#06b6d4",
    }),
    [body],
  );
  const bodyFatSeries = useMemo(
    () => ({
      name: "Body Fat",
      data: body
        .filter((d) => d.body_fat_pct != null)
        .map(
          (d) =>
            [new Date(d.recorded_at).toISOString(), d.body_fat_pct] as [string, number | null],
        ),
      color: "#f97316",
      yAxisIndex: 1,
    }),
    [body],
  );

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <AppHeader activePage="dashboard">
        <div className="flex items-center gap-4">
          <p className="text-xs text-zinc-500">
            {t?.latest_date
              ? `Latest: ${new Date(t.latest_date).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}`
              : ""}
          </p>
          <TimeRangeSelector days={days} onChange={setDays} />
        </div>
      </AppHeader>

      <main className="mx-auto max-w-7xl p-6 space-y-8">
        {/* Health Monitor */}
        <CollapsibleSection
          id="healthMonitor"
          title="Health Monitor"
          subtitle="Today's values vs. rolling average"
          collapsed={collapsed.healthMonitor}
          onToggle={() => toggle("healthMonitor")}
        >
          <HealthStatusBar metrics={healthMetrics} loading={trends.isLoading} />
        </CollapsibleSection>

        {/* HRV & Resting HR */}
        <CollapsibleSection
          id="hrvRhr"
          title="Heart Rate Variability & Resting HR"
          subtitle="60-day baseline band with 7-day rolling average"
          collapsed={collapsed.hrvRhr}
          onToggle={() => toggle("hrvRhr")}
        >
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <HrvBaselineChart
              data={
                (hrvBaseline.data ?? []) as {
                  date: string;
                  hrv: number | null;
                  resting_hr: number | null;
                  mean_60d: number | null;
                  sd_60d: number | null;
                  mean_7d: number | null;
                }[]
              }
              loading={hrvBaseline.isLoading}
            />
          </div>
        </CollapsibleSection>

        {/* Two-column: SpO2 + Skin Temp | Steps */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {(hasSpO2 || hasSkinTemp) && (
            <CollapsibleSection
              id="spo2Temp"
              title="SpO2 & Skin Temperature"
              collapsed={collapsed.spo2Temp}
              onToggle={() => toggle("spo2Temp")}
            >
              <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                <TimeSeriesChart
                  series={[
                    ...(hasSpO2 ? [spo2Series] : []),
                    ...(hasSkinTemp ? [skinTempSeries] : []),
                  ]}
                  height={200}
                  yAxis={[{ name: "SpO2 (%)", min: 90 }, { name: "°C" }]}
                  loading={dailyMetrics.isLoading}
                />
              </div>
            </CollapsibleSection>
          )}

          <CollapsibleSection
            id="steps"
            title="Daily Steps"
            collapsed={collapsed.steps}
            onToggle={() => toggle("steps")}
          >
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
              <TimeSeriesChart
                series={[stepsSeries]}
                height={200}
                yAxis={[{ name: "steps" }]}
                loading={dailyMetrics.isLoading}
              />
            </div>
          </CollapsibleSection>
        </div>

        {/* Sleep */}
        <CollapsibleSection
          id="sleep"
          title="Sleep"
          subtitle={`Stage breakdown (${days} days)`}
          collapsed={collapsed.sleep}
          onToggle={() => toggle("sleep")}
        >
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <SleepChart data={(sleepData.data ?? []) as any[]} loading={sleepData.isLoading} />
          </div>
        </CollapsibleSection>

        {/* Nutrition */}
        <CollapsibleSection
          id="nutrition"
          title="Nutrition"
          subtitle={`Calories & macros (${days} days)`}
          collapsed={collapsed.nutrition}
          onToggle={() => toggle("nutrition")}
        >
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <NutritionChart
              data={(nutritionData.data ?? []) as any[]}
              loading={nutritionData.isLoading}
            />
          </div>
        </CollapsibleSection>

        {/* Body Composition */}
        <CollapsibleSection
          id="bodyComp"
          title="Body Composition"
          subtitle={`${Math.max(days, 90)}-day trend`}
          collapsed={collapsed.bodyComp}
          onToggle={() => toggle("bodyComp")}
        >
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <TimeSeriesChart
              series={[weightSeries, bodyFatSeries]}
              height={200}
              yAxis={[{ name: "kg", min: "dataMin" }, { name: "% fat" }]}
              loading={bodyData.isLoading}
            />
          </div>
        </CollapsibleSection>

        {/* Recent Activities */}
        <CollapsibleSection
          id="activities"
          title="Recent Activities"
          subtitle={`Last ${days} days`}
          collapsed={collapsed.activities}
          onToggle={() => toggle("activities")}
        >
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <ActivityList
              activities={(activities.data ?? []) as any[]}
              loading={activities.isLoading}
            />
          </div>
        </CollapsibleSection>
      </main>
    </div>
  );
}

function CollapsibleSection({
  title,
  subtitle,
  collapsed,
  onToggle,
  children,
}: {
  id?: string;
  title: string;
  subtitle?: string;
  collapsed?: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section>
      <button
        type="button"
        onClick={onToggle}
        className="mb-3 flex items-center gap-2 group cursor-pointer w-full text-left"
      >
        <span
          className={`text-zinc-600 text-xs transition-transform ${collapsed ? "" : "rotate-90"}`}
        >
          ▶
        </span>
        <div>
          <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider group-hover:text-zinc-300 transition-colors">
            {title}
          </h2>
          {subtitle && <p className="text-xs text-zinc-600 mt-0.5">{subtitle}</p>}
        </div>
      </button>
      {!collapsed && children}
    </section>
  );
}
