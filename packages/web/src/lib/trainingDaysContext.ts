import { createContext, useContext } from "react";

interface TrainingDaysContextValue {
  days: number;
  setDays: (days: number) => void;
}

export const TrainingDaysContext = createContext<TrainingDaysContextValue>({
  days: 180,
  setDays: () => {},
});

export function useTrainingDays(): TrainingDaysContextValue {
  return useContext(TrainingDaysContext);
}
