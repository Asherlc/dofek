import { formatDateYmd } from "@dofek/format/format";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { ChartDescriptionTooltip } from "../../components/ChartDescriptionTooltip.tsx";
import { HrvVariabilityChart } from "../../components/HrvVariabilityChart.tsx";
import { ReadinessScoreCard } from "../../components/ReadinessScoreCard.tsx";
import { SleepAnalyticsChart } from "../../components/SleepAnalyticsChart.tsx";
import { WorkloadRatioChart } from "../../components/WorkloadRatioChart.tsx";
import { useTrainingDays } from "../../lib/trainingDaysContext.ts";
import { trpc } from "../../lib/trpc.ts";

export const Route = createFileRoute("/training/recovery")({
  component: RecoveryTab,
});

function RecoveryTab() {
  const { days } = useTrainingDays();
  const endDate = useMemo(() => formatDateYmd(new Date()), []);

  const hrvVariability = trpc.recovery.hrvVariability.useQuery({ days });
  const workloadRatio = trpc.recovery.workloadRatio.useQuery({ days, endDate });
  const sleepData = trpc.recovery.sleepAnalytics.useQuery({ days });
  const readiness = trpc.recovery.readinessScore.useQuery({ days, endDate });

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section
          title="Readiness Score"
          subtitle="Composite score from HRV, resting HR, sleep, load balance"
        >
          <ReadinessScoreCard data={readiness.data ?? []} loading={readiness.isLoading} />
        </Section>

        <Section
          title="Acute:Chronic Workload Ratio"
          subtitle="7-day vs 28-day training load ratio — stay between 0.8 and 1.3"
        >
          <WorkloadRatioChart
            data={workloadRatio.data?.timeSeries ?? []}
            loading={workloadRatio.isLoading}
          />
        </Section>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="HRV Coefficient of Variation" subtitle="7-day rolling HRV variability">
          <HrvVariabilityChart
            data={hrvVariability.data ?? []}
            loading={hrvVariability.isLoading}
          />
        </Section>

        <Section
          title="Sleep Analytics"
          subtitle="Nightly sleep stages, efficiency, and sleep debt"
        >
          <SleepAnalyticsChart
            nightly={sleepData.data?.nightly ?? []}
            sleepDebt={sleepData.data?.sleepDebt ?? 0}
            loading={sleepData.isLoading}
          />
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
