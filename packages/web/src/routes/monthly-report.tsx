import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { HealthReportShareButton } from "../components/HealthReportShareButton.tsx";
import { MonthlyReportContent } from "../components/MonthlyReportContent.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { ReportRecoveryPanel } from "../components/ReportRecoveryPanel.tsx";
import { useTodayQueryDate } from "../hooks/useTodayQueryDate.ts";
import { healthReportTabs } from "../lib/healthReportNavigation.ts";
import { trpc } from "../lib/trpc.ts";

const REPORT_MONTHS = 6;

export const Route = createFileRoute("/monthly-report")({
  component: MonthlyReportPage,
});

function MonthlyReportPage() {
  const endDate = useTodayQueryDate();
  const navigate = useNavigate();
  const report = trpc.monthlyReport.report.useQuery(
    { months: REPORT_MONTHS, endDate },
    { retry: false },
  );
  const { data, isLoading } = report;
  const retry = () => {
    void report.refetch();
  };
  const reviewData = () => {
    void navigate({ to: "/alerts" });
  };

  return (
    <PageLayout
      title="Monthly Report"
      subtitle="Decisions and evidence from month-over-month health patterns"
      tabs={healthReportTabs}
      headerChildren={
        data?.current ? (
          <HealthReportShareButton
            input={{ reportType: "monthly", months: REPORT_MONTHS, endDate }}
          />
        ) : undefined
      }
    >
      {report.error && !data ? (
        <ReportRecoveryPanel
          message={report.error.message}
          onRetry={retry}
          onReviewData={reviewData}
          retrying={report.isFetching}
        />
      ) : isLoading && !data ? (
        <div className="space-y-4">
          <div className="card p-5 animate-pulse h-32" />
          <div className="card p-5 animate-pulse h-32" />
        </div>
      ) : data && !data.current && data.history.length === 0 ? (
        <ReportRecoveryPanel
          message={data.recovery.emptyMessage}
          onRetry={retry}
          onReviewData={reviewData}
          retrying={report.isFetching}
        />
      ) : (
        <div className="space-y-4">
          {report.error ? (
            <ReportRecoveryPanel
              message={report.error.message}
              onRetry={retry}
              onReviewData={reviewData}
              preserved
              retrying={report.isFetching}
            />
          ) : null}
          <MonthlyReportContent data={data} />
        </div>
      )}
    </PageLayout>
  );
}
