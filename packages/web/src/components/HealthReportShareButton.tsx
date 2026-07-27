import { formatDateMedium } from "@dofek/format/format";
import type { HealthReportGenerateInput } from "dofek-server/types";
import { useState } from "react";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";

const SHARE_EXPIRY_OPTIONS = [7, 30, 90] as const;
type ShareExpiryDays = (typeof SHARE_EXPIRY_OPTIONS)[number];
const DEFAULT_SHARE_EXPIRY_DAYS: ShareExpiryDays = 7;

export function HealthReportShareButton({
  disabled = false,
  input,
}: {
  disabled?: boolean;
  input: HealthReportGenerateInput;
}) {
  const trpcUtils = trpc.useUtils();
  const [expiresInDays, setExpiresInDays] = useState<ShareExpiryDays>(DEFAULT_SHARE_EXPIRY_DAYS);
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
        setStatusMessage(
          report.expiresAt
            ? `Link copied · expires ${formatDateMedium(report.expiresAt)}`
            : "Link copied",
        );
      } catch (error: unknown) {
        captureException(error, { source: "health-report-link-copy" });
        setClientError("Report created, but its link could not be copied. Open Shared Reports.");
      }
    },
  });

  const reportLabel = `${input.reportType} report`;
  const errorMessage = clientError ?? generateReport.error?.message ?? null;

  return (
    <div className="flex flex-col items-start gap-2">
      <fieldset
        aria-label="Share link expires in"
        className="flex flex-wrap items-center gap-2 border-0 p-0"
      >
        <legend className="sr-only">Share link expires in</legend>
        <span className="text-xs text-muted" aria-hidden="true">
          Expires in
        </span>
        {SHARE_EXPIRY_OPTIONS.map((days) => {
          const selected = expiresInDays === days;
          const optionId = `share-expiry-${days}`;
          return (
            <label
              key={days}
              htmlFor={optionId}
              className={`cursor-pointer rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                selected
                  ? "border-accent bg-accent/20 text-foreground"
                  : "border-border bg-transparent text-muted hover:border-border-strong hover:text-foreground"
              } ${disabled || generateReport.isPending ? "cursor-not-allowed opacity-50" : ""}`}
            >
              <input
                id={optionId}
                type="radio"
                name="share-link-expiry"
                value={days}
                checked={selected}
                disabled={disabled || generateReport.isPending}
                className="sr-only"
                onChange={() => setExpiresInDays(days)}
              />
              {days} days
            </label>
          );
        })}
      </fieldset>
      <button
        type="button"
        aria-label={`Share ${reportLabel}`}
        className="rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={disabled || generateReport.isPending}
        onClick={() => {
          setClientError(null);
          setStatusMessage(null);
          generateReport.mutate({ ...input, expiresInDays });
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
