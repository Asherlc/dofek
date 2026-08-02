import { formatDateYmd } from "@dofek/format/format";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { ChartDescriptionTooltip } from "../../components/ChartDescriptionTooltip.tsx";
import {
  CorrelationCard,
  CorrelationCardSkeleton,
  type Insight,
} from "../../components/CorrelationCard.tsx";
import { ChartLoadingSkeleton } from "../../components/LoadingSkeleton.tsx";
import { PageSection } from "../../components/PageSection.tsx";
import { PmcChart } from "../../components/PmcChart.tsx";
import { QueryStatePanel } from "../../components/QueryStatePanel.tsx";
import { RecentActivitiesSection } from "../../components/RecentActivitiesSection.tsx";
import { TrainingCalendar } from "../../components/TrainingCalendar.tsx";
import { TrainingInsightsPanel } from "../../components/TrainingInsightsPanel.tsx";
import { minimumSelectedRangeQueryInput, selectedRangeQueryInput } from "../../lib/timeRange.ts";
import { useTrainingDays } from "../../lib/trainingDaysContext.ts";
import { filterTrainingInsights } from "../../lib/trainingInsights.ts";
import { TRAINING_OVERVIEW_QUERY_OPTIONS } from "../../lib/trainingQueryOptions.ts";
import { trpc } from "../../lib/trpc.ts";

export const Route = createFileRoute("/training/")({
  component: TrainingOverview,
});

export function TrainingOverview() {
  const { days } = useTrainingDays();
  const endDate = useMemo(() => formatDateYmd(new Date()), []);

  const pmcData = trpc.pmc.chart.useQuery(
    selectedRangeQueryInput(days),
    TRAINING_OVERVIEW_QUERY_OPTIONS,
  );
  const calendarData = trpc.calendar.calendarData.useQuery(
    selectedRangeQueryInput(days),
    TRAINING_OVERVIEW_QUERY_OPTIONS,
  );
  const insightsQuery = trpc.insights.compute.useQuery(
    { ...minimumSelectedRangeQueryInput(days, 90), endDate },
    TRAINING_OVERVIEW_QUERY_OPTIONS,
  );

  const trainingInsights = useMemo(() => {
    const all: Insight[] = insightsQuery.data ?? [];
    return filterTrainingInsights(all);
  }, [insightsQuery.data]);

  return (
    <>
      <Section
        title="Training Calendar"
        subtitle="Daily training time (minutes per day); compare higher-volume days with recovery"
      >
        {calendarData.error ? (
          <QueryStatePanel error={calendarData.error} />
        ) : calendarData.isLoading ? (
          <ChartLoadingSkeleton height={180} />
        ) : (
          <TrainingCalendar data={calendarData.data ?? []} />
        )}
      </Section>

      <Section
        title="Fitness / Fatigue / Form"
        subtitle="Long-term fitness, short-term fatigue, and training form over time"
      >
        {pmcData.error ? (
          <QueryStatePanel error={pmcData.error} />
        ) : (
          <PmcChart
            data={pmcData.data?.data ?? []}
            model={pmcData.data?.model ?? null}
            loading={pmcData.isLoading}
          />
        )}
      </Section>

      <Section
        title="Volume & Zones"
        subtitle="Weekly volume, HR zone distribution, intensity split"
      >
        <TrainingInsightsPanel days={days} />
      </Section>

      <Section title="Recent Activities" subtitle="All recent training activities">
        <RecentActivitiesSection />
      </Section>

      {insightsQuery.isLoading && (
        <PageSection title="Training Insights" card={false}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {["t1", "t2"].map((id) => (
              <CorrelationCardSkeleton key={id} />
            ))}
          </div>
        </PageSection>
      )}

      {!insightsQuery.isLoading && trainingInsights.length > 0 && (
        <PageSection title="Training Insights" card={false}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {trainingInsights.map((insight) => (
              <CorrelationCard key={insight.id} insight={insight} />
            ))}
          </div>
        </PageSection>
      )}

      {insightsQuery.error && (
        <PageSection title="Training Insights" card={false}>
          <QueryStatePanel error={insightsQuery.error} />
        </PageSection>
      )}
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
