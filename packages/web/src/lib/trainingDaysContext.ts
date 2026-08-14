import { createContext, useContext } from "react";
import type { TimeRangeDays } from "./timeRange.ts";

interface TrainingDaysContextValue {
  days: TimeRangeDays;
  setDays: (days: TimeRangeDays) => void;
}

export const TrainingDaysContext = createContext<TrainingDaysContextValue>({
  days: 180,
  setDays: () => {},
});

export function useTrainingDays(): TrainingDaysContextValue {
  return useContext(TrainingDaysContext);
}
