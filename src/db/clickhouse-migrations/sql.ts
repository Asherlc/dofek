export function clickHouseStringLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

export function clickHouseDateTimeLiteral(value: Date): string {
  const clickHouseTimestamp = value.toISOString().replace("T", " ").replace("Z", "");
  return `toDateTime64(${clickHouseStringLiteral(clickHouseTimestamp)}, 6, 'UTC')`;
}

export function parsePostgresTimestamp(value: string, label: string): Date {
  const hasTimeZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(value);
  const normalizedValue = hasTimeZone ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalizedValue);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}
