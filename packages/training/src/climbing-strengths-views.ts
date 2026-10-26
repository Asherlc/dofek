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
