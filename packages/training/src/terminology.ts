export interface TrainingTerminologyEntry {
  readonly plainLabel: string;
  readonly plainDescription: string;
  readonly technicalName: string;
  readonly details: string;
}

/**
 * User-facing names for training metrics. Plain labels belong in headings and
 * chart series; technical names and calculation descriptions belong in details.
 */
export const TRAINING_TERMINOLOGY = {
  intensityDistribution: {
    plainLabel: "Heart-rate zone distribution",
    plainDescription: "Shows how recorded heart-rate time is distributed across effort zones.",
    technicalName: "Karvonen five-zone model",
    details: "Heart-rate time is grouped into five intensity zones using heart-rate reserve.",
  },
  workloadRatio: {
    plainLabel: "Recent-to-baseline workload ratio",
    plainDescription: "Compares recent training load with the latest baseline period.",
    technicalName: "Acute-to-chronic workload ratio (ACWR)",
    details:
      "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
  },
  normalizedPower: {
    plainLabel: "Effort-adjusted power",
    plainDescription: "Power adjusted to reflect the extra effort of variable cycling.",
    technicalName: "Normalized Power",
    details:
      "Uses 30-second rolling average power and fourth-power weighting to represent variable cycling effort.",
  },
  criticalPower: {
    plainLabel: "Sustainable cycling power",
    plainDescription: "Shows the cycling power estimated for longer efforts.",
    technicalName: "Critical Power",
    details:
      "A power-duration model estimates the longer-effort power level and the finite work available above it.",
  },
  anaerobicWorkCapacity: {
    plainLabel: "Short-burst power reserve",
    plainDescription: "Shows the estimated power reserve available for short bursts.",
    technicalName: "W′ (anaerobic work capacity)",
    details:
      "The model's finite work term represents the estimated power reserve above sustainable power.",
  },
  polarization: {
    plainLabel: "Easy-to-hard training balance",
    plainDescription: "Shows the balance of easy, threshold, and high-intensity cycling.",
    valueLabel: "Easy-to-hard balance",
    technicalName: "Polarization Index (Treff three-zone model)",
    details: "Summarizes the recorded distribution of easy, threshold, and high-intensity cycling.",
  },
  monotony: {
    plainLabel: "Training variety and total load",
    plainDescription: "Shows how varied your weekly training load is.",
    valueLabel: "Training variety",
    strainLabel: "Weekly load strain",
    technicalName: "Training Monotony (Foster method)",
    details: "Describes how evenly cycling training load is distributed across each calendar week.",
  },
  gradeAdjustedPace: {
    plainLabel: "Effort-adjusted pace for grade",
    plainDescription: "Shows walking or hiking pace adjusted for slopes.",
    technicalName: "Grade-adjusted pace (Minetti slope-cost model)",
    details: "Adjusts walking or hiking pace for the estimated energy cost of the recorded slope.",
  },
  estimatedOneRepMax: {
    plainLabel: "Estimated single-rep strength",
    plainDescription: "Shows the estimated maximum weight for one repetition.",
    technicalName: "Estimated 1-Rep Max (e1RM)",
    details: "Uses the Epley formula: estimated max = weight × (1 + repetitions ÷ 30).",
  },
} as const satisfies Record<string, TrainingTerminologyEntry & Record<string, string>>;
