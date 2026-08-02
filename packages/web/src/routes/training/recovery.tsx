import { formatDateYmd } from "@dofek/format/format";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { ChartDescriptionTooltip } from "../../components/ChartDescriptionTooltip.tsx";
import { HrvBaselineChart } from "../../components/HrvBaselineChart.tsx";
import { HrvVariabilityChart } from "../../components/HrvVariabilityChart.tsx";
import { QueryStatePanel } from "../../components/QueryStatePanel.tsx";
import { ReadinessScoreCard } from "../../components/ReadinessScoreCard.tsx";
import { SleepAnalyticsChart } from "../../components/SleepAnalyticsChart.tsx";
import { TodayPlanCard } from "../../components/TodayPlanCard.tsx";
import { WorkloadRatioChart } from "../../components/WorkloadRatioChart.tsx";
import { selectedRangeQueryInput } from "../../lib/timeRange.ts";
import { useTrainingDays } from "../../lib/trainingDaysContext.ts";
import { TRAINING_SLOW_QUERY_OPTIONS } from "../../lib/trainingQueryOptions.ts";
import { trpc } from "../../lib/trpc.ts";

export const Route = createFileRoute("/training/recovery")({
  component: RecoveryTab,
});

function RecoveryTab() {
  const { days } = useTrainingDays();
  const endDate = useMemo(() => formatDateYmd(new Date()), []);

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
  const readiness = trpc.recovery.readinessScore.useQuery(
    { ...selectedRangeQueryInput(days), endDate },
    TRAINING_SLOW_QUERY_OPTIONS,
  );
  const todayPlan = trpc.todayPlan.get.useQuery({ days: 30, endDate }, TRAINING_SLOW_QUERY_OPTIONS);

  return (
    <>
      <TodayPlanCard plan={todayPlan.data} loading={todayPlan.isLoading} error={todayPlan.error} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section
          title="Readiness Score"
          subtitle="Composite score from heart rate variability, resting heart rate, sleep, and load balance"
        >
          {readiness.error && !readiness.data ? (
            <QueryStatePanel error={readiness.error} />
          ) : (
            <ReadinessScoreCard data={readiness.data ?? []} loading={readiness.isLoading} />
          )}
        </Section>

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
        <Section
          title="Heart Rate Variability & Resting Heart Rate"
          subtitle="Daily recovery vitals with 7-day averages"
        >
          {hrvBaseline.error && !hrvBaseline.data ? (
            <QueryStatePanel error={hrvBaseline.error} />
          ) : (
            <HrvBaselineChart data={hrvBaseline.data ?? []} loading={hrvBaseline.isLoading} />
          )}
        </Section>

        <Section
          title="Heart Rate Variability Coefficient of Variation"
          subtitle="7-day rolling heart rate variability"
        >
          {hrvVariability.error && !hrvVariability.data ? (
            <QueryStatePanel error={hrvVariability.error} />
          ) : (
            <HrvVariabilityChart
              data={hrvVariability.data ?? []}
              loading={hrvVariability.isLoading}
            />
          )}
        </Section>

        <Section
          title="Sleep Analytics"
          subtitle="Nightly sleep stages, efficiency, and sleep debt"
        >
          {sleepData.error && !sleepData.data ? (
            <QueryStatePanel error={sleepData.error} />
          ) : (
            <SleepAnalyticsChart
              nightly={sleepData.data?.nightly ?? []}
              sleepDebt={sleepData.data?.sleepDebt ?? null}
              loading={sleepData.isLoading}
            />
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
  const description = subtitle ?? `${title} chart.`;

  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-sm font-medium text-muted uppercase tracking-wider">{title}</h2>
        <ChartDescriptionTooltip description={description} />
      </div>
      {subtitle && <p className="text-xs text-dim mb-4">{subtitle}</p>}
      <div className="card p-4" title={description}>
        {children}
      </div>
    </section>
  );
}
