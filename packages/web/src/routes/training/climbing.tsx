import type { ClimbingFilters as Filters } from "@dofek/training/climbing-filters";
import { keepPreviousData } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ClimbingFilters } from "../../components/ClimbingFilters.tsx";
import { ClimbingGradeProgressionChart } from "../../components/ClimbingGradeProgressionChart.tsx";
import { ClimbingLocationMap } from "../../components/ClimbingLocationMap.tsx";
import { ClimbingStrengths } from "../../components/ClimbingStrengths.tsx";
import { ClimbingVolumeByGradeChart } from "../../components/ClimbingVolumeByGradeChart.tsx";
import { ClimbingVolumeOverTimeChart } from "../../components/ClimbingVolumeOverTimeChart.tsx";
import { HangboardingSummary } from "../../components/HangboardingSummary.tsx";
import { QueryStatePanel } from "../../components/QueryStatePanel.tsx";
import { useTodayQueryDate } from "../../hooks/useTodayQueryDate.ts";
import { useTrainingDays } from "../../lib/trainingDaysContext.ts";
import { TRAINING_SLOW_QUERY_OPTIONS } from "../../lib/trainingQueryOptions.ts";
import { trpc } from "../../lib/trpc.ts";

export const Route = createFileRoute("/training/climbing")({
  component: ClimbingTab,
});

function climbingRangeInput(days: number | null): { days?: number } {
  return days === null ? {} : { days };
}

export function ClimbingTab() {
  const { days } = useTrainingDays();
  const endDate = useTodayQueryDate();
  const [filters, setFilters] = useState<Filters>({});
  const [includeAreaMetadata, setIncludeAreaMetadata] = useState(true);
  const rangeInput = { ...climbingRangeInput(days), ...filters };
  const climbingQueryOptions = {
    ...TRAINING_SLOW_QUERY_OPTIONS,
    placeholderData: keepPreviousData,
  };
  const gradeProgression = trpc.climbing.gradeProgressionV2.useQuery(
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
    { ...rangeInput, days, endDate, responseVersion: 2, includeAreaMetadata },
    {
      ...climbingQueryOptions,
      refetchInterval: (query) => (query.state.data?.enrichmentPending ? 1500 : false),
    },
  );
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
            <ClimbingStrengths
              data={strengths.data}
              loading={strengths.isLoading}
              includeAreaMetadata={includeAreaMetadata}
              onIncludeAreaMetadataChange={setIncludeAreaMetadata}
            />
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
          {gradeProgression.error && gradeProgression.data === undefined ? null : (
            <ClimbingGradeProgressionChart
              data={gradeProgression.data ?? null}
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
