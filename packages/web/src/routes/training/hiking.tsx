import { createFileRoute } from "@tanstack/react-router";
import { ActivityComparisonChart } from "../../components/ActivityComparisonChart.tsx";
import { ChartDescriptionTooltip } from "../../components/ChartDescriptionTooltip.tsx";
import { ElevationGainChart } from "../../components/ElevationGainChart.tsx";
import { GradeAdjustedPaceTable } from "../../components/GradeAdjustedPaceTable.tsx";
import { QueryStatePanel } from "../../components/QueryStatePanel.tsx";
import { RecentActivitiesSection } from "../../components/RecentActivitiesSection.tsx";
import { WalkingBiomechanicsChart } from "../../components/WalkingBiomechanicsChart.tsx";
import { selectedRangeQueryInput } from "../../lib/timeRange.ts";
import { useTrainingDays } from "../../lib/trainingDaysContext.ts";
import { TRAINING_SLOW_QUERY_OPTIONS } from "../../lib/trainingQueryOptions.ts";
import { trpc } from "../../lib/trpc.ts";

export const Route = createFileRoute("/training/hiking")({
  component: HikingTab,
});

function shouldShowQueryError(query: { error: unknown; data: unknown }): boolean {
  if (!query.error) return false;
  if (Array.isArray(query.data)) return query.data.length === 0;
  return !query.data;
}

function HikingTab() {
  const { days } = useTrainingDays();

  const gradeAdjustedPace = trpc.hiking.gradeAdjustedPace.useQuery(
    selectedRangeQueryInput(days),
    TRAINING_SLOW_QUERY_OPTIONS,
  );
  const elevation = trpc.hiking.elevationProfile.useQuery(
    selectedRangeQueryInput(days),
    TRAINING_SLOW_QUERY_OPTIONS,
  );
  const biomechanics = trpc.hiking.walkingBiomechanics.useQuery(
    selectedRangeQueryInput(days),
    TRAINING_SLOW_QUERY_OPTIONS,
  );
  const routeComparison = trpc.hiking.activityComparison.useQuery(
    selectedRangeQueryInput(days),
    TRAINING_SLOW_QUERY_OPTIONS,
  );

  return (
    <>
      <Section
        title="Effort-adjusted pace for grade"
        subtitle="Pace adjusted for the effort of walking or hiking on slopes. Uses the Minetti slope-cost model."
      >
        {shouldShowQueryError(gradeAdjustedPace) ? (
          <QueryStatePanel error={gradeAdjustedPace.error} />
        ) : (
          <GradeAdjustedPaceTable
            data={gradeAdjustedPace.data ?? []}
            loading={gradeAdjustedPace.isLoading}
          />
        )}
      </Section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section
          title="Elevation Gain"
          subtitle="Weekly cumulative elevation from hiking and walking"
        >
          {shouldShowQueryError(elevation) ? (
            <QueryStatePanel error={elevation.error} />
          ) : (
            <ElevationGainChart data={elevation.data ?? []} loading={elevation.isLoading} />
          )}
        </Section>

        <Section title="Walking Biomechanics" subtitle="Step length, gait symmetry, double support">
          {shouldShowQueryError(biomechanics) ? (
            <QueryStatePanel error={biomechanics.error} />
          ) : (
            <WalkingBiomechanicsChart
              data={biomechanics.data ?? []}
              loading={biomechanics.isLoading}
            />
          )}
        </Section>
      </div>

      <Section title="Route Comparison" subtitle="Repeated routes compared over time">
        {shouldShowQueryError(routeComparison) ? (
          <QueryStatePanel error={routeComparison.error} />
        ) : (
          <ActivityComparisonChart
            data={routeComparison.data ?? []}
            loading={routeComparison.isLoading}
          />
        )}
      </Section>

      <Section title="Recent Hikes" subtitle="Recent hiking activities">
        <RecentActivitiesSection activityTypes={["hiking"]} />
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
