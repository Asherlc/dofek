import { formatClimbingWallAngle } from "@dofek/format/climbing-context";
import { formatDateTime } from "@dofek/format/format";
import type { ClimbingLogEntryDetail } from "../../../../../server/src/contracts/climbing-log-contracts.ts";

export function ClimbingLogEntryContext({ entry }: { entry: ClimbingLogEntryDetail }) {
  const angle = formatClimbingWallAngle(entry.wallAngle);
  const recordedAt = entry.chartAnnotations?.[0]?.startedAt;
  return (
    <div className="min-w-0 space-y-0.5 break-words text-xs text-subtle">
      {entry.board && <p>Board: {entry.board.name}</p>}
      {angle && <p>{angle}</p>}
      {recordedAt && (
        <p>
          <time dateTime={recordedAt}>{formatDateTime(recordedAt)}</time>
        </p>
      )}
    </div>
  );
}
