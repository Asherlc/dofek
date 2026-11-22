import { formatDateYmdInTimeZone } from "@dofek/format/format";
import { useEffect, useState } from "react";

function formatQueryDate(date: Date = new Date()): string {
  return formatDateYmdInTimeZone(date, "UTC");
}

function getMillisecondsUntilNextUtcMidnight(now: Date): number {
  const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return nextMidnight - now.getTime();
}

export function useTodayQueryDate(): string {
  const [todayQueryDate, setTodayQueryDate] = useState(() => formatQueryDate());

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const scheduleUpdate = () => {
      timeoutId = setTimeout(() => {
        setTodayQueryDate(formatQueryDate());
        scheduleUpdate();
      }, getMillisecondsUntilNextUtcMidnight(new Date()));
    };

    scheduleUpdate();

    return () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    };
  }, []);

  return todayQueryDate;
}
