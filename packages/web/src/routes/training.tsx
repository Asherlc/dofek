import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useState } from "react";
import { AppHeader } from "../components/AppHeader.tsx";
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
      <div className="min-h-screen bg-zinc-950 text-zinc-100 overflow-x-hidden">
        <AppHeader>
          <TimeRangeSelector days={days} onChange={setDays} />
        </AppHeader>
        <nav className="border-b border-zinc-800 px-3 sm:px-6">
          <div className="mx-auto max-w-7xl flex gap-1 overflow-x-auto scrollbar-hide">
            {subtabs.map((tab) => (
              <Link
                key={tab.to}
                to={tab.to}
                activeOptions={{ exact: tab.exact }}
                className="px-3 py-2.5 text-xs transition-colors text-zinc-500 hover:text-zinc-300 whitespace-nowrap"
                activeProps={{
                  className:
                    "px-3 py-2.5 text-xs transition-colors text-zinc-100 border-b-2 border-emerald-500 whitespace-nowrap",
                }}
              >
                {tab.label}
              </Link>
            ))}
          </div>
        </nav>
        <main className="mx-auto max-w-7xl px-3 sm:px-6 py-4 sm:py-6 space-y-6 sm:space-y-8">
          <Outlet />
        </main>
      </div>
    </TrainingDaysContext.Provider>
  );
}
