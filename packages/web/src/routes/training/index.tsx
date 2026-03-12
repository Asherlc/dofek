import { createFileRoute } from "@tanstack/react-router";
import { PmcChart } from "../../components/PmcChart.tsx";
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
          <div className="flex items-center justify-center h-[180px]">
            <span className="text-zinc-600 text-sm">Loading...</span>
          </div>
        ) : (
          <TrainingCalendar
            data={
              (calendarData.data ?? []) as unknown as Array<{
                date: string;
                activityCount: number;
                totalMinutes: number;
                activityTypes: string[];
              }>
            }
          />
        )}
      </Section>

      <Section
        title="Fitness / Fatigue / Form"
        subtitle="Performance Management Chart (CTL/ATL/TSB)"
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
  return (
    <section>
      <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-1">{title}</h2>
      {subtitle && <p className="text-xs text-zinc-600 mb-4">{subtitle}</p>}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">{children}</div>
    </section>
  );
}
