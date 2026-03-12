import { createFileRoute } from "@tanstack/react-router";
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

  const hrvVariability = trpc.recovery.hrvVariability.useQuery({ days });
  const workloadRatio = trpc.recovery.workloadRatio.useQuery({ days });
  const sleepData = trpc.recovery.sleepAnalytics.useQuery({ days });
  const readiness = trpc.recovery.readinessScore.useQuery({ days });

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section
          title="Readiness Score"
          subtitle="Composite score from HRV, resting HR, sleep, load balance"
        >
          <ReadinessScoreCard
            data={(readiness.data ?? []) as never[]}
            loading={readiness.isLoading}
          />
        </Section>

        <Section title="Acute:Chronic Workload Ratio" subtitle="TRIMP-based training load balance">
          <WorkloadRatioChart
            data={(workloadRatio.data ?? []) as never[]}
            loading={workloadRatio.isLoading}
          />
        </Section>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="HRV Coefficient of Variation" subtitle="7-day rolling HRV variability">
          <HrvVariabilityChart
            data={(hrvVariability.data ?? []) as never[]}
            loading={hrvVariability.isLoading}
          />
        </Section>

        <Section
          title="Sleep Analytics"
          subtitle="Nightly sleep stages, efficiency, and sleep debt"
        >
          <SleepAnalyticsChart
            nightly={
              ((sleepData.data as Record<string, unknown> | undefined)?.nightly ?? []) as never[]
            }
            sleepDebt={
              ((sleepData.data as Record<string, unknown> | undefined)?.sleepDebt as number) ?? 0
            }
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
  return (
    <section>
      <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-1">{title}</h2>
      {subtitle && <p className="text-xs text-zinc-600 mb-4">{subtitle}</p>}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">{children}</div>
    </section>
  );
}
