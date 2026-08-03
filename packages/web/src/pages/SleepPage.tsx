import { formatDateYmdInTimeZone } from "@dofek/format/format";
import { localTimeSourceSchema } from "@dofek/format/record-local-time";
import { useMemo } from "react";
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
import { SleepChart } from "../components/SleepChart.tsx";
import { SleepDataSourcesTable } from "../components/SleepDataSourcesTable.tsx";
import { SleepOverviewCards } from "../components/SleepOverviewCards.tsx";
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
  const { days, description, setDays } = useTimeRangePreference("sleep");
  const endDate = useTodayQueryDate();

  const sleepData = trpc.sleep.list.useQuery({ ...selectedRangeQueryInput(days), endDate });
  const latestStages = trpc.sleep.latestStages.useQuery();
  const sleepNeed = trpc.sleepNeed.calculateV2.useQuery({ endDate });
  const sleepPerformance = trpc.sleepNeed.performance.useQuery({ endDate });
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
      <PageLayout
        headerChildren={
          <TimeRangeSelector days={days} description={description} onChange={setDays} />
        }
        title="Sleep"
        subtitle="Sleep stages, debt, and patterns over time"
      >
        <ProcessingStatusWidget
          data={processingStatus.data}
          error={processingStatus.error}
          loading={processingStatus.isLoading}
        />
        {/* Sleep Performance Score + Bedtime Recommendation */}
        {((sleepPerformance.isError && !sleepPerformance.data) ||
          (sleepNeed.isError && !sleepNeed.data)) && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {sleepPerformance.isError && !sleepPerformance.data && (
              <QueryStatePanel error={sleepPerformance.error} height={72} />
            )}
            {sleepNeed.isError && !sleepNeed.data && (
              <QueryStatePanel error={sleepNeed.error} height={72} />
            )}
          </div>
        )}
        <SleepOverviewCards
          sleepNeed={sleepNeed.data}
          sleepNeedLoading={sleepNeed.isLoading}
          sleepPerformance={sleepPerformance.data}
          sleepPerformanceLoading={sleepPerformance.isLoading}
        />

        {/* Sleep Stage Chart */}
        <PageSection title="Sleep Stages">
          {sleepData.isError && !sleepData.data && (
            <QueryStatePanel error={sleepData.error} height={72} />
          )}
          <SleepChart data={sleepRows} loading={sleepData.isLoading} />
        </PageSection>

        {/* Data Sources */}
        <PageSection
          title="Data Sources"
          subtitle="Which canonical session was selected and which overlapping sessions disagreed"
        >
          <SleepDataSourcesTable
            key={days ?? "all"}
            rows={sourceRows}
            loading={sleepData.isLoading}
          />
        </PageSection>

        {/* Last Night Hypnogram */}
        <PageSection title="Last Night">
          {latestStages.isError && !latestStages.data && (
            <QueryStatePanel error={latestStages.error} height={72} />
          )}
          <Hypnogram data={latestStages.data ?? []} loading={latestStages.isLoading} />
        </PageSection>

        {/* Sleep Insights */}
        {insightsQuery.isError && !insightsQuery.data && (
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
