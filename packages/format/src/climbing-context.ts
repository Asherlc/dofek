import type {
  ClimbingLocationNode,
  ClimbingStyle,
  ClimbingWallAngle,
} from "@dofek/training/climbing-context";

export function formatClimbingLocationPath(nodes: readonly ClimbingLocationNode[]): string | null {
  return nodes.length === 0 ? null : nodes.map((node) => node.name).join(" > ");
}

const styleLabels: Record<ClimbingStyle, string> = {
  lead: "Lead",
  "top-rope": "Top rope",
  follow: "Follow",
  solo: "Solo",
  aid: "Aid",
};

export function formatClimbingStyle(style: ClimbingStyle | null): string | null {
  return style === null ? null : styleLabels[style];
}

export function formatClimbingResultStyle(result: string | null): string {
  if (result === null) return "Result unknown";
  return result.toLowerCase() === "fell/hung" ? "Fell or hung" : result;
}

export function formatClimbingWallAngle(angle: ClimbingWallAngle | null): string | null {
  if (angle === null) return null;
  const value = String(angle.value).replace(/^-/, "−");
  return angle.unit === "degrees"
    ? `Wall angle: ${value}°`
    : `Wall angle: ${value} (units unknown)`;
}
