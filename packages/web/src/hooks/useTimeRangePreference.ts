import {
  parseTimeRangePreference,
  serializeTimeRangePreference,
  TIME_RANGE_POLICIES,
  type TimeRangeDays,
  type TimeRangeDomain,
  timeRangePreferenceKey,
} from "@dofek/stats/time-range";
import { useCallback, useState } from "react";
import { captureException } from "../lib/telemetry.ts";

export function useTimeRangePreference(domain: TimeRangeDomain): {
  days: TimeRangeDays;
  defaultDays: number;
  description: string;
  setDays: (days: TimeRangeDays) => void;
} {
  const policy = TIME_RANGE_POLICIES[domain];
  const storageKey = timeRangePreferenceKey(domain);
  const [days, setDaysState] = useState<TimeRangeDays>(() => {
    if (typeof window === "undefined") {
      return policy.defaultDays;
    }

    try {
      return parseTimeRangePreference(window.localStorage.getItem(storageKey), policy.defaultDays);
    } catch (error) {
      captureException(error, { source: "time-range-preference-read", domain });
      return policy.defaultDays;
    }
  });

  const setDays = useCallback(
    (nextDays: TimeRangeDays) => {
      setDaysState(nextDays);
      try {
        window.localStorage.setItem(storageKey, serializeTimeRangePreference(nextDays));
      } catch (error) {
        captureException(error, { source: "time-range-preference-write", domain });
      }
    },
    [domain, storageKey],
  );

  return {
    days,
    defaultDays: policy.defaultDays,
    description: policy.description,
    setDays,
  };
}
