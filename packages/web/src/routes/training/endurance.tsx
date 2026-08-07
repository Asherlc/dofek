import { ENDURANCE_ACTIVITY_TYPES } from "@dofek/training/endurance-types";
import { TRAINING_TERMINOLOGY } from "@dofek/training/terminology";
import { createFileRoute } from "@tanstack/react-router";
import { ChartDescriptionTooltip } from "../../components/ChartDescriptionTooltip.tsx";
import { PolarizationTrendChart } from "../../components/PolarizationTrendChart.tsx";
import { QueryStatePanel } from "../../components/QueryStatePanel.tsx";
import { RampRateChart } from "../../components/RampRateChart.tsx";
import { RecentActivitiesSection } from "../../components/RecentActivitiesSection.tsx";
import { TrainingMonotonyChart } from "../../components/TrainingMonotonyChart.tsx";
import { selectedRangeQueryInput } from "../../lib/timeRange.ts";
import { useTrainingDays } from "../../lib/trainingDaysContext.ts";
import { TRAINING_SLOW_QUERY_OPTIONS } from "../../lib/trainingQueryOptions.ts";
import { trpc } from "../../lib/trpc.ts";

export const Route = createFileRoute("/training/endurance")({
  component: EnduranceTab,
});

function EnduranceTab() {
  const { days } = useTrainingDays();

  const polarization = trpc.efficiency.polarizationTrend.useQuery(
    selectedRangeQueryInput(days),
    TRAINING_SLOW_QUERY_OPTIONS,
  );
  const rampRate = trpc.cyclingAdvanced.rampRate.useQuery(selectedRangeQueryInput(days));
  const monotony = trpc.cyclingAdvanced.trainingMonotony.useQuery(selectedRangeQueryInput(days));

  return (
    <>
      <Section
        title={TRAINING_TERMINOLOGY.polarization.plainLabel}
        subtitle="Weekly balance of easy, threshold, and high-intensity cycling"
      >
        {polarization.error ? (
          <QueryStatePanel error={polarization.error} />
        ) : (
          <PolarizationTrendChart
            weeks={polarization.data?.weeks ?? []}
            maxHr={polarization.data?.maxHr ?? null}
            threshold={polarization.data?.threshold}
            method={polarization.data?.method ?? null}
            loading={polarization.isLoading}
          />
        )}
      </Section>

      <Section
        title="Ramp Rate"
        subtitle="How quickly your fitness load is building week over week"
      >
        {rampRate.error ? (
          <QueryStatePanel error={rampRate.error} />
        ) : (
          <RampRateChart
            data={rampRate.data?.weeks ?? []}
            currentRampRate={rampRate.data?.currentRampRate ?? 0}
            recommendation={rampRate.data?.recommendation ?? ""}
            loading={rampRate.isLoading}
          />
        )}
      </Section>

      <Section
        title={TRAINING_TERMINOLOGY.monotony.plainLabel}
        subtitle="Weekly training variety and total load"
      >
        {monotony.error ? (
          <QueryStatePanel error={monotony.error} />
        ) : (
          <TrainingMonotonyChart data={monotony.data ?? []} loading={monotony.isLoading} />
        )}
      </Section>

      <Section title="Recent Endurance Activities" subtitle="Recent cardio and endurance workouts">
        <RecentActivitiesSection activityTypes={ENDURANCE_ACTIVITY_TYPES} />
      </Section>
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
