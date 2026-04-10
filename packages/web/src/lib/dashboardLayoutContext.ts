import { createContext, useContext } from "react";

export interface DashboardLayout {
  order: string[];
  hidden: string[];
  collapsed: Record<string, boolean>;
}

const DEFAULT_ORDER = [
  "healthMonitor",
  "topInsights",
  "strain",
  "weeklyReport",
  "nextWorkout",
  "sleepNeed",
  "stress",
  "healthspan",
  "hrvRhr",
  "spo2Temp",
  "steps",
  "sleep",
  "nutrition",
  "bodyComp",
] as const;

export const DEFAULT_LAYOUT: DashboardLayout = {
  order: [...DEFAULT_ORDER],
  hidden: [],
  collapsed: { bodyComp: true },
};

export const SECTION_LABELS: Record<string, string> = {
  healthMonitor: "Health Monitor",
  topInsights: "Top Insights",
  strain: "Strain",
  weeklyReport: "Weekly Performance",
  nextWorkout: "Next Workout",
  sleepNeed: "Sleep Coach",
  stress: "Stress Monitor",
  healthspan: "Healthspan",
  hrvRhr: "Heart Rate Variability & Resting HR",
  spo2Temp: "SpO2 & Skin Temperature",
  steps: "Daily Steps",
  sleep: "Sleep",
  nutrition: "Nutrition",
  bodyComp: "Body Composition",
};

interface DashboardLayoutContextValue {
  layout: DashboardLayout;
  setOrder: (order: string[]) => void;
  toggleHidden: (id: string) => void;
  toggleCollapsed: (id: string) => void;
  moveSection: (id: string, direction: "up" | "down") => void;
  resetLayout: () => void;
}

export const DashboardLayoutContext = createContext<DashboardLayoutContextValue>({
  layout: DEFAULT_LAYOUT,
  setOrder: () => {},
  toggleHidden: () => {},
  toggleCollapsed: () => {},
  moveSection: () => {},
  resetLayout: () => {},
});

export function useDashboardLayout(): DashboardLayoutContextValue {
  return useContext(DashboardLayoutContext);
}
