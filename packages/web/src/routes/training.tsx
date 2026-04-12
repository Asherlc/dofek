import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useState } from "react";
import { PageLayout } from "../components/PageLayout.tsx";
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
  { to: "/training/heart-rate", label: "Heart Rate", exact: false },
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
        nav={
          <nav className="border-b border-border px-3 sm:px-6">
            <div className="mx-auto max-w-7xl flex gap-1 overflow-x-auto scrollbar-hide">
              {subtabs.map((tab) => (
                <Link
                  key={tab.to}
                  to={tab.to}
                  activeOptions={{ exact: tab.exact }}
                  className="px-3 py-2.5 text-xs transition-colors text-subtle hover:text-foreground whitespace-nowrap"
                  activeProps={{
                    className:
                      "px-3 py-2.5 text-xs transition-colors text-foreground border-b-2 border-accent whitespace-nowrap",
                  }}
                >
                  {tab.label}
                </Link>
              ))}
            </div>
          </nav>
        }
      >
        <Outlet />
      </PageLayout>
    </TrainingDaysContext.Provider>
  );
}
