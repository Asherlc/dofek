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

function QueryError({ error }: { error: unknown }) {
  return error ? <QueryStatePanel error={error} /> : null;
}

export function ClimbingTab() {
  const { days } = useTrainingDays();
  const gradeProgression = trpc.climbing.gradeProgression.useQuery(
    { days },
    TRAINING_SLOW_QUERY_OPTIONS,
  );
  const volumeByGrade = trpc.climbing.volumeByGrade.useQuery({ days }, TRAINING_SLOW_QUERY_OPTIONS);
  const sessionSummary = trpc.climbing.sessionSummary.useQuery(
    { days },
    TRAINING_SLOW_QUERY_OPTIONS,
  );

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Grade Progression" subtitle="Best sent grade by session">
          {gradeProgression.error && <QueryError error={gradeProgression.error} />}
          {(!gradeProgression.error || gradeProgression.data) && (
            <ClimbingGradeProgressionChart
              data={gradeProgression.data ?? []}
              loading={gradeProgression.isLoading}
            />
          )}
        </Section>

        <Section title="Volume by Grade" subtitle="Attempts and sends grouped by grade">
          {volumeByGrade.error && <QueryError error={volumeByGrade.error} />}
          {(!volumeByGrade.error || volumeByGrade.data) && (
            <ClimbingVolumeByGradeChart
              data={volumeByGrade.data ?? []}
              loading={volumeByGrade.isLoading}
            />
          )}
        </Section>
      </div>

      <Section title="Recent Climbing Sessions" subtitle="Recent sessions with hardest grades">
        {sessionSummary.error && <QueryError error={sessionSummary.error} />}
        {(!sessionSummary.error || sessionSummary.data) && (
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
