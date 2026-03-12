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
        <Section
          title="Aerobic Efficiency"
          subtitle="Power output per heartbeat at easy effort — higher means fitter"
        >
          <AerobicEfficiencyChart
            activities={efficiency.data?.activities ?? []}
            maxHr={efficiency.data?.maxHr ?? null}
            loading={efficiency.isLoading}
          />
        </Section>

        <Section
          title="Polarization Index"
          subtitle="Weekly training distribution — above 2.0 means mostly easy and hard, little moderate"
        >
          <PolarizationTrendChart
            weeks={polarization.data?.weeks ?? []}
            maxHr={polarization.data?.maxHr ?? null}
            loading={polarization.isLoading}
          />
        </Section>
      </div>

      <Section
        title="Ramp Rate"
        subtitle="How quickly your fitness load is building week over week"
      >
        <RampRateChart
          data={rampRate.data?.weeks ?? []}
          currentRampRate={rampRate.data?.currentRampRate ?? 0}
          recommendation={rampRate.data?.recommendation ?? ""}
          loading={rampRate.isLoading}
        />
      </Section>

      {/* Monotony + Vertical Ascent */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Training Monotony & Strain" subtitle="Weekly training load variability">
          <TrainingMonotonyChart data={monotony.data ?? []} loading={monotony.isLoading} />
        </Section>

        <Section title="Vertical Ascent Rate" subtitle="Climbing speed on grade >3% segments">
          <VerticalAscentChart
            data={verticalAscent.data ?? []}
            loading={verticalAscent.isLoading}
          />
        </Section>
      </div>

      <Section
        title="Activity Variability Index"
        subtitle="Normalized power vs average power ratio per activity"
      >
        <ActivityVariabilityTable data={variability.data ?? []} loading={variability.isLoading} />
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
