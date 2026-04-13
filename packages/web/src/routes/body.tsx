import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useState } from "react";
import { PageLayout } from "../components/PageLayout.tsx";
import { TimeRangeSelector } from "../components/TimeRangeSelector.tsx";
import { BodyDaysContext } from "../lib/bodyDaysContext.ts";

const subtabs = [
  { to: "/body", label: "Overview", exact: true },
  { to: "/body/heart-rate", label: "Heart Rate", exact: false },
] as const;

export const Route = createFileRoute("/body")({
  component: BodyLayout,
});

function BodyLayout() {
  const [days, setDays] = useState(30);

  return (
    <BodyDaysContext.Provider value={{ days, setDays }}>
      <PageLayout
        title="Body"
        subtitle="Recovery metrics, vitals, and body composition"
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
    </BodyDaysContext.Provider>
  );
}
