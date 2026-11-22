import { formatDateYmdInTimeZone, shiftDateYmd } from "@dofek/format/format";
import { localTimeSourceSchema } from "@dofek/format/record-local-time";
import { isConnectionFailure } from "@dofek/format/user-facing-error";
import { useMemo, useState } from "react";
import { z } from "zod";
import {
  CorrelationCard,
  CorrelationCardSkeleton,
  type Insight,
} from "../components/CorrelationCard.tsx";
import { ChartRangeProvider } from "../components/DofekChart.tsx";
import { Hypnogram } from "../components/Hypnogram.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { PageSection } from "../components/PageSection.tsx";
import { ProcessingStatusWidget } from "../components/ProcessingStatusWidget.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { RecordedDailyMetrics } from "../components/RecordedDailyMetrics.tsx";
import { SleepChart } from "../components/SleepChart.tsx";
import { SleepDataSourcesTable } from "../components/SleepDataSourcesTable.tsx";
import { TimeRangeSelector } from "../components/TimeRangeSelector.tsx";
import { useProcessingStatus } from "../hooks/useProcessingStatus.ts";
import { useTimeRangePreference } from "../hooks/useTimeRangePreference.ts";
import { useTodayQueryDate } from "../hooks/useTodayQueryDate.ts";
import { minimumSelectedRangeQueryInput, selectedRangeQueryInput } from "../lib/timeRange.ts";
import { trpc } from "../lib/trpc.ts";
import { assertRows } from "../lib/utils.ts";

const sleepRowSchema = z.object({
  date: z.string().optional(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  timezone: z.string().nullable(),
  start_utc_offset_minutes: z.number().nullable(),
  end_utc_offset_minutes: z.number().nullable(),
  local_time_source: localTimeSourceSchema,
  duration_minutes: z.number().nullable(),
  deep_minutes: z.number().nullable(),
  rem_minutes: z.number().nullable(),
  light_minutes: z.number().nullable(),
  awake_minutes: z.number().nullable(),
  efficiency_pct: z.number().nullable(),
  provider_id: z.string().nullable().optional(),
  source_name: z.string().nullable().optional(),
  source_providers: z.array(z.string()).optional().default([]),
  selected_session_id: z.string().nullable().optional().default(null),
  overlapping_sessions: z
    .array(
      z.object({
        session_id: z.string(),
        provider_id: z.string(),
        source_name: z.string().nullable(),
        source_providers: z.array(z.string()),
        timezone: z.string().nullable(),
        start_utc_offset_minutes: z.number().nullable(),
        end_utc_offset_minutes: z.number().nullable(),
        local_time_source: localTimeSourceSchema,
        started_at: z.string(),
        ended_at: z.string().nullable(),
        duration_minutes: z.number().nullable(),
      }),
    )
    .optional()
    .default([]),
  staging_available: z.boolean(),
});

function isSleepInsight(metric: string): boolean {
  return /sleep|deep|rem|efficiency/i.test(metric);
}

export function SleepPage() {
  const { days, setDays } = useTimeRangePreference("sleep");
  const endDate = useTodayQueryDate();
  const [selectedDate, setSelectedDate] = useState<string>();

  const sleepData = trpc.sleep.list.useQuery({ ...selectedRangeQueryInput(days), endDate });
  const stagesByDate = trpc.sleep.stagesByDate.useQuery(
    selectedDate ? { date: selectedDate } : undefined,
  );
  const recorded = trpc.dailyMetrics.recorded.useQuery({
    ...selectedRangeQueryInput(days),
    endDate,
    group: "sleep",
  });
  const insightsQuery = trpc.insights.compute.useQuery({
    ...minimumSelectedRangeQueryInput(days, 90),
    endDate,
  });
  const processingStatus = useProcessingStatus({ datasets: ["sleep"] });

  const sleepInsights = useMemo(() => {
    const all: Insight[] = insightsQuery.data ?? [];
    return all
      .filter((i) => i.confidence !== "insufficient" && isSleepInsight(i.metric))
      .sort((a, b) => Math.abs(b.effectSize) - Math.abs(a.effectSize));
  }, [insightsQuery.data]);

  const sleepRows = assertRows(sleepData.data, sleepRowSchema);
  const displayDate = selectedDate ?? stagesByDate.data?.date ?? endDate;
  const selectedStages =
    selectedDate === undefined || stagesByDate.data?.date === selectedDate
      ? stagesByDate.data?.stages
      : undefined;
  // Night stages, the trend, insights, and processing status can all fail from
  // the same offline condition. Group only visible failures so one notice is
  // shown and every matching copy is suppressed.
  const connectionFailures = [
    stagesByDate,
    sleepData,
    recorded,
    insightsQuery,
    processingStatus,
  ].filter((query) => query.error != null && isConnectionFailure(query.error));
  const sharedConnectionFailure = connectionFailures.length > 1;
  const isSharedConnectionFailure = (error: unknown) =>
    sharedConnectionFailure && isConnectionFailure(error);
  // A grouped offline failure on the list query leaves no rows to chart or
  // attribute. Omit only those empty views while keeping the range controls,
  // the grouped notice, and any cached nonempty list data. A cached empty
  // payload is still empty here.
  const omitEmptySleepList = isSharedConnectionFailure(sleepData.error) && sleepRows.length === 0;
  const sourceRows = useMemo(
    () =>
      sleepRows.map((row) => ({
        date: row.date ?? formatDateYmdInTimeZone(row.started_at, "UTC"),
        durationMinutes: row.duration_minutes,
        providerId: row.provider_id ?? null,
        sourceName: row.source_name ?? null,
        sourceProviders: row.source_providers ?? [],
        selectedSessionId: row.selected_session_id,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        localTimeContext: {
          timezone: row.timezone,
          startUtcOffsetMinutes: row.start_utc_offset_minutes,
          endUtcOffsetMinutes: row.end_utc_offset_minutes,
          source: row.local_time_source,
        },
        overlappingSessions: row.overlapping_sessions.map((session) => ({
          sessionId: session.session_id,
          providerId: session.provider_id,
          sourceName: session.source_name,
          sourceProviders: session.source_providers,
          localTimeContext: {
            timezone: session.timezone,
            startUtcOffsetMinutes: session.start_utc_offset_minutes,
            endUtcOffsetMinutes: session.end_utc_offset_minutes,
            source: session.local_time_source,
          },
          startedAt: session.started_at,
          endedAt: session.ended_at,
          durationMinutes: session.duration_minutes,
        })),
        stagingAvailable: row.staging_available,
      })),
    [sleepRows],
  );

  return (
    <ChartRangeProvider days={days}>
      <PageLayout title="Sleep" subtitle="Sleep stages and patterns over time">
        {sharedConnectionFailure ? (
          <QueryStatePanel error={connectionFailures[0]?.error} height={72} />
        ) : null}
        <ProcessingStatusWidget
          data={processingStatus.data}
          error={
            isSharedConnectionFailure(processingStatus.error) ? undefined : processingStatus.error
          }
          loading={processingStatus.isLoading}
        />

        <RecordedDailyMetrics rows={recorded.data} />
        {recorded.isError && !recorded.data && !isSharedConnectionFailure(recorded.error) && (
          <QueryStatePanel error={recorded.error} height={72} />
        )}

        <PageSection title="Night’s Stages">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-label="Previous day"
              className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-foreground hover:bg-surface-secondary"
              onClick={() => {
                const previousDate = shiftDateYmd(displayDate, -1);
                if (previousDate <= endDate) setSelectedDate(previousDate);
              }}
            >
              Previous
            </button>
            <label className="flex items-center gap-2 text-sm">
              Night date
              <input
                aria-label="Night date"
                type="date"
                value={displayDate}
                max={endDate}
                onChange={(event) => {
                  const date = event.currentTarget.value;
                  if (date && date <= endDate) setSelectedDate(date);
                }}
                className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-foreground"
              />
            </label>
            <button
              type="button"
              aria-label="Next day"
              className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-foreground hover:bg-surface-secondary disabled:cursor-not-allowed disabled:opacity-50"
              disabled={displayDate >= endDate}
              onClick={() => {
                const nextDate = shiftDateYmd(displayDate, 1);
                if (nextDate <= endDate) setSelectedDate(nextDate);
              }}
            >
              Next
            </button>
          </div>
          {stagesByDate.isError &&
            !selectedStages &&
            !isSharedConnectionFailure(stagesByDate.error) && (
              <QueryStatePanel error={stagesByDate.error} height={72} />
            )}
          {stagesByDate.isError &&
            selectedStages &&
            !isSharedConnectionFailure(stagesByDate.error) && (
              <p role="status" className="mb-2 text-sm text-warning">
                Refresh failed: {stagesByDate.error.message}
              </p>
            )}
          {selectedStages ? (
            <Hypnogram data={selectedStages} loading={false} />
          ) : stagesByDate.isLoading ? (
            <p role="status" className="py-4 text-sm text-muted">
              Loading sleep stages...
            </p>
          ) : null}
        </PageSection>

        {/* Trend range grouped with the trend chart, below the independently browsed night. */}
        <PageSection title="Sleep Stages">
          <div className="mb-3 flex justify-end">
            <TimeRangeSelector days={days} onChange={setDays} />
          </div>
          {sleepData.isError && !sleepData.data && !isSharedConnectionFailure(sleepData.error) && (
            <QueryStatePanel error={sleepData.error} height={72} />
          )}
          {!omitEmptySleepList && <SleepChart data={sleepRows} loading={sleepData.isLoading} />}
        </PageSection>

        {/* Data Sources */}
        {!omitEmptySleepList && (
          <PageSection
            id="sleep-data-sources"
            title="Data Sources"
            subtitle="See which sleep record is used for each night and compare overlapping records"
          >
            <SleepDataSourcesTable
              key={days ?? "all"}
              rows={sourceRows}
              loading={sleepData.isLoading}
            />
          </PageSection>
        )}

        {/* Sleep Insights */}
        {insightsQuery.isError &&
          !insightsQuery.data &&
          !isSharedConnectionFailure(insightsQuery.error) && (
            <PageSection title="Sleep Insights" card={false}>
              <QueryStatePanel error={insightsQuery.error} height={72} />
            </PageSection>
          )}

        {insightsQuery.isLoading && (
          <PageSection title="Sleep Insights" card={false}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {["s1", "s2"].map((id) => (
                <CorrelationCardSkeleton key={id} />
              ))}
            </div>
          </PageSection>
        )}

        {!insightsQuery.isLoading && sleepInsights.length > 0 && (
          <PageSection title="Sleep Insights" card={false}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {sleepInsights.map((insight) => (
                <CorrelationCard key={insight.id} insight={insight} />
              ))}
            </div>
          </PageSection>
        )}
      </PageLayout>
    </ChartRangeProvider>
  );
}
