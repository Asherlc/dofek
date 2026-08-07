import { createFileRoute } from "@tanstack/react-router";
import type { ClimbingSessionSummaryRow } from "dofek-server/types";
import type { Activity } from "../../components/ActivityList.tsx";
import type { ActivityTableColumn } from "../../components/ActivityTable.tsx";
import { ChartDescriptionTooltip } from "../../components/ChartDescriptionTooltip.tsx";
import {
  ClimbingAttemptLog,
  type ClimbingSessionSubmission,
} from "../../components/ClimbingAttemptLog.tsx";
import { ClimbingGradeProgressionChart } from "../../components/ClimbingGradeProgressionChart.tsx";
import { ClimbingVolumeByGradeChart } from "../../components/ClimbingVolumeByGradeChart.tsx";
import {
  FingerLoadingLog,
  type FingerLoadingSubmission,
} from "../../components/FingerLoadingLog.tsx";
import { QueryStatePanel } from "../../components/QueryStatePanel.tsx";
import { RecentActivitiesSection } from "../../components/RecentActivitiesSection.tsx";
import { captureException } from "../../lib/telemetry.ts";
import { useTrainingDays } from "../../lib/trainingDaysContext.ts";
import { TRAINING_SLOW_QUERY_OPTIONS } from "../../lib/trainingQueryOptions.ts";
import { trpc } from "../../lib/trpc.ts";

export const Route = createFileRoute("/training/climbing")({
  component: ClimbingTab,
});

const CLIMBING_ACTIVITY_TYPES = ["climbing"] as const;

function climbingRangeInput(days: number | null): { days?: number } {
  return days === null ? {} : { days };
}

function climbingSessionColumns(
  sessionSummaries: ClimbingSessionSummaryRow[],
): Array<ActivityTableColumn<Activity>> {
  const summariesByActivityId = new Map(
    sessionSummaries.map((summary) => [summary.activityId, summary]),
  );
  const summaryFor = (activity: Activity) => summariesByActivityId.get(activity.id);

  return [
    {
      key: "attempts",
      label: "Attempts",
      headerClassName: "pb-2 pr-4 whitespace-nowrap",
      cellClassName: "py-2 pr-4 text-muted tabular-nums whitespace-nowrap",
      renderCell: (activity) => summaryFor(activity)?.attempts ?? "—",
    },
    {
      key: "sends",
      label: "Sends",
      headerClassName: "pb-2 pr-4 whitespace-nowrap",
      cellClassName: "py-2 pr-4 text-muted tabular-nums whitespace-nowrap",
      renderCell: (activity) => summaryFor(activity)?.sends ?? "—",
    },
    {
      key: "best-boulder-grade",
      label: "Best Boulder Grade",
      headerClassName: "pb-2 pr-4 whitespace-nowrap",
      cellClassName: "py-2 pr-4 text-muted whitespace-nowrap",
      renderCell: (activity) => {
        const summary = summaryFor(activity);
        return summary ? (summary.hardestBoulderGrade ?? "None") : "—";
      },
    },
    {
      key: "best-route-grade",
      label: "Best Route Grade",
      headerClassName: "pb-2 whitespace-nowrap",
      cellClassName: "py-2 text-muted whitespace-nowrap",
      renderCell: (activity) => {
        const summary = summaryFor(activity);
        return summary ? (summary.hardestRouteGrade ?? "None") : "—";
      },
    },
  ];
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
  const fingerLoadingHistory = trpc.climbing.fingerLoadingHistory.useQuery({ days: 90 });
  const utils = trpc.useUtils();
  const fingerLoadingMutation = trpc.climbing.logFingerLoading.useMutation({
    meta: { errorReportedLocally: true },
    onError: (error) => captureException(error, { context: "climbing-finger-loading-log" }),
    onSuccess: async () => {
      await Promise.all([
        utils.climbing.fingerLoadingHistory.invalidate(),
        utils.climbing.sessionSummary.invalidate(),
        utils.activity.invalidate(),
      ]);
    },
  });
  const climbingSessionMutation = trpc.climbing.logClimbingSession.useMutation({
    meta: { errorReportedLocally: true },
    onError: (error) => captureException(error, { context: "climbing-attempt-log" }),
    onSuccess: async () => {
      await Promise.all([
        utils.climbing.invalidate(),
        utils.activity.invalidate(),
        utils.mobileDashboard.training.invalidate(),
      ]);
    },
  });

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

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Section
          title="Finger Loading"
          subtitle="Record edge, grip, bodyweight, external load, timing, and effort"
        >
          {fingerLoadingHistory.error && !fingerLoadingHistory.data ? (
            <QueryStatePanel error={fingerLoadingHistory.error} height={160} />
          ) : (
            <FingerLoadingLog
              errorMessage={fingerLoadingMutation.error?.message ?? null}
              latest={fingerLoadingHistory.data?.[0] ?? null}
              loading={fingerLoadingHistory.isLoading}
              onSubmit={(input: FingerLoadingSubmission) => fingerLoadingMutation.mutate(input)}
              submitting={fingerLoadingMutation.isPending}
            />
          )}
        </Section>
        <Section
          title="Climbing Attempts"
          subtitle="Record the wall, holds, and outcome of each attempt"
        >
          <ClimbingAttemptLog
            errorMessage={climbingSessionMutation.error?.message ?? null}
            onSubmit={(input: ClimbingSessionSubmission) => climbingSessionMutation.mutate(input)}
            submitting={climbingSessionMutation.isPending}
          />
        </Section>
      </div>

      <Section
        title="Recent Climbing Activities"
        subtitle="Recent climbing activities with attempts, sends, and hardest grades"
      >
        <div className="space-y-4">
          {sessionSummary.error ? (
            <QueryStatePanel error={sessionSummary.error} height={0} />
          ) : null}
          <RecentActivitiesSection
            activityTypes={CLIMBING_ACTIVITY_TYPES}
            additionalColumns={climbingSessionColumns(sessionSummary.data ?? [])}
            additionalDataLoading={sessionSummary.isLoading}
          />
        </div>
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
