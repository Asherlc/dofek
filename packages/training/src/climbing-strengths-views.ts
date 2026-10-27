/** Available presentations of the server-computed climbing strengths. */
export const CLIMBING_STRENGTHS_VIEWS = [
  { value: "profile", label: "Grade profile" },
  { value: "gaps", label: "Style gaps" },
  { value: "curves", label: "Success curves" },
  { value: "exposure", label: "Exposure map" },
  { value: "pyramids", label: "Grade pyramids" },
  { value: "progress", label: "Progress" },
  { value: "radar", label: "Radar profile" },
] as const;
export type ClimbingStrengthsView = (typeof CLIMBING_STRENGTHS_VIEWS)[number]["value"];

export const CLIMBING_STRENGTHS_PURPOSES = [
  { value: "styles", label: "Styles" },
  { value: "grades", label: "Grades" },
  { value: "progress", label: "Progress" },
] as const;
type ClimbingStrengthsPurpose = (typeof CLIMBING_STRENGTHS_PURPOSES)[number]["value"];

export function climbingStrengthsPurpose(view: ClimbingStrengthsView): ClimbingStrengthsPurpose {
  if (view === "progress") return "progress";
  return view === "profile" || view === "curves" || view === "pyramids" ? "grades" : "styles";
}

export function climbingStrengthsPurposeView(
  purpose: ClimbingStrengthsPurpose,
): ClimbingStrengthsView {
  return purpose === "styles" ? "gaps" : purpose === "grades" ? "profile" : "progress";
}
