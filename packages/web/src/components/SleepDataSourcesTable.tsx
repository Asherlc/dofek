import { formatDateMedium, formatDurationMinutes } from "@dofek/format/format";
import {
  formatRecordLocalTime,
  type RecordLocalTimeContext,
} from "@dofek/format/record-local-time";
import { Fragment, useState } from "react";
import { formatSleepProvenance } from "../lib/sleepSource.ts";
import { PaginationControls } from "./PaginationControls.tsx";

export interface SleepDataSourceRow {
  date: string;
  durationMinutes: number | null;
  providerId: string | null;
  sourceName: string | null;
  sourceProviders: string[];
  selectedSessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  localTimeContext: RecordLocalTimeContext;
  overlappingSessions: SleepOverlappingSession[];
  stagingAvailable: boolean;
}

export interface SleepOverlappingSession {
  sessionId: string;
  providerId: string;
  sourceName: string | null;
  sourceProviders: string[];
  localTimeContext: RecordLocalTimeContext;
  startedAt: string;
  endedAt: string | null;
  durationMinutes: number | null;
}

interface SleepDataSourcesTableProps {
  rows: SleepDataSourceRow[];
  loading?: boolean;
}

const PAGE_SIZE = 20;

export function SleepDataSourcesTable({ rows, loading }: SleepDataSourcesTableProps) {
  const [page, setPage] = useState(0);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="animate-pulse space-y-2">
        {["a", "b", "c"].map((id) => (
          <div key={id} className="h-8 bg-surface-solid rounded" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return <p className="text-sm text-dim py-2">No sleep data in this range.</p>;
  }

  const newestFirst = [...rows].reverse();
  const totalPages = Math.ceil(rows.length / PAGE_SIZE);
  const currentPage = Math.min(page, Math.max(totalPages - 1, 0));
  const visibleRows = newestFirst.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-subtle border-b border-border">
              <th className="pb-2 pr-4 font-medium">Night</th>
              <th className="pb-2 pr-4 font-medium">Duration</th>
              <th className="pb-2 pr-4 font-medium">Selected session</th>
              <th className="pb-2 pr-4 font-medium">Stage data</th>
              <th className="pb-2 pr-4 font-medium">Merged sources</th>
              <th className="pb-2 font-medium">Conflicts</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => {
              const { primary, alsoFrom } = formatSleepProvenance(row);
              const rowKey = row.selectedSessionId ?? row.date;
              const detailsId = `sleep-overlaps-${rowKey}`;
              const expanded = expandedRow === rowKey;
              const selectedTime = formatSessionTime(
                row.startedAt,
                row.endedAt,
                row.localTimeContext,
              );
              return (
                <Fragment key={rowKey}>
                  <tr className="border-b border-border/40">
                    <td className="py-2 pr-4 text-foreground whitespace-nowrap">
                      {formatDateMedium(row.date)}
                    </td>
                    <td className="py-2 pr-4 text-muted tabular-nums whitespace-nowrap">
                      {row.durationMinutes != null
                        ? formatDurationMinutes(row.durationMinutes)
                        : "—"}
                    </td>
                    <td className="py-2 pr-4 text-foreground">
                      <div className="whitespace-nowrap">{primary}</div>
                      <div className="text-xs text-subtle whitespace-nowrap">{selectedTime}</div>
                    </td>
                    <td className="py-2 pr-4 text-muted whitespace-nowrap">
                      {row.stagingAvailable ? "Complete" : "Partial"}
                    </td>
                    <td className="py-2 pr-4 text-subtle text-xs whitespace-nowrap">
                      {alsoFrom ?? "—"}
                    </td>
                    <td className="py-2 text-xs whitespace-nowrap">
                      {row.overlappingSessions.length === 0 ? (
                        <span className="text-subtle">None</span>
                      ) : (
                        <button
                          type="button"
                          aria-controls={detailsId}
                          aria-expanded={expanded}
                          className="text-link hover:underline"
                          onClick={() => setExpandedRow(expanded ? null : rowKey)}
                        >
                          Review {row.overlappingSessions.length} overlap
                          {row.overlappingSessions.length === 1 ? "" : "s"}
                        </button>
                      )}
                    </td>
                  </tr>
                  {expanded && (
                    <tr id={detailsId} className="border-b border-border/40">
                      <td colSpan={6} className="pb-3 pt-1">
                        <div className="rounded-lg bg-surface-solid p-3 space-y-2">
                          <p className="text-xs font-medium text-muted">
                            Other canonical sessions that overlap the selected session
                          </p>
                          {row.overlappingSessions.map((session) => {
                            const source = formatSleepProvenance(session);
                            const time = formatSessionTime(
                              session.startedAt,
                              session.endedAt,
                              session.localTimeContext,
                            );
                            return (
                              <div key={session.sessionId} className="text-xs text-foreground">
                                <span className="font-medium">{source.primary}</span>
                                <span className="text-subtle">
                                  {" "}
                                  · {time} ·{" "}
                                  {session.durationMinutes == null
                                    ? "Duration unavailable"
                                    : formatDurationMinutes(session.durationMinutes)}
                                  {source.alsoFrom ? ` · merged with ${source.alsoFrom}` : ""}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <PaginationControls
        page={currentPage}
        pageSize={PAGE_SIZE}
        totalItems={rows.length}
        itemLabel="nights"
        onPageChange={setPage}
      />
    </div>
  );
}

function formatSessionTime(
  startedAt: string,
  endedAt: string | null,
  context: RecordLocalTimeContext,
): string {
  const start = formatRecordLocalTime(startedAt, context, "start");
  if (start === "--") return "Local time unavailable";
  if (endedAt == null) return `${start} – End unavailable`;
  const end = formatRecordLocalTime(endedAt, context, "end");
  return end === "--" ? "Local time unavailable" : `${start} – ${end}`;
}
