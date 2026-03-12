import { createFileRoute } from "@tanstack/react-router";
import { ActivityComparisonChart } from "../../components/ActivityComparisonChart.tsx";
import { ElevationGainChart } from "../../components/ElevationGainChart.tsx";
import { GradeAdjustedPaceTable } from "../../components/GradeAdjustedPaceTable.tsx";
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
          data={(gradeAdjustedPace.data ?? []) as never[]}
          loading={gradeAdjustedPace.isLoading}
        />
      </Section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section
          title="Elevation Gain"
          subtitle="Weekly cumulative elevation from hiking and walking"
        >
          <ElevationGainChart
            data={(elevation.data ?? []) as never[]}
            loading={elevation.isLoading}
          />
        </Section>

        <Section title="Walking Biomechanics" subtitle="Step length, gait symmetry, double support">
          <WalkingBiomechanicsChart
            data={(biomechanics.data ?? []) as never[]}
            loading={biomechanics.isLoading}
          />
        </Section>
      </div>

      <Section title="Route Comparison" subtitle="Repeated routes compared over time">
        <ActivityComparisonChart
          data={(routeComparison.data ?? []) as never[]}
          loading={routeComparison.isLoading}
        />
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
  return (
    <section>
      <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-1">{title}</h2>
      {subtitle && <p className="text-xs text-zinc-600 mb-4">{subtitle}</p>}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">{children}</div>
    </section>
  );
}
