import type { AppRouterOutputs } from "dofek-server/router";

export type JournalTrendEvidence = AppRouterOutputs["journal"]["trends"];

export const emptyJournalTrendEvidence: JournalTrendEvidence = {
  window: {
    startDate: "2026-07-01",
    endDate: "2026-07-30",
    dayCount: 30,
    gapRepresentation: "explicit_daily",
  },
  statement: "No numeric or Yes/No journal observations in this window.",
  uncertainty: {
    status: "unavailable",
    statement: "Uncertainty interval: not available for raw journal observations.",
  },
  series: [],
};
