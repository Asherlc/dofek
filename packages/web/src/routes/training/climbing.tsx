import {
  type ClimbingFilters,
  climbingFilterOptions,
  climbingFiltersSchema,
} from "@dofek/training/climbing-filters";
import { keepPreviousData } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { ClimbingSessionSummaryRow } from "dofek-server/types";
import { useId, useState } from "react";
import type { Activity } from "../../components/ActivityList.tsx";
import type { ActivityTableColumn } from "../../components/ActivityTable.tsx";
import { ClimbingGradeProgressionChart } from "../../components/ClimbingGradeProgressionChart.tsx";
import { ClimbingVolumeByGradeChart } from "../../components/ClimbingVolumeByGradeChart.tsx";
import { HangboardingSummary } from "../../components/HangboardingSummary.tsx";
import { QueryStatePanel } from "../../components/QueryStatePanel.tsx";
import { RecentActivitiesSection } from "../../components/RecentActivitiesSection.tsx";
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
  const [filters, setFilters] = useState<ClimbingFilters>({});
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersId = useId();
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
  const sessionSummary = trpc.climbing.sessionSummary.useQuery(rangeInput, climbingQueryOptions);
  const hangboardingSummary = trpc.climbing.hangboardingSummary.useQuery(
    climbingRangeInput(days),
    TRAINING_SLOW_QUERY_OPTIONS,
  );

  return (
    <>
      <div className="mb-6 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded-lg border border-border px-3 py-2 text-sm"
            aria-expanded={filtersOpen}
            aria-controls={filtersId}
            onClick={() => setFiltersOpen(!filtersOpen)}
          >
            {Object.keys(filters).length ? "Filter climbing" : "All climbing"}{" "}
            <span aria-hidden="true">▾</span>
          </button>
          {(["style", "protection", "setting"] as const).map((key) => {
            const label = climbingFilterOptions[key].find(([value]) => value === filters[key])?.[1];
            return label ? (
              <button
                key={key}
                type="button"
                aria-label={`Remove ${label} filter`}
                className="rounded-full bg-surface-hover px-3 py-1 text-xs"
                onClick={() =>
                  setFilters((current) => {
                    const next = { ...current };
                    delete next[key];
                    return next;
                  })
                }
              >
                {label} <span aria-hidden="true">×</span>
              </button>
            ) : null;
          })}
        </div>
        {filtersOpen ? (
          <div id={filtersId} className="flex flex-wrap gap-4 rounded-lg border border-border p-3">
            {(["style", "protection", "setting"] as const).map((key) => (
              <label key={key} className="flex flex-col gap-1 text-xs text-muted">
                {key === "style" ? "Style" : key === "protection" ? "Protection" : "Setting"}
                <select
                  className="rounded border border-border bg-surface px-2 py-2 text-sm"
                  value={filters[key] ?? ""}
                  onChange={(event) =>
                    setFilters((current) => {
                      const next = { ...current };
                      delete next[key];
                      return climbingFiltersSchema.parse(
                        event.target.value ? { ...next, [key]: event.target.value } : next,
                      );
                    })
                  }
                >
                  <option value="">All</option>
                  {climbingFilterOptions[key].map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        ) : null}
      </div>
      {gradeProgression.isFetching || volumeByGrade.isFetching || sessionSummary.isFetching ? (
        <p role="status" className="mb-3 text-xs text-muted">
          Updating climbing…
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-6">
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
