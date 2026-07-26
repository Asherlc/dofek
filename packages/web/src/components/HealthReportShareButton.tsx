import type { HealthReportGenerateInput } from "dofek-server/types";
import { useState } from "react";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";

export function HealthReportShareButton({
  disabled = false,
  input,
}: {
  disabled?: boolean;
  input: HealthReportGenerateInput;
}) {
  const trpcUtils = trpc.useUtils();
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const generateReport = trpc.healthReport.generate.useMutation({
    onSuccess: async (report) => {
      try {
        await trpcUtils.healthReport.myReports.invalidate();
      } catch (error: unknown) {
        captureException(error, { source: "health-report-list-invalidation" });
      }

      const shareUrl = `${window.location.origin}/health-report?token=${report.shareToken}`;
      try {
        await navigator.clipboard.writeText(shareUrl);
        setStatusMessage("Link copied");
      } catch (error: unknown) {
        captureException(error, { source: "health-report-link-copy" });
        setClientError("Report created, but its link could not be copied. Open Shared Reports.");
      }
    },
  });

  const reportLabel = `${input.reportType} report`;
  const errorMessage = clientError ?? generateReport.error?.message ?? null;

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        aria-label={`Share ${reportLabel}`}
        className="rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={disabled || generateReport.isPending}
        onClick={() => {
          setClientError(null);
          setStatusMessage(null);
          generateReport.mutate(input);
        }}
      >
        {generateReport.isPending ? "Creating link…" : "Share"}
      </button>
      {statusMessage ? <output className="text-xs text-emerald-400">{statusMessage}</output> : null}
      {errorMessage ? (
        <span className="max-w-sm text-xs text-red-300" role="alert">
          {errorMessage}
        </span>
      ) : null}
    </div>
  );
}
