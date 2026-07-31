import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { HealthReportShareButton } from "../components/HealthReportShareButton.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { ReportRecoveryPanel } from "../components/ReportRecoveryPanel.tsx";
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
  const navigate = useNavigate();
  const report = trpc.weeklyReport.report.useQuery(
    { weeks: REPORT_WEEKS, endDate },
    { retry: false },
  );
  const retry = () => {
    void report.refetch();
  };
  const reviewData = () => {
    void navigate({ to: "/alerts" });
  };

  return (
    <PageLayout
      title="Weekly Report"
      subtitle="What changed, what the data suggests, and what to try next"
      tabs={healthReportTabs}
      headerChildren={
        report.data?.current ? (
          <HealthReportShareButton input={{ reportType: "weekly", weeks: REPORT_WEEKS, endDate }} />
        ) : undefined
      }
    >
      {report.error && !report.data ? (
        <ReportRecoveryPanel
          message={report.error.message}
          onRetry={retry}
          onReviewData={reviewData}
          retrying={report.isFetching}
        />
      ) : report.data && !report.data.current && report.data.history.length === 0 ? (
        <ReportRecoveryPanel
          message={report.data.recovery.emptyMessage}
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
          <WeeklyReportCard data={report.data} loading={report.isLoading && !report.data} />
        </div>
      )}
    </PageLayout>
  );
}
