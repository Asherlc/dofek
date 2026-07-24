import { createFileRoute } from "@tanstack/react-router";
import { HealthReportShareButton } from "../components/HealthReportShareButton.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { WeeklyReportCard } from "../components/WeeklyReportCard.tsx";
import { useTodayQueryDate } from "../hooks/useTodayQueryDate.ts";
import { healthReportTabs } from "../lib/healthReportNavigation.ts";
import { trpc } from "../lib/trpc.ts";

const REPORT_WEEKS = 12;

export const Route = createFileRoute("/weekly-report")({
  component: WeeklyReportPage,
});

function WeeklyReportPage() {
  const endDate = useTodayQueryDate();
  const report = trpc.weeklyReport.report.useQuery({ weeks: REPORT_WEEKS, endDate });

  return (
    <PageLayout
      title="Weekly Report"
      subtitle="Weekly training, sleep, and recovery trends"
      tabs={healthReportTabs}
      headerChildren={
        report.data?.current ? (
          <HealthReportShareButton input={{ reportType: "weekly", weeks: REPORT_WEEKS, endDate }} />
        ) : undefined
      }
    >
      {report.error && !report.data ? (
        <QueryStatePanel error={report.error} height={320} />
      ) : (
        <WeeklyReportCard data={report.data} loading={report.isLoading} />
      )}
    </PageLayout>
  );
}
