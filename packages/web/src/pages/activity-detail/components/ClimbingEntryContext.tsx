import {
  formatClimbingLocationPath,
  formatClimbingResultStyle,
  formatClimbingStyle,
  formatClimbingWallAngle,
} from "@dofek/format/climbing-context";
import type { ClimbingContext } from "@dofek/training/climbing-context";

export function ClimbingEntryContext({
  context,
  sent,
}: {
  context: ClimbingContext;
  sent: boolean | null;
}) {
  const location = formatClimbingLocationPath(context.locationPath);
  const method = formatClimbingStyle(context.climbStyle);
  const angle = formatClimbingWallAngle(context.wallAngle);
  return (
    <div className="min-w-0 space-y-0.5 break-words text-xs text-subtle">
      {location && <p>{location}</p>}
      {context.board && <p>Board: {context.board.name}</p>}
      {angle && <p>{angle}</p>}
      {method && <p>{method}</p>}
      <p className={sent === true ? "font-medium text-green-500" : "text-subtle"}>
        {formatClimbingResultStyle(context.resultStyle)}
      </p>
    </div>
  );
}
