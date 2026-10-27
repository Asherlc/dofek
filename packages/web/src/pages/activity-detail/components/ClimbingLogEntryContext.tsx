import { formatClimbingWallAngle } from "@dofek/format/climbing-context";
import type { ClimbingLogEntryDetail } from "../../../../../server/src/contracts/climbing-log-contracts.ts";

export function ClimbingLogEntryContext({ entry }: { entry: ClimbingLogEntryDetail }) {
  const angle = formatClimbingWallAngle(entry.wallAngle);
  return (
    <div className="min-w-0 space-y-0.5 break-words text-xs text-subtle">
      {entry.board && <p>Board: {entry.board.name}</p>}
      {angle && <p>{angle}</p>}
    </div>
  );
}
