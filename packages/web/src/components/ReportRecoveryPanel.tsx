import { operationalStatusColors } from "@dofek/scoring/colors";

interface ReportRecoveryPanelProps {
  message: string;
  onRetry: () => void;
  onReviewData: () => void;
  preserved?: boolean;
  retrying?: boolean;
}

export function ReportRecoveryPanel({
  message,
  onRetry,
  onReviewData,
  preserved = false,
  retrying = false,
}: ReportRecoveryPanelProps) {
  const errorTone = operationalStatusColors.danger;
  return (
    <section
      className="rounded-lg border p-4"
      role="alert"
      style={{
        backgroundColor: errorTone.surface,
        borderColor: errorTone.border,
        color: errorTone.foreground,
      }}
    >
      <h2 className="text-sm font-semibold">
        {preserved ? "Showing the last available report" : "Report unavailable"}
      </h2>
      <p className="mt-1 text-sm">{message}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={retrying}
          onClick={retrying ? undefined : onRetry}
          className="rounded-md border px-3 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
          style={{ borderColor: errorTone.border }}
        >
          {retrying ? "Retrying..." : "Retry report"}
        </button>
        <button
          type="button"
          onClick={onReviewData}
          className="rounded-md border px-3 py-1.5 text-xs font-semibold"
          style={{ borderColor: errorTone.border }}
        >
          Review data alerts
        </button>
      </div>
    </section>
  );
}
