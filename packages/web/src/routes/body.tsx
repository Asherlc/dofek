import { createFileRoute, Outlet } from "@tanstack/react-router";
import { ChartRangeProvider } from "../components/DofekChart.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { useTimeRangePreference } from "../hooks/useTimeRangePreference.ts";
import { BodyDaysContext } from "../lib/bodyDaysContext.ts";

const subtabs = [
  { to: "/body", label: "Overview", exact: true },
  { to: "/body/heart-rate", label: "Heart Rate", exact: false },
] as const;

export const Route = createFileRoute("/body")({
  component: BodyLayout,
});

function BodyLayout() {
  const { days, description, setDays } = useTimeRangePreference("body");

  return (
    <BodyDaysContext.Provider value={{ days, description, setDays }}>
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
