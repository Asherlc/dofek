import type { Meta, StoryObj } from "@storybook/react-vite";
import type { MicronutrientSafetyReviewRow } from "../../../server/src/routers/nutrition-analytics.ts";
import { MicronutrientChart } from "./MicronutrientChart.tsx";

const data: MicronutrientSafetyReviewRow[] = [
  {
    nutrientId: "vitamin_d",
    nutrient: "Vitamin D",
    unit: "mcg",
    intake: {
      totalDailyAverage: 120,
      foodDailyAverage: 20,
      providerDailyTotalAverage: 0,
      supplementDailyAverage: 100,
      daysTracked: 28,
    },
    sourceBreakdown: [
      {
        providerId: "manual",
        sourceLabel: "Manual",
        intakeType: "itemized_food",
        dailyAverageContribution: 20,
        daysTracked: 28,
      },
      {
        providerId: "dofek",
        sourceLabel: "Dofek supplements",
        intakeType: "supplement",
        dailyAverageContribution: 100,
        daysTracked: 28,
      },
    ],
    adequacy: {
      status: "at_or_above_daily_value",
      percentDailyValue: 600,
      message:
        "Average intake over recorded days meets or exceeds the FDA Daily Value. This generic label reference is not a personalized safety assessment.",
      reference: {
        type: "daily_value",
        amount: 20,
        unit: "mcg",
        population: "Adults and children age 4+",
        source: {
          agency: "FDA",
          title: "Daily Value on the Nutrition and Supplement Facts Labels",
          url: "https://www.fda.gov/food/nutrition-facts-label/daily-value-nutrition-and-supplement-facts-labels",
          reviewedOn: "2026-07-27",
        },
      },
    },
    upperLimit: {
      status: "at_or_above_limit",
      amount: 100,
      unit: "mcg",
      intakeScope: "total",
      population: "U.S. adults age 19+",
      nutrientForm: "all tracked forms",
      intakeAmount: 120,
      source: {
        agency: "NIH ODS",
        title: "Vitamin D - Health Professional Fact Sheet",
        url: "https://ods.od.nih.gov/factsheets/VitaminD-HealthProfessional/",
        reviewedOn: "2026-07-27",
      },
      message:
        "Average intake over recorded days is at or above the included NIH adult upper limit. Review this intake with a doctor or pharmacist.",
    },
    safetyStatus: "at_or_above_upper_limit",
  },
];

const meta = {
  title: "Nutrition/MicronutrientChart",
  component: MicronutrientChart,
  args: { data, selectedWindowDays: 30 },
  decorators: [
    (Story) => (
      <div className="w-[760px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MicronutrientChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { loading: true } };
export const Empty: Story = { args: { data: [] } };
