import { createLazyFileRoute } from "@tanstack/react-router";
import { EstimatedMaxChart } from "../../components/EstimatedMaxChart.tsx";
import { MuscleGroupVolumeChart } from "../../components/MuscleGroupVolumeChart.tsx";
import { ProgressiveOverloadCards } from "../../components/ProgressiveOverloadCards.tsx";
import { QueryStatePanel } from "../../components/QueryStatePanel.tsx";
import { StrengthVolumeChart } from "../../components/StrengthVolumeChart.tsx";
import { selectedRangeQueryInput } from "../../lib/timeRange.ts";
import { useTrainingDays } from "../../lib/trainingDaysContext.ts";
import { TRAINING_SLOW_QUERY_OPTIONS } from "../../lib/trainingQueryOptions.ts";
import { trpc } from "../../lib/trpc.ts";

export const Route = createLazyFileRoute("/training/strength")({
  component: StrengthTab,
});

function StrengthTab() {
  const { days } = useTrainingDays();
  const strengthVolume = trpc.strength.volumeOverTime.useQuery(
    selectedRangeQueryInput(days),
    TRAINING_SLOW_QUERY_OPTIONS,
  );
  const estimatedMax = trpc.strength.estimatedOneRepMax.useQuery(
    selectedRangeQueryInput(days),
    TRAINING_SLOW_QUERY_OPTIONS,
  );
  const muscleVolume = trpc.strength.muscleGroupVolume.useQuery(
    selectedRangeQueryInput(days),
    TRAINING_SLOW_QUERY_OPTIONS,
  );
  const overload = trpc.strength.progressiveOverload.useQuery(
    selectedRangeQueryInput(days),
    TRAINING_SLOW_QUERY_OPTIONS,
  );

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Strength Volume">
          {strengthVolume.error && !strengthVolume.data ? (
            <QueryStatePanel error={strengthVolume.error} />
          ) : (
            <StrengthVolumeChart
              data={strengthVolume.data ?? []}
              loading={strengthVolume.isLoading}
            />
          )}
        </Section>

        <Section title="Estimated single-rep strength">
          {estimatedMax.error && !estimatedMax.data ? (
            <QueryStatePanel error={estimatedMax.error} />
          ) : (
            <EstimatedMaxChart
              exercises={estimatedMax.data ?? []}
              loading={estimatedMax.isLoading}
            />
          )}
        </Section>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Muscle Group Volume">
          {muscleVolume.error && !muscleVolume.data ? (
            <QueryStatePanel error={muscleVolume.error} />
          ) : (
            <MuscleGroupVolumeChart
              data={muscleVolume.data ?? []}
              loading={muscleVolume.isLoading}
            />
          )}
        </Section>

        <Section title="Exercise Volume Trends">
          {overload.error && !overload.data ? (
            <QueryStatePanel error={overload.error} />
          ) : (
            <ProgressiveOverloadCards
              exercises={overload.data ?? []}
              loading={overload.isLoading}
            />
          )}
        </Section>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-sm font-medium text-muted uppercase tracking-wider">{title}</h2>
      </div>
      <div className="card p-4">{children}</div>
    </section>
  );
}
