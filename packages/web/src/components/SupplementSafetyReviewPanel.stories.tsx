import type { Meta, StoryObj } from "@storybook/react-vite";
import type { MicronutrientSafetyReviewResult } from "../../../server/src/routers/nutrition-analytics.ts";
import { SupplementSafetyReviewPanel } from "./SupplementSafetyReviewPanel.tsx";

const review: MicronutrientSafetyReviewResult = {
  nutrients: [
    {
      nutrientId: "magnesium",
      nutrient: "Magnesium",
      unit: "mg",
      intake: {
        totalDailyAverage: 610,
        foodDailyAverage: 240,
        providerDailyTotalAverage: 0,
        supplementDailyAverage: 370,
        daysTracked: 21,
      },
      sourceBreakdown: [],
      adequacy: null,
      upperLimit: {
        status: "at_or_above_limit",
        amount: 350,
        unit: "mg",
        intakeScope: "supplemental_only",
        population: "U.S. adults age 19+",
        nutrientForm: "all tracked forms",
        intakeAmount: 370,
        source: {
          agency: "NIH ODS",
          title: "Magnesium - Health Professional Fact Sheet",
          url: "https://ods.od.nih.gov/factsheets/Magnesium-HealthProfessional/",
          reviewedOn: "2026-07-27",
        },
        message:
          "Average intake over recorded days is at or above the included NIH adult upper limit. Review this intake with a doctor or pharmacist.",
      },
      safetyStatus: "at_or_above_upper_limit",
    },
  ],
  dataQuality: {
    selectedWindowDays: 30,
    daysWithData: 21,
    usableDays: 21,
    overlapDays: 0,
    conflictDays: 0,
    completenessPercent: 70,
    sourceLabels: ["Dofek supplements"],
    contributingSourceLabels: ["Dofek supplements"],
    excludedSourceLabels: [],
  },
  professionalReview: {
    status: "professional_review_recommended",
    message:
      "Review your complete medication and supplement list with a doctor or pharmacist because supplements can interact with medications.",
    limitation: "Dofek does not determine whether a specific medication and supplement interact.",
    source: {
      agency: "FDA",
      title: "Mixing Medications and Dietary Supplements Can Endanger Your Health",
      url: "https://www.fda.gov/consumers/consumer-updates/mixing-medications-and-dietary-supplements-can-endanger-your-health",
      reviewedOn: "2026-07-27",
    },
  },
};

const meta = {
  title: "Nutrition/SupplementSafetyReviewPanel",
  component: SupplementSafetyReviewPanel,
  args: { review },
  decorators: [
    (Story) => (
      <div className="w-[720px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SupplementSafetyReviewPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ReviewRecommended: Story = {};
