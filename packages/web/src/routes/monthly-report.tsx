import { createFileRoute } from "@tanstack/react-router";
import { HealthReportShareButton } from "../components/HealthReportShareButton.tsx";
import { MonthlyReportContent } from "../components/MonthlyReportContent.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { healthReportTabs } from "../lib/healthReportNavigation.ts";
import { trpc } from "../lib/trpc.ts";

const REPORT_MONTHS = 6;

export const Route = createFileRoute("/monthly-report")({
  component: MonthlyReportPage,
});

function MonthlyReportPage() {
  const report = trpc.monthlyReport.report.useQuery({ months: REPORT_MONTHS });
  const { data, isLoading } = report;

  return (
    <PageLayout
      title="Monthly Report"
      subtitle="Month-over-month performance trends"
      tabs={healthReportTabs}
      headerChildren={
        data?.current ? (
          <HealthReportShareButton input={{ reportType: "monthly", months: REPORT_MONTHS }} />
        ) : undefined
      }
    >
      {report.error && !data ? (
        <QueryStatePanel error={report.error} height={160} />
      ) : isLoading ? (
        <div className="space-y-4">
          <div className="card p-5 animate-pulse h-32" />
          <div className="card p-5 animate-pulse h-32" />
        </div>
      ) : (
        <MonthlyReportContent data={data} />
      )}
    </PageLayout>
  );
}
