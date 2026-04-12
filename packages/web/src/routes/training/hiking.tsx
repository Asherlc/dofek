import { createFileRoute } from "@tanstack/react-router";
import { ActivityComparisonChart } from "../../components/ActivityComparisonChart.tsx";
import { ChartDescriptionTooltip } from "../../components/ChartDescriptionTooltip.tsx";
import { ElevationGainChart } from "../../components/ElevationGainChart.tsx";
import { GradeAdjustedPaceTable } from "../../components/GradeAdjustedPaceTable.tsx";
import { RecentActivitiesSection } from "../../components/RecentActivitiesSection.tsx";
import { WalkingBiomechanicsChart } from "../../components/WalkingBiomechanicsChart.tsx";
import { useTrainingDays } from "../../lib/trainingDaysContext.ts";
import { trpc } from "../../lib/trpc.ts";

export const Route = createFileRoute("/training/hiking")({
  component: HikingTab,
});

function HikingTab() {
  const { days } = useTrainingDays();

  const gradeAdjustedPace = trpc.hiking.gradeAdjustedPace.useQuery({ days });
  const elevation = trpc.hiking.elevationProfile.useQuery({ days: Math.max(days, 365) });
  const biomechanics = trpc.hiking.walkingBiomechanics.useQuery({ days });
  const routeComparison = trpc.hiking.activityComparison.useQuery({ days: Math.max(days, 365) });

  return (
    <>
      <Section
        title="Grade-Adjusted Pace"
        subtitle="Minetti-model normalized pace for walks and hikes"
      >
        <GradeAdjustedPaceTable
          data={gradeAdjustedPace.data ?? []}
          loading={gradeAdjustedPace.isLoading}
          error={gradeAdjustedPace.isError}
        />
      </Section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section
          title="Elevation Gain"
          subtitle="Weekly cumulative elevation from hiking and walking"
        >
          <ElevationGainChart
            data={elevation.data ?? []}
            loading={elevation.isLoading}
            error={elevation.isError}
          />
        </Section>

        <Section title="Walking Biomechanics" subtitle="Step length, gait symmetry, double support">
          <WalkingBiomechanicsChart
            data={biomechanics.data ?? []}
            loading={biomechanics.isLoading}
            error={biomechanics.isError}
          />
        </Section>
      </div>

      <Section title="Route Comparison" subtitle="Repeated routes compared over time">
        <ActivityComparisonChart
          data={routeComparison.data ?? []}
          loading={routeComparison.isLoading}
          error={routeComparison.isError}
        />
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
