import { formatMeasurementText } from "@dofek/format/units";
import { createFileRoute } from "@tanstack/react-router";
import { ChartDescriptionTooltip } from "../../components/ChartDescriptionTooltip.tsx";
import { HrvBaselineChart } from "../../components/HrvBaselineChart.tsx";
import { HrvVariabilityChart } from "../../components/HrvVariabilityChart.tsx";
import { QueryStatePanel } from "../../components/QueryStatePanel.tsx";
import { SleepAnalyticsChart } from "../../components/SleepAnalyticsChart.tsx";
import { TimeSeriesChart } from "../../components/TimeSeriesChart.tsx";
import { WorkloadRatioChart } from "../../components/WorkloadRatioChart.tsx";
import { useTodayQueryDate } from "../../hooks/useTodayQueryDate.ts";
import { chartColors } from "../../lib/chartTheme.ts";
import { selectedRangeQueryInput } from "../../lib/timeRange.ts";
import { useTrainingDays } from "../../lib/trainingDaysContext.ts";
import { TRAINING_SLOW_QUERY_OPTIONS } from "../../lib/trainingQueryOptions.ts";
import { trpc } from "../../lib/trpc.ts";
import { useUnitConverter } from "../../lib/unitContext.ts";

export const Route = createFileRoute("/training/recovery")({
  component: RecoveryTab,
});

function RecoveryTab() {
  const { days } = useTrainingDays();
  const endDate = useTodayQueryDate();
  const units = useUnitConverter();

  const hrvVariability = trpc.recovery.hrvVariability.useQuery(
    { ...selectedRangeQueryInput(days), endDate },
    TRAINING_SLOW_QUERY_OPTIONS,
  );
  const hrvBaseline = trpc.dailyMetrics.hrvBaseline.useQuery(
    { ...selectedRangeQueryInput(days), endDate },
    TRAINING_SLOW_QUERY_OPTIONS,
  );
  const workloadRatio = trpc.recovery.workloadRatio.useQuery(
    { ...selectedRangeQueryInput(days), endDate },
    TRAINING_SLOW_QUERY_OPTIONS,
  );
  const sleepData = trpc.recovery.sleepAnalytics.useQuery(
    { ...selectedRangeQueryInput(days), endDate },
    TRAINING_SLOW_QUERY_OPTIONS,
  );
  const dailyMetrics = trpc.dailyMetrics.list.useQuery(
    { ...selectedRangeQueryInput(days), endDate },
    TRAINING_SLOW_QUERY_OPTIONS,
  );
  const skinTemperatureRows = dailyMetrics.data ?? [];
  const hasSkinTemperature = skinTemperatureRows.some((row) => row.skin_temp_c != null);
  const skinTemperatureSeries = [
    {
      name: "Skin Temperature",
      data: skinTemperatureRows.map((row): [string, number | null] => [
        row.date,
        row.skin_temp_c == null ? null : units.convertTemperature(row.skin_temp_c),
      ]),
      color: chartColors.amber,
      areaStyle: true,
      formatValue: (value: number) =>
        formatMeasurementText(
          units.formatTemperature(units.system === "imperial" ? (value - 32) / 1.8 : value),
        ),
    },
  ];

  return (
    <>
      <div>
        <Section
          title={workloadRatio.data?.context.label ?? "Training load comparison"}
          subtitle={workloadRatio.data?.context.description}
        >
          {workloadRatio.error && !workloadRatio.data ? (
            <QueryStatePanel error={workloadRatio.error} />
          ) : (
            <WorkloadRatioChart
              data={workloadRatio.data?.timeSeries ?? []}
              context={workloadRatio.data?.context}
              loading={workloadRatio.isLoading}
            />
          )}
        </Section>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Heart Rate Variability & Resting Heart Rate">
          {hrvBaseline.error && !hrvBaseline.data ? (
            <QueryStatePanel error={hrvBaseline.error} />
          ) : (
            <HrvBaselineChart data={hrvBaseline.data ?? []} loading={hrvBaseline.isLoading} />
          )}
        </Section>

        <Section title="Heart Rate Variability Coefficient of Variation">
          {hrvVariability.error && !hrvVariability.data ? (
            <QueryStatePanel error={hrvVariability.error} />
          ) : (
            <HrvVariabilityChart
              data={hrvVariability.data ?? []}
              loading={hrvVariability.isLoading}
            />
          )}
        </Section>

        <Section title="Sleep Analytics">
          {sleepData.error && !sleepData.data ? (
            <QueryStatePanel error={sleepData.error} />
          ) : (
            <SleepAnalyticsChart
              nightly={sleepData.data?.nightly ?? []}
              loading={sleepData.isLoading}
            />
          )}
        </Section>

        <Section title="Skin Temperature">
          {dailyMetrics.isLoading && dailyMetrics.data == null ? (
            <QueryStatePanel variant="loading" height={200} />
          ) : dailyMetrics.error && dailyMetrics.data == null ? (
            <QueryStatePanel error={dailyMetrics.error} height={200} />
          ) : (
            <>
              {dailyMetrics.error ? (
                <QueryStatePanel error={dailyMetrics.error} height={72} />
              ) : null}
              {hasSkinTemperature ? (
                <TimeSeriesChart
                  series={skinTemperatureSeries}
                  loading={dailyMetrics.isLoading}
                  yAxis={[{ name: units.temperatureLabel }]}
                />
              ) : (
                <QueryStatePanel
                  variant="empty"
                  height={200}
                  message="No skin temperature data in this date range."
                />
              )}
            </>
          )}
        </Section>
      </div>
    </>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-sm font-medium text-muted uppercase tracking-wider">{title}</h2>
        {subtitle && <ChartDescriptionTooltip description={subtitle} />}
      </div>
      <div className="card p-4">{children}</div>
    </section>
  );
}
