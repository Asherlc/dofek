import { z } from "zod";

export type ReportKind = "weekly" | "monthly";

interface ReportEmptyStateBase {
  minimumObservedDays: 1;
  acceptedDataTypes: readonly ["activity", "sleep", "recovery"];
  requirement: string;
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
  minimumObservedDays: z.literal(1),
  acceptedDataTypes: acceptedDataTypesSchema,
  requirement: z.string(),
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
  minimumObservedDays: 1,
  acceptedDataTypes: ["activity", "sleep", "recovery"],
} as const;

export function createReportEmptyState(reportKind: "weekly"): WeeklyReportEmptyState;
export function createReportEmptyState(reportKind: "monthly"): MonthlyReportEmptyState;
export function createReportEmptyState(reportKind: ReportKind): ReportEmptyState {
  if (reportKind === "weekly") {
    return {
      ...sharedEmptyState,
      reportKind,
      title: "No weekly report for this period.",
      requirement:
        "Sync at least one day of activity, sleep, or recovery data from this period to create a report.",
    };
  }

  return {
    ...sharedEmptyState,
    reportKind,
    title: "No monthly report for this period.",
    requirement:
      "Sync at least one day of activity, sleep, or recovery data from this period to create a report.",
  };
}

export const weeklyReportEmptyState = createReportEmptyState("weekly");
export const monthlyReportEmptyState = createReportEmptyState("monthly");
