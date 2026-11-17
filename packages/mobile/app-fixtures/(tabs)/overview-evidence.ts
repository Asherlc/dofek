import type { HealthStatusMetric } from "dofek-server/mobile-dashboard-contracts";
import type { ComponentProps } from "react";
import type { OverviewEvidence } from "../../components/OverviewEvidence";

function sampleMetric(
  metric: HealthStatusMetric["metric"],
  label: string,
  value: number,
  valueText: string | null,
): HealthStatusMetric {
  return {
    metric,
    label,
    value,
    valueText,
    baseline: value,
    baselineText: valueText,
    sampleDeviation: 1,
    deviation: 0,
    direction: "near",
    intent: "neutral",
    statusToken: "near_baseline",
    statusColor: "positive",
    statusLabel: "Near baseline",
    evaluationRule: "The measurement is close to your usual range.",
    explanation: "The most recent measurement was near your baseline.",
    baselineProgress: {
      requiredObservationDays: 3,
      observedObservationDays: 20,
      hasMeasurableVariation: true,
      blocker: null,
      requirement: "Recent observations with measurable variation.",
      summary: "The baseline is ready.",
      action: "No action needed.",
    },
  };
}

export const overviewEvidenceFixture = {
  insights: {
    isLoading: false,
    data: [
      {
        confidence: "strong",
        type: "correlation",
        effectSize: 0.72,
        action: "Sleep consistency",
        metric: "Heart rate variability",
        message: "Sleep consistency and heart rate variability",
        detail: "Spearman rank correlation across paired days.",
        dataPoints: [
          { date: "2026-11-11", x: 42, y: 48 },
          { date: "2026-11-12", x: 56, y: 52 },
          { date: "2026-11-13", x: 57, y: 51 },
          { date: "2026-11-14", x: 72, y: 60 },
          { date: "2026-11-15", x: 78, y: 65 },
          { date: "2026-11-16", x: 85, y: 68 },
        ],
      },
    ],
  },
  heartRate: {
    isLoading: false,
    data: [57, 56, 56, 54, 53, 52].map((value) => ({
      resting_hr: value,
      resting_hr_mean_7d: value,
    })),
  },
  trends: {
    isLoading: false,
    data: {
      latest_resting_hr: 52,
      restingHeartRateTrendLabel: "below average",
      healthStatus: [
        sampleMetric("hrv", "Heart rate variability", 68, "68 ms"),
        sampleMetric("respiratory_rate", "Respiratory rate", 14, null),
        sampleMetric("steps", "Steps", 7640, "7,640"),
        sampleMetric("sleep_efficiency", "Sleep efficiency", 92, null),
        sampleMetric("resting_heart_rate", "Resting heart rate", 52, null),
      ],
    },
  },
} satisfies Pick<ComponentProps<typeof OverviewEvidence>, "insights" | "heartRate" | "trends">;
