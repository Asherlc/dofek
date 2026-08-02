import { formatActivityTypeLabel, STRENGTH_ACTIVITY_TYPES } from "@dofek/training/training";
import { createLazyFileRoute } from "@tanstack/react-router";
import { ChartDescriptionTooltip } from "../../components/ChartDescriptionTooltip.tsx";
import { EstimatedMaxChart } from "../../components/EstimatedMaxChart.tsx";
import { MuscleGroupVolumeChart } from "../../components/MuscleGroupVolumeChart.tsx";
import { ProgressiveOverloadCards } from "../../components/ProgressiveOverloadCards.tsx";
import { QueryStatePanel } from "../../components/QueryStatePanel.tsx";
import { RecentActivitiesSection } from "../../components/RecentActivitiesSection.tsx";
import { StrengthVolumeChart } from "../../components/StrengthVolumeChart.tsx";
import { selectedRangeQueryInput } from "../../lib/timeRange.ts";
import { useTrainingDays } from "../../lib/trainingDaysContext.ts";
import { TRAINING_SLOW_QUERY_OPTIONS } from "../../lib/trainingQueryOptions.ts";
import { trpc } from "../../lib/trpc.ts";

export const Route = createLazyFileRoute("/training/strength")({
  component: StrengthTab,
});

const strengthScopeLabel = new Intl.ListFormat("en", {
  style: "long",
  type: "conjunction",
}).format(
  STRENGTH_ACTIVITY_TYPES.map((activityType) =>
    formatActivityTypeLabel(activityType).toLowerCase(),
  ),
);
const STRENGTH_SCOPE_LABEL =
  strengthScopeLabel.charAt(0).toUpperCase() + strengthScopeLabel.slice(1);

function StrengthTab() {
  const { days } = useTrainingDays();
  const rangeLabel = strengthRangeLabel(days);
  const emptyMessage =
    days === null
      ? `No strength workouts across all recorded time. Included types: ${STRENGTH_SCOPE_LABEL.toLowerCase()}.`
      : `No strength workouts in the selected ${strengthFiniteRangeLabel(days)}. Included types: ${STRENGTH_SCOPE_LABEL.toLowerCase()}.`;

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
        <Section title="Strength Volume" subtitle="Weekly volume load over time">
          {strengthVolume.error && !strengthVolume.data ? (
            <QueryStatePanel error={strengthVolume.error} />
          ) : (
            <StrengthVolumeChart
              data={strengthVolume.data ?? []}
              loading={strengthVolume.isLoading}
            />
          )}
        </Section>

        <Section
          title="Estimated single-rep strength"
          subtitle="Estimated maximum weight for one repetition per exercise over time"
        >
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
        <Section title="Muscle Group Volume" subtitle="Volume distribution by muscle group">
          {muscleVolume.error && !muscleVolume.data ? (
            <QueryStatePanel error={muscleVolume.error} />
          ) : (
            <MuscleGroupVolumeChart
              data={muscleVolume.data ?? []}
              loading={muscleVolume.isLoading}
            />
          )}
        </Section>

        <Section title="Exercise Volume Trends" subtitle="Weekly volume direction by exercise">
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

      <Section title="Strength Workouts" subtitle={`${rangeLabel} · ${STRENGTH_SCOPE_LABEL}`}>
        <RecentActivitiesSection
          activityTypes={STRENGTH_ACTIVITY_TYPES}
          emptyMessage={emptyMessage}
        />
      </Section>
    </>
  );
}

function strengthRangeLabel(days: number | null): string {
  return days === null ? "All recorded time" : `Selected ${strengthFiniteRangeLabel(days)}`;
}

function strengthFiniteRangeLabel(days: number): string {
  return days === 365 ? "1-year range" : `${days}-day range`;
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
