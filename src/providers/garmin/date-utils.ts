export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function eachDay(since: Date, until: Date): string[] {
  const dates: string[] = [];
  const current = new Date(since);
  current.setUTCHours(0, 0, 0, 0);
  const end = new Date(until);
  end.setUTCHours(0, 0, 0, 0);

  while (current <= end) {
    dates.push(formatDate(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}
