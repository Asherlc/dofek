import { createFileRoute } from "@tanstack/react-router";
import { ChartDescriptionTooltip } from "../../components/ChartDescriptionTooltip.tsx";
import { ChartLoadingSkeleton } from "../../components/LoadingSkeleton.tsx";
import { PmcChart } from "../../components/PmcChart.tsx";
import { RecentActivitiesSection } from "../../components/RecentActivitiesSection.tsx";
import { TrainingCalendar } from "../../components/TrainingCalendar.tsx";
import { TrainingInsightsPanel } from "../../components/TrainingInsightsPanel.tsx";
import { useTrainingDays } from "../../lib/trainingDaysContext.ts";
import { trpc } from "../../lib/trpc.ts";

export const Route = createFileRoute("/training/")({
  component: TrainingOverview,
});

function TrainingOverview() {
  const { days } = useTrainingDays();

  const pmcData = trpc.pmc.chart.useQuery({ days });
  const calendarData = trpc.calendar.calendarData.useQuery({ days });

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
          error={pmcData.isError}
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
