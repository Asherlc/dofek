import type { Meta, StoryObj } from "@storybook/react-vite";
import type { InsightEvidence } from "dofek-server/types";
import { CorrelationCard } from "./CorrelationCard";

const conditionalEvidence: InsightEvidence = {
  relationship: "descriptive_association",
  label: "Descriptive association",
  method:
    "Observed-group mean comparison (with versus without the behavior); candidate differences use Welch's t-test with Benjamini–Hochberg screening.",
  interpretation:
    "This observational association does not establish that the behavior caused the outcome.",
  limitations:
    "The displayed counts are the observed groups; missing observations and unmeasured confounders may affect this estimate. No confidence interval is available for this exploratory comparison.",
  recommendation: "This is not a prescription or recommendation to change the behavior.",
  estimateLabel: "15% lower",
};

const correlationEvidence: InsightEvidence = {
  relationship: "correlation",
  label: "Descriptive correlation",
  method: "Spearman rank correlation over paired observations with Benjamini–Hochberg screening.",
  interpretation:
    "This correlation describes co-movement in the observed data; it does not establish causation.",
  limitations:
    "The displayed n is the number of paired observations; missing observations and unmeasured confounders may affect this estimate. No confidence interval is available for this exploratory correlation.",
  recommendation: "Use this as a hypothesis, not a prescription or treatment recommendation.",
};

const meta = {
  title: "Insights/CorrelationCard",
  component: CorrelationCard,
  tags: ["autodocs"],
  args: {
    insight: {
      id: "insight-1",
      type: "conditional",
      confidence: "strong",
      metric: "Heart Rate Variability (HRV)",
      action: "Journal: Alcohol",
      message:
        "Observed association: heart rate variability was 15% lower on days after consuming alcohol.",
      detail: "Based on 42 days of data (p < 0.01).",
      whenTrue: { mean: 52, n: 12 },
      whenFalse: { mean: 61, n: 30 },
      effectSize: -0.45,
      pValue: 0.002,
      evidence: conditionalEvidence,
      confounders: ["Late bedtime", "Dehydration"],
    },
  },
} satisfies Meta<typeof CorrelationCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ConditionalSuccess: Story = {};

export const EmergingSignal: Story = {
  args: {
    insight: {
      id: "insight-2",
      type: "correlation",
      confidence: "emerging",
      metric: "Deep Sleep",
      action: "Caffeine",
      message: "Higher caffeine intake is associated with less deep sleep.",
      detail: "Spearman rho = -0.32 (n=28).",
      whenTrue: { mean: 0, n: 28 }, // n is used for footer
      whenFalse: { mean: 0, n: 0 },
      effectSize: -0.32,
      pValue: 0.08,
      evidence: correlationEvidence,
      dataPoints: [
        { x: 20, y: 115, date: "2026-03-01" },
        { x: 40, y: 118, date: "2026-03-02" },
        { x: 60, y: 112, date: "2026-03-03" },
        { x: 80, y: 110, date: "2026-03-04" },
        { x: 100, y: 108, date: "2026-03-05" },
        { x: 120, y: 106, date: "2026-03-06" },
        { x: 140, y: 104, date: "2026-03-07" },
        { x: 160, y: 102, date: "2026-03-08" },
        { x: 180, y: 100, date: "2026-03-09" },
        { x: 200, y: 98, date: "2026-03-10" },
        { x: 220, y: 96, date: "2026-03-11" },
        { x: 240, y: 94, date: "2026-03-12" },
        { x: 260, y: 92, date: "2026-03-13" },
        { x: 280, y: 90, date: "2026-03-14" },
        { x: 300, y: 88, date: "2026-03-15" },
        { x: 320, y: 86, date: "2026-03-16" },
        { x: 340, y: 84, date: "2026-03-17" },
        { x: 360, y: 82, date: "2026-03-18" },
        { x: 380, y: 80, date: "2026-03-19" },
        { x: 400, y: 78, date: "2026-03-20" },
      ],
    },
  },
};

export const NonZeroBasedRange: Story = {
  args: {
    insight: {
      id: "insight-non-zero-range",
      type: "correlation",
      confidence: "emerging",
      metric: "Monthly body fat change",
      action: "Monthly exercise volume",
      message: "Monthly exercise volume is negatively associated with monthly body fat change.",
      detail: "Spearman rho = -0.73 (n=19).",
      whenTrue: { mean: 0, n: 19 },
      whenFalse: { mean: 0, n: 0 },
      effectSize: -0.73,
      pValue: 0.01,
      evidence: correlationEvidence,
      dataPoints: [
        { x: 2_920, y: -0.1, date: "2025-01" },
        { x: 3_080, y: -0.3, date: "2025-02" },
        { x: 3_260, y: -0.8, date: "2025-03" },
        { x: 3_480, y: -1.0, date: "2025-04" },
        { x: 3_800, y: -0.9, date: "2025-05" },
      ],
    },
  },
};

export const Discovery: Story = {
  args: {
    insight: {
      id: "insight-3",
      type: "conditional",
      confidence: "early",
      metric: "Ready Score",
      action: "Journal: Magnesium",
      message: "Observed association: readiness was higher on days when Magnesium was logged.",
      detail: "Early signal based on 10 entries.",
      whenTrue: { mean: 82, n: 4 },
      whenFalse: { mean: 75, n: 6 },
      effectSize: 0.25,
      pValue: 0.15,
      evidence: { ...conditionalEvidence, estimateLabel: "9.3% higher" },
    },
  },
};
