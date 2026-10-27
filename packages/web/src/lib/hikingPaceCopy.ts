import { TRAINING_TERMINOLOGY } from "@dofek/training/terminology";

export const HIKING_PACE_COPY = {
  title: TRAINING_TERMINOLOGY.gradeAdjustedPace.plainLabel,
  tableTitle: "Effort-adjusted pace by activity",
  description: "Pace adjusted for the effort of walking or hiking on slopes.",
  technicalName: TRAINING_TERMINOLOGY.gradeAdjustedPace.technicalName,
  methodDetails: TRAINING_TERMINOLOGY.gradeAdjustedPace.details,
  source: {
    title: "Minetti et al. (2002), Energy cost of walking and running",
    url: "https://pubmed.ncbi.nlm.nih.gov/12183501/",
  },
  columnLabel: "Effort-adjusted pace",
  highlightNote:
    "Effort-adjusted pace is highlighted in amber when it differs from actual pace by more than 15%.",
} as const;
