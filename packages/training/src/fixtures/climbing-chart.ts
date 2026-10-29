import type { ClimbingChartAnnotation } from "../climbing-chart.ts";

/** Demo timing includes a bounded climb to exercise range rendering. */
export const climbingChartAnnotations: ClimbingChartAnnotation[] = [
  { id: "corner", label: "Corner · V3", startedAt: "2026-10-04T16:53:10Z", endedAt: null },
  {
    id: "arete",
    label: "Arete · V4",
    startedAt: "2026-10-04T16:53:40Z",
    endedAt: "2026-10-04T16:54:15Z",
  },
  { id: "corner-repeat", label: "Corner · V3", startedAt: "2026-10-04T16:54:40Z", endedAt: null },
];
