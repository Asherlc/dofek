import type { ClimbingStrengthsDisplayPanel } from "./climbing-strengths.ts";

const dimensions = { wall_angle: "Wall angle", hold_type: "Hold type", setting: "Setting" };

export function climbingStrengthsPanelLabel(panel: ClimbingStrengthsDisplayPanel): string {
  return panel.dimension === "tag" ? panel.category.label : dimensions[panel.dimension];
}

export function climbingStrengthsBreakdownKey(panel: ClimbingStrengthsDisplayPanel): string {
  return panel.dimension === "tag"
    ? JSON.stringify(["tag", panel.category.providerId, panel.category.key])
    : panel.dimension;
}

export function climbingStrengthsObserved(panel: ClimbingStrengthsDisplayPanel): boolean {
  return panel.rows.some((row) => row.cells.some((cell) => cell.sampleStatus !== "no_data"));
}

/** Choose among server-supplied panels without calculating metric values. */
export function climbingStrengthsDefaultBreakdown(panels: ClimbingStrengthsDisplayPanel[]): string {
  const panel =
    panels.find((panel) => panel.dimension === "wall_angle" && climbingStrengthsObserved(panel)) ??
    panels.find((panel) => panel.dimension === "hold_type" && climbingStrengthsObserved(panel)) ??
    panels.find((panel) => panel.dimension === "tag" && climbingStrengthsObserved(panel)) ??
    panels.find((panel) => panel.dimension !== "setting");
  return panel ? climbingStrengthsBreakdownKey(panel) : "wall_angle";
}

export function climbingStrengthsBreakdownOptions(panels: ClimbingStrengthsDisplayPanel[]) {
  const options = new Map<string, { key: string; label: string; providerId: string | null }>([
    ["wall_angle", { key: "wall_angle", label: "Wall angle", providerId: null }],
    ["hold_type", { key: "hold_type", label: "Hold type", providerId: null }],
  ]);
  for (const panel of panels) {
    if (panel.dimension !== "tag" || !climbingStrengthsObserved(panel)) continue;
    const key = climbingStrengthsBreakdownKey(panel);
    options.set(key, { key, label: panel.category.label, providerId: panel.category.providerId });
  }
  return [...options.values()];
}
