import { Link } from "@tanstack/react-router";
import { decodeClimbingLogEntryDetailResponse } from "../../../server/src/contracts/climbing-log-contracts.ts";
import { ClimbingLogEntryDetails } from "../components/ClimbingLogEntryDetails.tsx";
import { ModalDialog, ModalDialogTitle } from "../components/ModalDialog.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { formatCellValue, formatColumnName } from "./provider-detail-format.ts";

export function RecordDetailModal({
  state,
  dataType,
  onClose,
  activityId,
}: {
  state: { data: Record<string, unknown> | null | undefined; error: unknown; isLoading: boolean };
  dataType: string;
  onClose: () => void;
  activityId?: string;
}) {
  const record = state.data;
  const climbingLog =
    dataType === "climbingLogEntries" && record
      ? decodeClimbingLogEntryDetailResponse(record)
      : null;
  const rawValue = record?.raw;
  const raw = typeof rawValue === "object" && rawValue !== null ? rawValue : null;
  const fields = Object.entries(record ?? {}).filter(([key]) => key !== "raw" && key !== "user_id");
  const populatedFields = fields.filter(([, value]) => value !== null && value !== undefined);
  const nullFields = fields.filter(([, value]) => value === null || value === undefined);

  return (
    <ModalDialog
      open
      onClose={onClose}
      closeOnInteractOutside
      contentClassName="bg-surface-solid border border-border-strong rounded-xl p-6 w-[calc(100%-2rem)] max-w-4xl max-h-[90vh] overflow-y-auto shadow-2xl"
    >
      <div className="flex items-center justify-between mb-4">
        <ModalDialogTitle className="text-sm font-semibold text-foreground">
          Record Detail
        </ModalDialogTitle>
        <button
          type="button"
          onClick={onClose}
          className="text-subtle hover:text-foreground text-lg leading-none p-1"
          aria-label="Close"
        >
          &times;
        </button>
      </div>
      {state.error ? <QueryStatePanel error={state.error} height={80} /> : null}
      {state.isLoading && record === undefined ? (
        <QueryStatePanel variant="loading" height={80} />
      ) : null}
      {record == null && !state.isLoading && !state.error ? (
        <p>This record is no longer available. Refresh the records list.</p>
      ) : null}
      {activityId && (
        <Link
          to="/activity/$id"
          params={{ id: activityId }}
          className="inline-flex mb-4 text-xs font-medium text-accent hover:text-accent-secondary"
        >
          Open activity
        </Link>
      )}
      {record &&
        (climbingLog ? (
          <ClimbingLogEntryDetails entry={climbingLog} />
        ) : (
          <>
            <div className="mb-4">
              <h4 className="text-xs font-medium text-muted uppercase tracking-wider mb-2">
                Fields
              </h4>
              <div className="rounded-lg border border-border bg-page divide-y divide-border/50">
                {populatedFields.map(([key, value]) => (
                  <div key={key} className="flex gap-4 px-3 py-1.5 text-xs">
                    <span className="text-subtle shrink-0 w-48">{formatColumnName(key)}</span>
                    <span className="text-foreground break-all whitespace-pre-wrap min-w-0">
                      {formatCellValue(value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            {nullFields.length > 0 && (
              <details className="mb-4">
                <summary className="text-xs font-medium text-subtle uppercase tracking-wider mb-2 cursor-pointer hover:text-muted">
                  Empty Fields ({nullFields.length})
                </summary>
                <div className="text-xs text-dim flex flex-wrap gap-x-4 gap-y-0.5 mt-1">
                  {nullFields.map(([key]) => (
                    <span key={key}>{formatColumnName(key)}</span>
                  ))}
                </div>
              </details>
            )}
            {raw && (
              <details open>
                <summary className="text-xs font-medium text-muted uppercase tracking-wider mb-2 cursor-pointer hover:text-foreground">
                  Raw Provider Data
                </summary>
                <pre className="text-xs text-muted bg-page rounded-lg p-3 overflow-x-auto overflow-y-auto max-h-[60vh]">
                  {JSON.stringify(raw, null, 2)}
                </pre>
              </details>
            )}
          </>
        ))}
    </ModalDialog>
  );
}
