/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MicronutrientSafetyReviewResult } from "../../../server/src/routers/nutrition-analytics.ts";
import { SupplementSafetyReviewPanel } from "./SupplementSafetyReviewPanel.tsx";

const review: MicronutrientSafetyReviewResult = {
  nutrients: [
    {
      nutrientId: "vitamin_d",
      nutrient: "Vitamin D",
      unit: "mcg",
      intake: {
        totalDailyAverage: 120,
        foodDailyAverage: 20,
        providerDailyTotalAverage: 0,
        supplementDailyAverage: 100,
        daysTracked: 10,
      },
      sourceBreakdown: [],
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
        intakeAmount: 120,
        intakeScope: "total",
        population: "U.S. adults age 19+",
        nutrientForm: "all tracked forms",
        message:
          "Average intake over recorded days is at or above the included NIH adult upper limit. Review this intake with a doctor or pharmacist.",
        source: {
          agency: "NIH ODS",
          title: "Vitamin D - Health Professional Fact Sheet",
          url: "https://ods.od.nih.gov/factsheets/VitaminD-HealthProfessional/",
          reviewedOn: "2026-07-27",
        },
      },
      safetyStatus: "at_or_above_upper_limit",
    },
  ],
  dataQuality: {
    selectedWindowDays: 30,
    daysWithData: 10,
    usableDays: 10,
    overlapDays: 0,
    conflictDays: 0,
    completenessPercent: 33.3,
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

describe("SupplementSafetyReviewPanel", () => {
  it("renders server-owned upper-limit and professional-review guidance", () => {
    render(<SupplementSafetyReviewPanel review={review} />);

    expect(screen.getByText("Vitamin D")).toBeTruthy();
    expect(screen.getByText(/at or above the included NIH adult upper limit/)).toBeTruthy();
    expect(screen.getByText(/average from supplements over 10 recorded days/)).toBeTruthy();
    expect(screen.getByText(/complete medication and supplement list/)).toBeTruthy();
    expect(screen.getByText(/does not determine whether a specific medication/)).toBeTruthy();
    expect(screen.queryByText(/safe/i)).toBeNull();
    expect(screen.getByRole("link", { name: /NIH ODS source/ })).toHaveAttribute(
      "href",
      "https://ods.od.nih.gov/factsheets/VitaminD-HealthProfessional/",
    );
  });
});
