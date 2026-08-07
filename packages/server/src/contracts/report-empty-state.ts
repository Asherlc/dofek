import { z } from "zod";

export type ReportKind = "weekly" | "monthly";

interface ReportEmptyStateBase {
  message: string;
  minimumObservedDays: 1;
  acceptedDataTypes: readonly ["activity", "sleep", "recovery"];
  requirement: string;
  previewTitle: string;
  previewItems: readonly string[];
  note: string;
}

export interface WeeklyReportEmptyState extends ReportEmptyStateBase {
  reportKind: "weekly";
  title: string;
}

export interface MonthlyReportEmptyState extends ReportEmptyStateBase {
  reportKind: "monthly";
  title: string;
}

export type ReportEmptyState = WeeklyReportEmptyState | MonthlyReportEmptyState;

const acceptedDataTypesSchema = z.tuple([
  z.literal("activity"),
  z.literal("sleep"),
  z.literal("recovery"),
]);

const reportEmptyStateBaseSchema = z.object({
  message: z.string(),
  minimumObservedDays: z.literal(1),
  acceptedDataTypes: acceptedDataTypesSchema,
  requirement: z.string(),
  previewTitle: z.string(),
  previewItems: z.array(z.string()),
  note: z.string(),
});

export const weeklyReportEmptyStateSchema = reportEmptyStateBaseSchema.extend({
  reportKind: z.literal("weekly"),
  title: z.string(),
});

export const monthlyReportEmptyStateSchema = reportEmptyStateBaseSchema.extend({
  reportKind: z.literal("monthly"),
  title: z.string(),
});

export function reportEmptyStateSchema(reportKind: "weekly"): typeof weeklyReportEmptyStateSchema;
export function reportEmptyStateSchema(reportKind: "monthly"): typeof monthlyReportEmptyStateSchema;
export function reportEmptyStateSchema(reportKind: ReportKind) {
  return reportKind === "weekly" ? weeklyReportEmptyStateSchema : monthlyReportEmptyStateSchema;
}

const sharedEmptyState = {
  message: "No activity, sleep, or recovery data is available for this report yet.",
  minimumObservedDays: 1,
  acceptedDataTypes: ["activity", "sleep", "recovery"],
  note: "This preview shows report sections only. No personal values or conclusions are estimated.",
} as const;

export function createReportEmptyState(reportKind: "weekly"): WeeklyReportEmptyState;
export function createReportEmptyState(reportKind: "monthly"): MonthlyReportEmptyState;
export function createReportEmptyState(reportKind: ReportKind): ReportEmptyState {
  if (reportKind === "weekly") {
    return {
      ...sharedEmptyState,
      reportKind,
      title: "Your weekly report will appear here",
      requirement:
        "At least 1 observed day of activity, sleep, or recovery data is required to create a weekly report.",
      previewTitle: "When ready, your weekly report will include",
      previewItems: [
        "Training time and activity count",
        "Average nightly sleep",
        "Average resting heart rate",
        "Average heart rate variability",
        "Recent week comparisons",
      ],
    };
  }

  return {
    ...sharedEmptyState,
    reportKind,
    title: "Your monthly report will appear here",
    requirement:
      "At least 1 observed day of activity, sleep, or recovery data is required to create a monthly report.",
    previewTitle: "When ready, your monthly report will include",
    previewItems: [
      "Training time and activity count",
      "Average daily strain",
      "Average sleep duration",
      "Average resting heart rate",
      "Average heart rate variability",
      "Month-over-month training and sleep changes",
    ],
  };
}

export const weeklyReportEmptyState = createReportEmptyState("weekly");
export const monthlyReportEmptyState = createReportEmptyState("monthly");
