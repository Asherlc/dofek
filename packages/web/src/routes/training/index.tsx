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
import { RecentActivitiesSection } from "../../components/RecentActivitiesSection.tsx";
import { TrainingCalendar } from "../../components/TrainingCalendar.tsx";
import { TrainingInsightsPanel } from "../../components/TrainingInsightsPanel.tsx";
import { useTrainingDays } from "../../lib/trainingDaysContext.ts";
import { filterTrainingInsights } from "../../lib/trainingInsights.ts";
import { trpc } from "../../lib/trpc.ts";

export const Route = createFileRoute("/training/")({
  component: TrainingOverview,
});

export function TrainingOverview() {
  const { days } = useTrainingDays();
  const endDate = useMemo(() => formatDateYmd(new Date()), []);

  const pmcData = trpc.pmc.chart.useQuery({ days }, { staleTime: 120_000, gcTime: 1_800_000 });
  const calendarData = trpc.calendar.calendarData.useQuery(
    { days },
    { staleTime: 120_000, gcTime: 1_800_000 },
  );
  const insightsQuery = trpc.insights.compute.useQuery(
    { days: Math.max(days, 90), endDate },
    { staleTime: 120_000, gcTime: 1_800_000 },
  );

  const trainingInsights = useMemo(() => {
    const all: Insight[] = insightsQuery.data ?? [];
    return filterTrainingInsights(all);
  }, [insightsQuery.data]);

  return (
    <>
      <Section title="Training Calendar" subtitle="Daily training activity heatmap">
        {calendarData.isLoading ? (
          <ChartLoadingSkeleton height={180} />
        ) : (
          <TrainingCalendar data={calendarData.data ?? []} />
        )}
      </Section>

      <Section
        title="Fitness / Fatigue / Form"
        subtitle="Long-term fitness, short-term fatigue, and training form over time"
      >
        <PmcChart
          data={pmcData.data?.data ?? []}
          model={pmcData.data?.model ?? null}
          loading={pmcData.isLoading}
        />
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
