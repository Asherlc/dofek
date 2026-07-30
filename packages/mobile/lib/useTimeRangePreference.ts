import {
  parseTimeRangePreference,
  serializeTimeRangePreference,
  TIME_RANGE_POLICIES,
  type TimeRangeDomain,
  timeRangePreferenceKey,
} from "@dofek/stats/time-range";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";
import { captureException } from "./telemetry";

export function useTimeRangePreference(domain: TimeRangeDomain): {
  days: number;
  defaultDays: number;
  description: string;
  isHydrated: boolean;
  setDays: (days: number) => void;
} {
  const policy = TIME_RANGE_POLICIES[domain];
  const storageKey = timeRangePreferenceKey(domain);
  const [days, setDaysState] = useState<number>(policy.defaultDays);
  const [hydratedDomain, setHydratedDomain] = useState<TimeRangeDomain | null>(null);

  useEffect(() => {
    let active = true;
    setDaysState(policy.defaultDays);
    setHydratedDomain(null);

    void AsyncStorage.getItem(storageKey)
      .then((persistedValue) => {
        const restoredDays = parseTimeRangePreference(persistedValue, policy.defaultDays);
        if (active) {
          setDaysState(restoredDays ?? policy.defaultDays);
        }
      })
      .catch((error: unknown) => {
        captureException(error, { source: "time-range-preference-read", domain });
      })
      .finally(() => {
        if (active) {
          setHydratedDomain(domain);
        }
      });

    return () => {
      active = false;
    };
  }, [domain, policy.defaultDays, storageKey]);

  const setDays = useCallback(
    (nextDays: number) => {
      setDaysState(nextDays);
      void AsyncStorage.setItem(storageKey, serializeTimeRangePreference(nextDays)).catch(
        (error: unknown) => {
          captureException(error, { source: "time-range-preference-write", domain });
        },
      );
    },
    [domain, storageKey],
  );

  return {
    days,
    defaultDays: policy.defaultDays,
    description: policy.description,
    isHydrated: hydratedDomain === domain,
    setDays,
  };
}
