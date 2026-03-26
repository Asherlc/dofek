import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageLayout } from "../components/PageLayout.tsx";
import { trpc } from "../lib/trpc.ts";

export const Route = createFileRoute("/health-report")({
  component: HealthReportPage,
});

function HealthReportPage() {
  const { data: reports, isLoading } = trpc.healthReport.myReports.useQuery();
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  const copyLink = (token: string) => {
    const url = `${window.location.origin}/health-report?token=${token}`;
    navigator.clipboard.writeText(url);
    setCopiedToken(token);
    setTimeout(() => setCopiedToken(null), 2000);
  };

  return (
    <PageLayout title="Health Reports" subtitle="Generate and share health report snapshots">
      {isLoading ? (
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
                {reports.map((report) => (
                  <div
                    key={report.id}
                    className="flex items-center justify-between py-3 border-b border-border last:border-0"
                  >
                    <div>
                      <span className="text-sm font-medium text-foreground capitalize">
                        {report.reportType} Report
                      </span>
                      <span className="text-xs text-dim ml-2">
                        {new Date(report.createdAt).toLocaleDateString()}
                      </span>
                      {report.expiresAt && (
                        <span className="text-xs text-muted ml-2">
                          Expires {new Date(report.expiresAt).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => copyLink(report.shareToken)}
                      className="px-3 py-1.5 bg-accent/15 text-accent rounded text-xs font-medium hover:bg-accent/25 transition-colors"
                    >
                      {copiedToken === report.shareToken ? "Copied" : "Copy Link"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </PageLayout>
  );
}
