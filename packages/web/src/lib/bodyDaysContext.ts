import { TIME_RANGE_POLICIES } from "@dofek/stats/time-range";
import { createContext, useContext } from "react";
import type { TimeRangeDays } from "./timeRange.ts";

interface BodyDaysContextValue {
  days: TimeRangeDays;
  description: string;
  setDays: (days: TimeRangeDays) => void;
}

export const BodyDaysContext = createContext<BodyDaysContextValue>({
  days: TIME_RANGE_POLICIES.body.defaultDays,
  description: TIME_RANGE_POLICIES.body.description,
  setDays: () => {},
});

export function useBodyDays(): BodyDaysContextValue {
  return useContext(BodyDaysContext);
}
