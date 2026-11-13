/** Available presentations of the server-computed climbing strengths. */
export const CLIMBING_STRENGTHS_VIEWS = [
  { value: "gaps", label: "Style gaps" },
  { value: "curves", label: "Send rate across grades" },
  { value: "exposure", label: "Exposure map" },
  { value: "pyramids", label: "Grade pyramids" },
  { value: "progress", label: "Monthly send rate" },
  { value: "radar", label: "Radar profile" },
] as const;
export type ClimbingStrengthsView = (typeof CLIMBING_STRENGTHS_VIEWS)[number]["value"];

export const CLIMBING_STRENGTHS_TABS = [
  { value: "radar", label: "Styles" },
  { value: "progress", label: "Progress" },
] as const;
export type ClimbingStrengthsTab = (typeof CLIMBING_STRENGTHS_TABS)[number]["value"];
