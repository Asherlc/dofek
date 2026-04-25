import { formatDateYmd } from "@dofek/format/format";
import { useEffect, useState } from "react";

function formatQueryDate(date: Date = new Date()): string {
  return formatDateYmd(date);
}

function getMillisecondsUntilNextLocalMidnight(now: Date): number {
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 0, 50);
  return nextMidnight.getTime() - now.getTime();
}

export function useTodayQueryDate(): string {
  const [todayQueryDate, setTodayQueryDate] = useState(() => formatQueryDate());

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const scheduleUpdate = () => {
      timeoutId = setTimeout(() => {
        setTodayQueryDate(formatQueryDate());
        scheduleUpdate();
      }, getMillisecondsUntilNextLocalMidnight(new Date()));
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
