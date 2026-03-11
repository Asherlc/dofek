import { useState } from "react";
import { AerobicEfficiencyChart } from "../components/AerobicEfficiencyChart.tsx";
import { AppHeader } from "../components/AppHeader.tsx";
import { EftpTrendChart } from "../components/EftpTrendChart.tsx";
import { PmcChart } from "../components/PmcChart.tsx";
import { PolarizationTrendChart } from "../components/PolarizationTrendChart.tsx";
import { PowerCurveChart } from "../components/PowerCurveChart.tsx";
import { TimeRangeSelector } from "../components/TimeRangeSelector.tsx";
import { TrainingCalendar } from "../components/TrainingCalendar.tsx";
import { TrainingInsightsPanel } from "../components/TrainingInsightsPanel.tsx";
import { trpc } from "../lib/trpc.ts";

export function TrainingPage() {
  const [days, setDays] = useState(180);

  const pmcData = trpc.pmc.chart.useQuery({ days });
  const powerCurve = trpc.power.powerCurve.useQuery({ days });
  const eftpTrend = trpc.power.eftpTrend.useQuery({ days });
  const calendarData = trpc.calendar.calendarData.useQuery({ days });
  const efficiency = trpc.efficiency.aerobicEfficiency.useQuery({ days });
  const polarization = trpc.efficiency.polarizationTrend.useQuery({ days });

  const effData = efficiency.data as
    | {
        maxHr: number | null;
        activities: Array<{
          date: string;
          activityType: string;
          name: string;
          avgPowerZ2: number;
          avgHrZ2: number;
          efficiencyFactor: number;
          z2Samples: number;
        }>;
      }
    | undefined;
  const polData = polarization.data as
    | {
        maxHr: number | null;
        weeks: Array<{
          week: string;
          z1Seconds: number;
          z2Seconds: number;
          z3Seconds: number;
          polarizationIndex: number | null;
        }>;
      }
    | undefined;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <AppHeader activePage="training">
        <TimeRangeSelector days={days} onChange={setDays} />
      </AppHeader>
      <main className="mx-auto max-w-7xl p-6 space-y-8">
        {/* PMC Chart */}
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

        {/* eFTP + Power Curve side by side */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Section title="eFTP Trend" subtitle="Estimated FTP via Critical Power model">
            <EftpTrendChart
              data={eftpTrend.data?.trend ?? []}
              currentEftp={eftpTrend.data?.currentEftp ?? null}
              loading={eftpTrend.isLoading}
            />
          </Section>

          <Section title="Power Duration Curve" subtitle="Best power at each duration">
            <PowerCurveChart
              data={powerCurve.data?.points ?? []}
              model={powerCurve.data?.model ?? null}
              loading={powerCurve.isLoading}
            />
          </Section>
        </div>

        {/* Volume + Zones + Intensity (existing component) */}
        <Section
          title="Volume & Zones"
          subtitle="Weekly volume, HR zone distribution, intensity split"
        >
          <TrainingInsightsPanel days={days} />
        </Section>

        {/* Calendar Heatmap */}
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

        {/* Aerobic Efficiency + Polarization Index side by side */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Section title="Aerobic Efficiency" subtitle="Power/HR ratio in Z2 over time">
            <AerobicEfficiencyChart
              activities={effData?.activities ?? []}
              maxHr={effData?.maxHr ?? null}
              loading={efficiency.isLoading}
            />
          </Section>

          <Section
            title="Polarization Index"
            subtitle="Weekly PI trend (>2.0 = polarized training)"
          >
            <PolarizationTrendChart
              weeks={polData?.weeks ?? []}
              maxHr={polData?.maxHr ?? null}
              loading={polarization.isLoading}
            />
          </Section>
        </div>
      </main>
    </div>
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
