import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useState } from "react";
import { ChartRangeProvider } from "../components/DofekChart.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { BodyDaysContext } from "../lib/bodyDaysContext.ts";
import type { TimeRangeDays } from "../lib/timeRange.ts";

const subtabs = [
  { to: "/body", label: "Overview", exact: true },
  { to: "/body/heart-rate", label: "Heart Rate", exact: false },
] as const;

export const Route = createFileRoute("/body")({
  component: BodyLayout,
});

function BodyLayout() {
  const [days, setDays] = useState<TimeRangeDays>(30);

  return (
    <BodyDaysContext.Provider value={{ days, setDays }}>
      <ChartRangeProvider days={days}>
        <PageLayout
          title="Body"
          subtitle="Recovery metrics, vitals, and body composition"
          tabs={subtabs}
        >
          <Outlet />
        </PageLayout>
      </ChartRangeProvider>
    </BodyDaysContext.Provider>
  );
}
