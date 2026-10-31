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

/** Server-shaped context around the first and last timed climb. */
export const climbingHeartRateContext = {
  window: { startedAt: "2026-10-04T16:48:10Z", endedAt: "2026-10-04T16:59:40Z" },
  points: [
    { recordedAt: "2026-10-04T16:48:10Z", value: 90 },
    { recordedAt: "2026-10-04T16:50:10Z", value: 95 },
    { recordedAt: "2026-10-04T16:52:10Z", value: 110 },
    { recordedAt: "2026-10-04T16:53:10Z", value: 152 },
    { recordedAt: "2026-10-04T16:54:10Z", value: 140 },
    { recordedAt: "2026-10-04T16:54:40Z", value: 145 },
    { recordedAt: "2026-10-04T16:55:40Z", value: 120 },
    { recordedAt: "2026-10-04T16:57:40Z", value: 105 },
    { recordedAt: "2026-10-04T16:59:40Z", value: 95 },
  ],
};
