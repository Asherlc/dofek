import { createFileRoute } from "@tanstack/react-router";
import { ChartDescriptionTooltip } from "../../components/ChartDescriptionTooltip.tsx";
import { EstimatedMaxChart } from "../../components/EstimatedMaxChart.tsx";
import { MuscleGroupVolumeChart } from "../../components/MuscleGroupVolumeChart.tsx";
import { ProgressiveOverloadCards } from "../../components/ProgressiveOverloadCards.tsx";
import { StrengthVolumeChart } from "../../components/StrengthVolumeChart.tsx";
import { useTrainingDays } from "../../lib/trainingDaysContext.ts";
import { trpc } from "../../lib/trpc.ts";

export const Route = createFileRoute("/training/strength")({
  component: StrengthTab,
});

function StrengthTab() {
  const { days } = useTrainingDays();

  const strengthVolume = trpc.strength.volumeOverTime.useQuery({ days });
  const estimatedMax = trpc.strength.estimatedOneRepMax.useQuery({ days });
  const muscleVolume = trpc.strength.muscleGroupVolume.useQuery({ days });
  const overload = trpc.strength.progressiveOverload.useQuery({ days });

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Strength Volume" subtitle="Weekly volume load over time">
          <StrengthVolumeChart
            data={strengthVolume.data ?? []}
            loading={strengthVolume.isLoading}
          />
        </Section>

        <Section
          title="Estimated 1-Rep Max"
          subtitle="Estimated max single-rep strength per exercise over time"
        >
          <EstimatedMaxChart exercises={estimatedMax.data ?? []} loading={estimatedMax.isLoading} />
        </Section>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Muscle Group Volume" subtitle="Volume distribution by muscle group">
          <MuscleGroupVolumeChart data={muscleVolume.data ?? []} loading={muscleVolume.isLoading} />
        </Section>

        <Section title="Progressive Overload" subtitle="Exercise-level overload trends">
          <ProgressiveOverloadCards exercises={overload.data ?? []} loading={overload.isLoading} />
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
