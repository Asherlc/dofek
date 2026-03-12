import { createFileRoute } from "@tanstack/react-router";
import { ActivityVariabilityTable } from "../../components/ActivityVariabilityTable.tsx";
import { AerobicEfficiencyChart } from "../../components/AerobicEfficiencyChart.tsx";
import { EftpTrendChart } from "../../components/EftpTrendChart.tsx";
import { PolarizationTrendChart } from "../../components/PolarizationTrendChart.tsx";
import { PowerCurveChart } from "../../components/PowerCurveChart.tsx";
import { RampRateChart } from "../../components/RampRateChart.tsx";
import { TrainingMonotonyChart } from "../../components/TrainingMonotonyChart.tsx";
import { VerticalAscentChart } from "../../components/VerticalAscentChart.tsx";
import { useTrainingDays } from "../../lib/trainingDaysContext.ts";
import { trpc } from "../../lib/trpc.ts";

export const Route = createFileRoute("/training/endurance")({
  component: EnduranceTab,
});

function EnduranceTab() {
  const { days } = useTrainingDays();

  const powerCurve = trpc.power.powerCurve.useQuery({ days });
  const eftpTrend = trpc.power.eftpTrend.useQuery({ days });
  const efficiency = trpc.efficiency.aerobicEfficiency.useQuery({ days });
  const polarization = trpc.efficiency.polarizationTrend.useQuery({ days });
  const rampRate = trpc.cyclingAdvanced.rampRate.useQuery({ days });
  const monotony = trpc.cyclingAdvanced.trainingMonotony.useQuery({ days });
  const variability = trpc.cyclingAdvanced.activityVariability.useQuery({ days });
  const verticalAscent = trpc.cyclingAdvanced.verticalAscentRate.useQuery({ days });

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
    <>
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

      {/* Aerobic Efficiency + Polarization */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Aerobic Efficiency" subtitle="Power/HR ratio in Z2 over time">
          <AerobicEfficiencyChart
            activities={effData?.activities ?? []}
            maxHr={effData?.maxHr ?? null}
            loading={efficiency.isLoading}
          />
        </Section>

        <Section title="Polarization Index" subtitle="Weekly PI trend (>2.0 = polarized training)">
          <PolarizationTrendChart
            weeks={polData?.weeks ?? []}
            maxHr={polData?.maxHr ?? null}
            loading={polarization.isLoading}
          />
        </Section>
      </div>

      <Section title="Ramp Rate" subtitle="Weekly CTL ramp rate with training recommendations">
        <RampRateChart
          data={((rampRate.data as Record<string, unknown> | undefined)?.weeks ?? []) as never[]}
          currentRampRate={
            ((rampRate.data as Record<string, unknown> | undefined)?.currentRampRate as number) ?? 0
          }
          recommendation={
            ((rampRate.data as Record<string, unknown> | undefined)?.recommendation as string) ?? ""
          }
          loading={rampRate.isLoading}
        />
      </Section>

      {/* Monotony + Vertical Ascent */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Training Monotony & Strain" subtitle="Weekly training load variability">
          <TrainingMonotonyChart
            data={(monotony.data ?? []) as never[]}
            loading={monotony.isLoading}
          />
        </Section>

        <Section title="Vertical Ascent Rate" subtitle="Climbing speed on grade >3% segments">
          <VerticalAscentChart
            data={(verticalAscent.data ?? []) as never[]}
            loading={verticalAscent.isLoading}
          />
        </Section>
      </div>

      <Section
        title="Activity Variability Index"
        subtitle="Normalized power vs average power ratio per activity"
      >
        <ActivityVariabilityTable
          data={(variability.data ?? []) as never[]}
          loading={variability.isLoading}
        />
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
