import { createFileRoute } from "@tanstack/react-router";
import { BehaviorImpactChart } from "../components/BehaviorImpactChart.tsx";
import { ChartRangeProvider } from "../components/DofekChart.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { TimeRangeSelector } from "../components/TimeRangeSelector.tsx";
import { useTimeRangePreference } from "../hooks/useTimeRangePreference.ts";

export const Route = createFileRoute("/behavior-impact")({
  component: BehaviorImpactPage,
});

function BehaviorImpactPage() {
  const { days, description, setDays } = useTimeRangePreference("behavior");

  return (
    <ChartRangeProvider days={days}>
      <PageLayout
        title="Behavior Associations"
        subtitle="How your daily behaviors are associated with next-day readiness"
        headerChildren={
          <TimeRangeSelector days={days} description={description} onChange={setDays} />
        }
      >
        <BehaviorImpactChart days={days} />
      </PageLayout>
    </ChartRangeProvider>
  );
}
