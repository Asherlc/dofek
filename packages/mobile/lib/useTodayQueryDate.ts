import { formatDateYmd } from "@dofek/format/format";
import { useEffect, useState } from "react";
import { AppState } from "react-native";

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

    const refresh = () => {
      setTodayQueryDate(formatQueryDate());
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      timeoutId = setTimeout(refresh, getMillisecondsUntilNextLocalMidnight(new Date()));
    };

    refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => {
      subscription.remove();
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, []);

  return todayQueryDate;
}
