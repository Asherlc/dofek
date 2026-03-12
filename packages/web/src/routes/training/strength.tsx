import { createFileRoute } from "@tanstack/react-router";
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
            data={(strengthVolume.data ?? []) as never[]}
            loading={strengthVolume.isLoading}
          />
        </Section>

        <Section title="Estimated 1-Rep Max" subtitle="Epley-formula e1RM trends per exercise">
          <EstimatedMaxChart
            exercises={(estimatedMax.data ?? []) as never[]}
            loading={estimatedMax.isLoading}
          />
        </Section>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Muscle Group Volume" subtitle="Volume distribution by muscle group">
          <MuscleGroupVolumeChart
            data={(muscleVolume.data ?? []) as never[]}
            loading={muscleVolume.isLoading}
          />
        </Section>

        <Section title="Progressive Overload" subtitle="Exercise-level overload trends">
          <ProgressiveOverloadCards
            exercises={(overload.data ?? []) as never[]}
            loading={overload.isLoading}
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
