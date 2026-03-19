import { createFileRoute } from "@tanstack/react-router";
import { PolarizationTrendChart } from "../../components/PolarizationTrendChart.tsx";
import { RampRateChart } from "../../components/RampRateChart.tsx";
import { TrainingMonotonyChart } from "../../components/TrainingMonotonyChart.tsx";
import { useTrainingDays } from "../../lib/trainingDaysContext.ts";
import { trpc } from "../../lib/trpc.ts";

export const Route = createFileRoute("/training/endurance")({
  component: EnduranceTab,
});

function EnduranceTab() {
  const { days } = useTrainingDays();

  const polarization = trpc.efficiency.polarizationTrend.useQuery({ days });
  const rampRate = trpc.cyclingAdvanced.rampRate.useQuery({ days });
  const monotony = trpc.cyclingAdvanced.trainingMonotony.useQuery({ days });

  return (
    <>
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

      <Section title="Training Monotony & Strain" subtitle="Weekly training load variability">
        <TrainingMonotonyChart data={monotony.data ?? []} loading={monotony.isLoading} />
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
