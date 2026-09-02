import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useMemo } from "react";
import { ChartRangeProvider } from "../components/DofekChart.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { TimeRangeSelector } from "../components/TimeRangeSelector.tsx";
import { useTimeRangePreference } from "../hooks/useTimeRangePreference.ts";
import { TrainingDaysContext } from "../lib/trainingDaysContext.ts";

const subtabs = [
  { to: "/training", label: "Overview", exact: true },
  { to: "/training/endurance", label: "Endurance", exact: false },
  { to: "/training/cycling", label: "Cycling", exact: false },
  { to: "/training/running", label: "Running", exact: false },
  { to: "/training/strength", label: "Strength", exact: false },
  { to: "/training/hiking", label: "Hiking", exact: false },
  { to: "/training/climbing", label: "Climbing", exact: false },
  { to: "/training/recovery", label: "Recovery", exact: false },
] as const;

export const Route = createFileRoute("/training")({
  component: TrainingLayout,
});

function TrainingLayout() {
  const { days, description, setDays } = useTimeRangePreference("training");
  const trainingDays = useMemo(() => ({ days, setDays }), [days, setDays]);

  return (
    <TrainingDaysContext.Provider value={trainingDays}>
      <ChartRangeProvider days={days}>
        <PageLayout
          headerChildren={
            <TimeRangeSelector days={days} description={description} onChange={setDays} />
          }
          tabs={subtabs}
        >
          <Outlet />
        </PageLayout>
      </ChartRangeProvider>
    </TrainingDaysContext.Provider>
  );
}
