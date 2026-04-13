import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useState } from "react";
import { PageLayout } from "../components/PageLayout.tsx";
import { SubtabNav } from "../components/SubtabNav.tsx";
import { TimeRangeSelector } from "../components/TimeRangeSelector.tsx";
import { TrainingDaysContext } from "../lib/trainingDaysContext.ts";

const subtabs = [
  { to: "/training", label: "Overview", exact: true },
  { to: "/training/endurance", label: "Endurance", exact: false },
  { to: "/training/cycling", label: "Cycling", exact: false },
  { to: "/training/running", label: "Running", exact: false },
  { to: "/training/strength", label: "Strength", exact: false },
  { to: "/training/hiking", label: "Hiking", exact: false },
  { to: "/training/recovery", label: "Recovery", exact: false },
] as const;

export const Route = createFileRoute("/training")({
  component: TrainingLayout,
});

function TrainingLayout() {
  const [days, setDays] = useState(90);

  return (
    <TrainingDaysContext.Provider value={{ days, setDays }}>
      <PageLayout
        headerChildren={<TimeRangeSelector days={days} onChange={setDays} />}
        nav={<SubtabNav tabs={subtabs} />}
      >
        <Outlet />
      </PageLayout>
    </TrainingDaysContext.Provider>
  );
}
