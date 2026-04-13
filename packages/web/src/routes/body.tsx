import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useState } from "react";
import { PageLayout } from "../components/PageLayout.tsx";
import { SubtabNav } from "../components/SubtabNav.tsx";
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
        nav={<SubtabNav tabs={subtabs} />}
      >
        <Outlet />
      </PageLayout>
    </BodyDaysContext.Provider>
  );
}
