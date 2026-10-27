import type { ClimbingWallAngle } from "@dofek/training/climbing-context";
import type {
  Area,
  AttemptOutcome,
  AttemptScope,
  ClimbingLogEntry,
  RopeMethod,
} from "@dofek/training/climbing-log";

export function formatClimbingLocationPath(nodes: readonly Pick<Area, "name">[]): string | null {
  return nodes.length === 0 ? null : nodes.map((node) => node.name).join(" > ");
}

const ropeMethodLabels: Record<RopeMethod, string> = {
  lead: "Lead",
  top_rope: "Top rope",
  follow: "Follow",
  unroped: "Unroped",
};

export function formatClimbingRopeMethod(method: RopeMethod | null): string | null {
  return method === null ? null : ropeMethodLabels[method];
}

export function formatClimbingRecordedOutcome(
  scope: AttemptScope,
  outcome: AttemptOutcome | null,
): string {
  return `${scope === "climb" ? "Whole climb" : "Pitch"} ${outcome ?? "outcome unknown"}`;
}

export function formatClimbingAttemptCount(count: number): string {
  return `${count} recorded ${count === 1 ? "attempt" : "attempts"}`;
}

export function formatClimbingHoldTypes(holdTypes: ClimbingLogEntry["holdTypes"]): string | null {
  return holdTypes === null
    ? null
    : `Hold types: ${holdTypes.map((hold) => hold.replaceAll("_", " ")).join(", ")}`;
}

export function formatClimbingWallAngle(angle: ClimbingWallAngle | null): string | null {
  if (angle === null) return null;
  if ("category" in angle)
    return `Wall angle: ${angle.category.charAt(0).toUpperCase()}${angle.category.slice(1)}`;
  const value = String(angle.value).replace(/^-/, "−");
  return angle.unit === "degrees"
    ? `Wall angle: ${value}°`
    : `Wall angle: ${value} (units unknown)`;
}
