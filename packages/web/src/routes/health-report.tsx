import { formatDateMedium } from "@dofek/format/format";
import { createFileRoute, useSearch } from "@tanstack/react-router";
import {
  monthlyReportEmptyState,
  monthlyReportEmptyStateSchema,
  weeklyReportEmptyState,
  weeklyReportEmptyStateSchema,
} from "dofek-server/report-empty-state";
import { useState } from "react";
import { z } from "zod";
import { MonthlyReportContent } from "../components/MonthlyReportContent.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { PaginationControls } from "../components/PaginationControls.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { WeeklyReportCard } from "../components/WeeklyReportCard.tsx";
import { healthReportTabs } from "../lib/healthReportNavigation.ts";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";

export const Route = createFileRoute("/health-report")({
  validateSearch: (search: Record<string, unknown>): { token?: string | null } => {
    if (!Object.hasOwn(search, "token")) return {};
    if (typeof search.token !== "string") return { token: null };
    const token = search.token.trim();
    return { token: token.length > 0 ? token : null };
  },
  component: HealthReportPage,
});

function HealthReportPage() {
  const { token } = useSearch({ from: "/health-report" });

  if (token === null) {
    return (
      <SharedReportShell>
        <QueryStatePanel message="This shared report link is invalid." />
      </SharedReportShell>
    );
  }
  if (token !== undefined) return <SharedHealthReport token={token} />;
  return <HealthReportManagement />;
}

const weekSummarySchema = z.object({
  weekStart: z.string(),
  trainingHours: z.number(),
  activityCount: z.number(),
  avgDailyLoad: z.number(),
  avgSleepMinutes: z.number(),
  sleepPerformancePct: z.number(),
  avgReadiness: z.number(),
  avgRestingHr: z.number().nullable(),
  avgHrv: z.number().nullable(),
});

const decisionSupportItemSchema = z.string().trim().min(1);
const reportDecisionSynthesisSchema = z.object({
  whatChanged: z.array(decisionSupportItemSchema),
  likelyAssociations: z.array(decisionSupportItemSchema),
  whatWorked: z.array(decisionSupportItemSchema),
  whatToTryNext: z.array(decisionSupportItemSchema),
  confidenceAndMissingData: z.array(decisionSupportItemSchema),
});

const reportRecoverySchema = z.object({
  range: z.object({
    startDate: z.string(),
    endDate: z.string(),
  }),
  emptyMessage: z.string(),
});

const weeklyReportRecoverySchema = reportRecoverySchema;
const monthlyReportRecoverySchema = reportRecoverySchema;

const weeklyReportSchema = z.object({
  current: weekSummarySchema.nullable(),
  history: z.array(weekSummarySchema),
  decisionSupport: reportDecisionSynthesisSchema.nullable(),
  emptyState: weeklyReportEmptyStateSchema.optional(),
  recovery: weeklyReportRecoverySchema.optional(),
});

const monthSummarySchema = z.object({
  monthStart: z.string(),
  trainingHours: z.number(),
  activityCount: z.number(),
  avgDailyStrain: z.number(),
  avgSleepMinutes: z.number(),
  avgRestingHr: z.number().nullable(),
  avgHrv: z.number().nullable(),
  trainingHoursTrend: z.number().nullable(),
  avgSleepTrend: z.number().nullable(),
});

const monthlyReportSchema = z.object({
  current: monthSummarySchema.nullable(),
  history: z.array(monthSummarySchema),
  decisionSupport: reportDecisionSynthesisSchema.nullable(),
  emptyState: monthlyReportEmptyStateSchema.optional(),
  recovery: monthlyReportRecoverySchema.optional(),
});
const REPORT_PAGE_SIZE = 20;

function SharedReportShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-page text-foreground px-3 py-8 sm:px-6">
      <main className="mx-auto max-w-3xl space-y-6">
        <header className="text-center">
          <img
            src="/icon.svg"
            alt="Dofek logo"
            width={36}
            height={36}
            className="mx-auto mb-3 rounded-md"
          />
          <h1 className="text-2xl font-semibold tracking-tight">Shared Health Report</h1>
          <p className="mt-1 text-sm text-muted">
            A read-only report snapshot shared through Dofek
          </p>
        </header>
        {children}
      </main>
    </div>
  );
}

function SharedHealthReport({ token }: { token: string }) {
  const report = trpc.healthReport.getShared.useQuery({ token });

  if (report.error) {
    return (
      <SharedReportShell>
        <QueryStatePanel error={report.error} />
      </SharedReportShell>
    );
  }
  if (report.isLoading) {
    return (
      <SharedReportShell>
        <QueryStatePanel variant="loading" />
      </SharedReportShell>
    );
  }
  if (!report.data) {
    return (
      <SharedReportShell>
        <QueryStatePanel message="This shared report does not exist or has expired." />
      </SharedReportShell>
    );
  }

  if (report.data.reportType === "weekly") {
    const parsedReport = weeklyReportSchema.safeParse(report.data.reportData);
    if (parsedReport.success) {
      const { recovery: _recovery, ...reportData } = parsedReport.data;
      return (
        <SharedReportShell>
          <WeeklyReportCard
            data={{
              ...reportData,
              decisionSupport: reportData.decisionSupport ?? null,
              emptyState: reportData.emptyState ?? weeklyReportEmptyState,
            }}
          />
        </SharedReportShell>
      );
    }
  }

  if (report.data.reportType === "monthly") {
    const parsedReport = monthlyReportSchema.safeParse(report.data.reportData);
    if (parsedReport.success) {
      const { recovery: _recovery, ...reportData } = parsedReport.data;
      return (
        <SharedReportShell>
          <MonthlyReportContent
            data={{
              ...reportData,
              decisionSupport: reportData.decisionSupport ?? null,
              emptyState: reportData.emptyState ?? monthlyReportEmptyState,
            }}
          />
        </SharedReportShell>
      );
    }
  }

  return (
    <SharedReportShell>
      <QueryStatePanel message="This shared report contains invalid data." />
    </SharedReportShell>
  );
}

function HealthReportManagement() {
  const { data: reports, error, isLoading } = trpc.healthReport.myReports.useQuery();
  const [page, setPage] = useState(0);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [manualCopyLink, setManualCopyLink] = useState<{
    token: string;
    url: string;
  } | null>(null);

  const copyLink = async (token: string) => {
    const url = `${window.location.origin}/health-report?token=${token}`;
    setCopiedToken(null);
    setManualCopyLink(null);
    try {
      await navigator.clipboard.writeText(url);
      setCopiedToken(token);
      setTimeout(() => setCopiedToken(null), 2000);
    } catch (copyError: unknown) {
      captureException(copyError, { source: "health-report-list-link-copy" });
      setManualCopyLink({ token, url });
    }
  };
  const reportItems = reports ?? [];
  const reportPageCount = Math.ceil(reportItems.length / REPORT_PAGE_SIZE);
  const currentPage = Math.min(page, Math.max(reportPageCount - 1, 0));
  const visibleReports = reportItems.slice(
    currentPage * REPORT_PAGE_SIZE,
    (currentPage + 1) * REPORT_PAGE_SIZE,
  );

  return (
    <PageLayout
      title="Health Reports"
      subtitle="Generate and share health report snapshots"
      tabs={healthReportTabs}
    >
      {error && !reports ? (
        <QueryStatePanel error={error} height={160} />
      ) : isLoading ? (
        <div className="card p-6 animate-pulse h-32" />
      ) : (
        <div className="space-y-6">
          {/* My shared reports */}
          <div className="card p-6">
            <h3 className="text-sm font-medium text-muted uppercase tracking-wider mb-3">
              Shared Reports
            </h3>
            {!reports || reports.length === 0 ? (
              <p className="text-sm text-dim">
                No shared reports yet. Use the share button on weekly or monthly reports to create
                one.
              </p>
            ) : (
              <div className="space-y-2">
                {visibleReports.map((report) => (
                  <div key={report.id} className="border-b border-border py-3 last:border-0">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-sm font-medium text-foreground capitalize">
                          {report.reportType} Report
                        </span>
                        <span className="text-xs text-dim ml-2">
                          {formatDateMedium(report.createdAt)}
                        </span>
                        {report.expiresAt && (
                          <span className="text-xs text-muted ml-2">
                            Expires {formatDateMedium(report.expiresAt)}
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => void copyLink(report.shareToken)}
                        className="px-3 py-1.5 bg-accent/15 text-accent rounded text-xs font-medium hover:bg-accent/25 transition-colors"
                      >
                        {copiedToken === report.shareToken ? "Copied" : "Copy Link"}
                      </button>
                    </div>
                    {manualCopyLink?.token === report.shareToken && (
                      <div className="mt-3 space-y-1">
                        <p className="text-xs text-muted">
                          Clipboard access failed. Select and copy this link manually.
                        </p>
                        <input
                          type="text"
                          readOnly
                          aria-label="Copy report link manually"
                          value={manualCopyLink.url}
                          onFocus={(event) => event.currentTarget.select()}
                          className="w-full rounded border border-border bg-page px-2 py-1.5 text-xs text-foreground"
                        />
                      </div>
                    )}
                  </div>
                ))}
                <PaginationControls
                  page={currentPage}
                  pageSize={REPORT_PAGE_SIZE}
                  totalItems={reportItems.length}
                  itemLabel="reports"
                  onPageChange={setPage}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </PageLayout>
  );
}
