import { formatDateYmd } from "@dofek/format/format";

export interface FixtureDates {
  date(dayOffset?: number): string;
  weekStart(dayOffset?: number): string;
}

export function createFixtureDates(baseDate: Date): FixtureDates {
  const capturedDate = new Date(baseDate);

  function date(dayOffset = 0): string {
    const derivedDate = new Date(capturedDate);
    derivedDate.setDate(derivedDate.getDate() + dayOffset);
    return formatDateYmd(derivedDate);
  }

  function weekStart(dayOffset = 0): string {
    const derivedDate = new Date(capturedDate);
    derivedDate.setDate(derivedDate.getDate() + dayOffset);
    const daysSinceMonday = (derivedDate.getDay() + 6) % 7;
    derivedDate.setDate(derivedDate.getDate() - daysSinceMonday);
    return formatDateYmd(derivedDate);
  }

  return { date, weekStart };
}
