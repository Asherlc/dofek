import type { ClimbingFilters as Filters } from "@dofek/training/climbing-filters";
import { keepPreviousData } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { ClimbingSessionSummaryRow } from "dofek-server/types";
import { useState } from "react";
import type { Activity } from "../../components/ActivityList.tsx";
import type { ActivityTableColumn } from "../../components/ActivityTable.tsx";
import { ClimbingFilters } from "../../components/ClimbingFilters.tsx";
import { ClimbingGradeProgressionChart } from "../../components/ClimbingGradeProgressionChart.tsx";
import { ClimbingLocationMap } from "../../components/ClimbingLocationMap.tsx";
import { ClimbingStrengths } from "../../components/ClimbingStrengths.tsx";
import { ClimbingVolumeByGradeChart } from "../../components/ClimbingVolumeByGradeChart.tsx";
import { ClimbingVolumeOverTimeChart } from "../../components/ClimbingVolumeOverTimeChart.tsx";
import { HangboardingSummary } from "../../components/HangboardingSummary.tsx";
import { QueryStatePanel } from "../../components/QueryStatePanel.tsx";
import { RecentActivitiesSection } from "../../components/RecentActivitiesSection.tsx";
import { useTodayQueryDate } from "../../hooks/useTodayQueryDate.ts";
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
  const endDate = useTodayQueryDate();
  const [filters, setFilters] = useState<Filters>({});
  const rangeInput = { ...climbingRangeInput(days), ...filters };
  const climbingQueryOptions = {
    ...TRAINING_SLOW_QUERY_OPTIONS,
    placeholderData: keepPreviousData,
  };
  const gradeProgression = trpc.climbing.gradeProgression.useQuery(
    rangeInput,
    climbingQueryOptions,
  );
  const volumeByGrade = trpc.climbing.volumeByGrade.useQuery(rangeInput, climbingQueryOptions);
  const volumeOverTime = trpc.climbing.volumeOverTime.useQuery(
    { ...rangeInput, days },
    climbingQueryOptions,
  );
  const locationMap = trpc.climbing.locationMap.useQuery(rangeInput, climbingQueryOptions);
  const strengths = trpc.climbing.strengths.useQuery(
    { ...rangeInput, days, endDate },
    climbingQueryOptions,
  );
  const sessionSummary = trpc.climbing.sessionSummary.useQuery(rangeInput, climbingQueryOptions);
  const hangboardingSummary = trpc.climbing.hangboardingSummary.useQuery(
    climbingRangeInput(days),
    TRAINING_SLOW_QUERY_OPTIONS,
  );

  return (
    <>
      <div className="mb-6">
        <ClimbingFilters value={filters} onChange={setFilters} />
      </div>
      {gradeProgression.isFetching ||
      volumeByGrade.isFetching ||
      volumeOverTime.isFetching ||
      sessionSummary.isFetching ||
      strengths.isFetching ||
      locationMap.isFetching ? (
        <p role="status" className="mb-3 text-xs text-muted">
          Updating climbing…
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-6">
        <Section title="Climbing Volume">
          {volumeOverTime.error ? (
            <QueryStatePanel error={volumeOverTime.error} height={0} />
          ) : null}
          {volumeOverTime.error && !volumeOverTime.data ? null : (
            <ClimbingVolumeOverTimeChart
              data={volumeOverTime.data ?? []}
              loading={volumeOverTime.isLoading}
            />
          )}
        </Section>
        <Section title="Climbing Strengths">
          {strengths.error ? <QueryStatePanel error={strengths.error} height={0} /> : null}
          {strengths.error && !strengths.data ? null : (
            <ClimbingStrengths data={strengths.data} loading={strengths.isLoading} />
          )}
        </Section>
        <Section title="Climbing Locations">
          {locationMap.error ? <QueryStatePanel error={locationMap.error} height={0} /> : null}
          {locationMap.error && !locationMap.data ? null : (
            <ClimbingLocationMap data={locationMap.data} loading={locationMap.isLoading} />
          )}
        </Section>

        <Section title="Grade Progression">
          {gradeProgression.error ? (
            <QueryStatePanel error={gradeProgression.error} height={0} />
          ) : null}
          {gradeProgression.error && !gradeProgression.data ? null : (
            <ClimbingGradeProgressionChart
              data={gradeProgression.data ?? []}
              loading={gradeProgression.isLoading}
            />
          )}
        </Section>

        <Section title="Volume by Grade">
          {volumeByGrade.error ? <QueryStatePanel error={volumeByGrade.error} height={0} /> : null}
          {volumeByGrade.error && !volumeByGrade.data ? null : (
            <ClimbingVolumeByGradeChart
              data={volumeByGrade.data ?? []}
              loading={volumeByGrade.isLoading}
            />
          )}
        </Section>
      </div>

      <Section title="Recent Climbing Activities">
        <div className="space-y-4">
          {sessionSummary.error ? (
            <QueryStatePanel error={sessionSummary.error} height={0} />
          ) : null}
          {Object.keys(filters).length ? (
            sessionSummary.isLoading && !sessionSummary.data ? (
              <QueryStatePanel variant="loading" />
            ) : sessionSummary.error && !sessionSummary.data ? null : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr>
                      {[
                        "Activity",
                        "Attempts",
                        "Sends",
                        "Best Boulder Grade",
                        "Best Route Grade",
                      ].map((label) => (
                        <th key={label} className="pb-2 pr-4 text-muted font-medium">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sessionSummary.data?.map((session) => (
                      <tr key={session.activityId}>
                        <td className="py-2 pr-4">
                          <a
                            className="text-accent hover:underline"
                            href={`/activity/${session.activityId}`}
                          >
                            {session.name}
                          </a>
                          <div className="text-xs text-dim">{session.date}</div>
                        </td>
                        <td className="py-2 pr-4">{session.attempts ?? "—"}</td>
                        <td className="py-2 pr-4">{session.sends}</td>
                        <td className="py-2 pr-4">{session.hardestBoulderGrade ?? "None"}</td>
                        <td className="py-2">{session.hardestRouteGrade ?? "None"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {sessionSummary.data?.length === 0 ? (
                  <p className="py-4 text-sm text-muted">
                    No climbing activities match these filters.
                  </p>
                ) : null}
              </div>
            )
          ) : (
            <RecentActivitiesSection
              activityTypes={CLIMBING_ACTIVITY_TYPES}
              showDistance={false}
              additionalColumns={climbingSessionColumns(sessionSummary.data ?? [])}
              additionalDataLoading={sessionSummary.isLoading}
            />
          )}
        </div>
      </Section>

      <Section title="Hangboarding">
        {hangboardingSummary.error && !hangboardingSummary.data ? (
          <QueryStatePanel error={hangboardingSummary.error} />
        ) : (
          <HangboardingSummary
            data={hangboardingSummary.data}
            loading={hangboardingSummary.isLoading}
          />
        )}
        {hangboardingSummary.error && hangboardingSummary.data ? (
          <QueryStatePanel error={hangboardingSummary.error} height={72} />
        ) : null}
      </Section>
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
