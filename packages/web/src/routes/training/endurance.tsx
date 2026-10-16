import { ENDURANCE_ACTIVITY_TYPES } from "@dofek/training/endurance-types";
import { TRAINING_TERMINOLOGY } from "@dofek/training/terminology";
import { createFileRoute } from "@tanstack/react-router";
import { PolarizationTrendChart } from "../../components/PolarizationTrendChart.tsx";
import { QueryStatePanel } from "../../components/QueryStatePanel.tsx";
import { RampRateChart } from "../../components/RampRateChart.tsx";
import { RecentActivitiesSection } from "../../components/RecentActivitiesSection.tsx";
import { TrainingMonotonyChart } from "../../components/TrainingMonotonyChart.tsx";
import { selectedRangeQueryInput } from "../../lib/timeRange.ts";
import { useTrainingDays } from "../../lib/trainingDaysContext.ts";
import { TRAINING_SLOW_QUERY_OPTIONS } from "../../lib/trainingQueryOptions.ts";
import { trpc } from "../../lib/trpc.ts";

export const Route = createFileRoute("/training/endurance")({
  component: EnduranceTab,
});

function EnduranceTab() {
  const { days } = useTrainingDays();

  const polarization = trpc.efficiency.polarizationTrend.useQuery(
    selectedRangeQueryInput(days),
    TRAINING_SLOW_QUERY_OPTIONS,
  );
  const rampRate = trpc.cyclingAdvanced.rampRate.useQuery(selectedRangeQueryInput(days));
  const monotony = trpc.cyclingAdvanced.trainingMonotony.useQuery(selectedRangeQueryInput(days));

  return (
    <>
      <Section title={TRAINING_TERMINOLOGY.polarization.plainLabel}>
        {polarization.error ? (
          <QueryStatePanel error={polarization.error} />
        ) : (
          <PolarizationTrendChart
            weeks={polarization.data?.weeks ?? []}
            maxHr={polarization.data?.maxHr ?? null}
            threshold={polarization.data?.threshold}
            method={polarization.data?.method ?? null}
            loading={polarization.isLoading}
          />
        )}
      </Section>

      <Section title="Ramp Rate">
        {rampRate.error ? (
          <QueryStatePanel error={rampRate.error} />
        ) : (
          <RampRateChart
            data={rampRate.data?.weeks ?? []}
            currentRampRate={rampRate.data?.currentRampRate ?? 0}
            recommendation={rampRate.data?.recommendation ?? ""}
            loading={rampRate.isLoading}
          />
        )}
      </Section>

      <Section title={TRAINING_TERMINOLOGY.monotony.plainLabel}>
        {monotony.error ? (
          <QueryStatePanel error={monotony.error} />
        ) : (
          <TrainingMonotonyChart data={monotony.data ?? []} loading={monotony.isLoading} />
        )}
      </Section>

      <Section title="Recent Endurance Activities">
        <RecentActivitiesSection activityTypes={ENDURANCE_ACTIVITY_TYPES} />
      </Section>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-sm font-medium text-muted uppercase tracking-wider">{title}</h2>
      </div>
      <div className="card p-4">{children}</div>
    </section>
  );
}
