import { createFileRoute } from "@tanstack/react-router";
import { ChartDescriptionTooltip } from "../../components/ChartDescriptionTooltip.tsx";
import { ClimbingGradeProgressionChart } from "../../components/ClimbingGradeProgressionChart.tsx";
import { ClimbingSessionSummaryTable } from "../../components/ClimbingSessionSummaryTable.tsx";
import { ClimbingVolumeByGradeChart } from "../../components/ClimbingVolumeByGradeChart.tsx";
import { QueryStatePanel } from "../../components/QueryStatePanel.tsx";
import { RecentActivitiesSection } from "../../components/RecentActivitiesSection.tsx";
import { useTrainingDays } from "../../lib/trainingDaysContext.ts";
import { TRAINING_SLOW_QUERY_OPTIONS } from "../../lib/trainingQueryOptions.ts";
import { trpc } from "../../lib/trpc.ts";

export const Route = createFileRoute("/training/climbing")({
  component: ClimbingTab,
});

const CLIMBING_ACTIVITY_TYPES = ["climbing", "rock_climbing"] as const;

function climbingRangeInput(days: number | null): { days?: number } {
  return days === null ? {} : { days };
}

export function ClimbingTab() {
  const { days } = useTrainingDays();
  const rangeInput = climbingRangeInput(days);
  const gradeProgression = trpc.climbing.gradeProgression.useQuery(
    rangeInput,
    TRAINING_SLOW_QUERY_OPTIONS,
  );
  const volumeByGrade = trpc.climbing.volumeByGrade.useQuery(
    rangeInput,
    TRAINING_SLOW_QUERY_OPTIONS,
  );
  const sessionSummary = trpc.climbing.sessionSummary.useQuery(
    rangeInput,
    TRAINING_SLOW_QUERY_OPTIONS,
  );

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Grade Progression" subtitle="Best sent grade by session">
          {gradeProgression.error && !gradeProgression.data ? (
            <QueryStatePanel error={gradeProgression.error} />
          ) : (
            <ClimbingGradeProgressionChart
              data={gradeProgression.data ?? []}
              loading={gradeProgression.isLoading}
            />
          )}
        </Section>

        <Section title="Volume by Grade" subtitle="Attempts and sends grouped by grade">
          {volumeByGrade.error && !volumeByGrade.data ? (
            <QueryStatePanel error={volumeByGrade.error} />
          ) : (
            <ClimbingVolumeByGradeChart
              data={volumeByGrade.data ?? []}
              loading={volumeByGrade.isLoading}
            />
          )}
        </Section>
      </div>

      <Section title="Recent Climbing Sessions" subtitle="Recent sessions with hardest grades">
        {sessionSummary.error && !sessionSummary.data ? (
          <QueryStatePanel error={sessionSummary.error} />
        ) : (
          <ClimbingSessionSummaryTable
            data={sessionSummary.data ?? []}
            loading={sessionSummary.isLoading}
          />
        )}
      </Section>

      <Section title="Recent Climbing Activities" subtitle="Recent climbing activity records">
        <RecentActivitiesSection activityTypes={CLIMBING_ACTIVITY_TYPES} />
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
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-sm font-medium text-muted uppercase tracking-wider">{title}</h2>
        <ChartDescriptionTooltip description={subtitle} />
      </div>
      <p className="text-xs text-dim mb-4">{subtitle}</p>
      <div className="card p-4" title={subtitle}>
        {children}
      </div>
    </section>
  );
}
