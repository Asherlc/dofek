import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { BehaviorImpactChart } from "../components/BehaviorImpactChart.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { TimeRangeSelector } from "../components/TimeRangeSelector.tsx";

export const Route = createFileRoute("/behavior-impact")({
  component: BehaviorImpactPage,
});

function BehaviorImpactPage() {
  const [days, setDays] = useState(90);

  return (
    <PageLayout
      title="Behavior Impact"
      subtitle="How your daily behaviors affect next-day readiness"
      headerChildren={<TimeRangeSelector days={days} onChange={setDays} />}
    >
      <BehaviorImpactChart days={days} />
    </PageLayout>
  );
}
