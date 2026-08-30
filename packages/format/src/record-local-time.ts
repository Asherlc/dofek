import { z } from "zod";
import { parseValidDate } from "./format.ts";

export const localTimeSourceSchema = z.enum([
  "provider_timezone",
  "provider_offset",
  "device_timezone",
  "device_offset",
  "unknown",
]);

export type LocalTimeSource = z.infer<typeof localTimeSourceSchema>;

export const recordLocalTimeContextSchema = z.object({
  timezone: z.string().nullable(),
  startUtcOffsetMinutes: z.number().int().min(-840).max(840).nullable(),
  endUtcOffsetMinutes: z.number().int().min(-840).max(840).nullable(),
  source: localTimeSourceSchema,
});

export type RecordLocalTimeContext = z.infer<typeof recordLocalTimeContextSchema>;

interface ResolveRecordLocalTimeContextInput {
  startedAt: Date;
  endedAt?: Date | null;
  timezone?: string | null;
  startUtcOffsetMinutes?: number | null;
  endUtcOffsetMinutes?: number | null;
  source: LocalTimeSource;
}

const timezoneSources = new Set<LocalTimeSource>(["provider_timezone", "device_timezone"]);
const offsetSources = new Set<LocalTimeSource>(["provider_offset", "device_offset"]);

function requireValidDate(date: Date, field: "startedAt" | "endedAt"): void {
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${field} must be a valid Date`);
  }
}

function validateOffset(offsetMinutes: number | null | undefined): number | null {
  if (offsetMinutes == null) return null;
  if (!Number.isInteger(offsetMinutes) || offsetMinutes < -840 || offsetMinutes > 840) {
    throw new Error("UTC offset minutes must be an integer between -840 and 840");
  }
  return offsetMinutes;
}

function offsetInTimezone(date: Date, timezone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
  } catch {
    throw new Error(`Invalid IANA timezone: ${timezone}`);
  }

  const values = Object.fromEntries(
    parts
      .filter((part) => ["year", "month", "day", "hour", "minute", "second"].includes(part.type))
      .map((part) => [part.type, Number(part.value)]),
  );
  const projectedAsUtc = Date.UTC(
    values.year ?? 0,
    (values.month ?? 1) - 1,
    values.day ?? 1,
    values.hour ?? 0,
    values.minute ?? 0,
    values.second ?? 0,
  );
  return Math.round((projectedAsUtc - date.getTime()) / 60_000);
}

export function localTimeContextUnknown(): RecordLocalTimeContext {
  return {
    timezone: null,
    startUtcOffsetMinutes: null,
    endUtcOffsetMinutes: null,
    source: "unknown",
  };
}

export function resolveRecordLocalTimeContext(
  input: ResolveRecordLocalTimeContextInput,
): RecordLocalTimeContext {
  requireValidDate(input.startedAt, "startedAt");
  if (input.endedAt) requireValidDate(input.endedAt, "endedAt");

  if (input.source === "unknown") {
    if (
      input.timezone != null ||
      input.startUtcOffsetMinutes != null ||
      input.endUtcOffsetMinutes != null
    ) {
      throw new Error("Unknown local-time context cannot include a timezone or UTC offset");
    }
    return localTimeContextUnknown();
  }

  if (timezoneSources.has(input.source)) {
    const timezone = input.timezone?.trim();
    if (!timezone) {
      throw new Error(`${input.source} local-time context requires an IANA timezone`);
    }
    return {
      timezone,
      startUtcOffsetMinutes: offsetInTimezone(input.startedAt, timezone),
      endUtcOffsetMinutes: input.endedAt ? offsetInTimezone(input.endedAt, timezone) : null,
      source: input.source,
    };
  }

  if (offsetSources.has(input.source)) {
    if (input.timezone != null) {
      throw new Error(`${input.source} local-time context cannot include an IANA timezone`);
    }
    const startUtcOffsetMinutes = validateOffset(input.startUtcOffsetMinutes);
    if (startUtcOffsetMinutes == null) {
      throw new Error(`${input.source} local-time context requires a start UTC offset`);
    }
    return {
      timezone: null,
      startUtcOffsetMinutes,
      endUtcOffsetMinutes: validateOffset(input.endUtcOffsetMinutes),
      source: input.source,
    };
  }

  return localTimeContextUnknown();
}

export function offsetMinutesFromTimestamp(timestamp: string): number | null {
  if (/Z$/i.test(timestamp)) return 0;
  const match = timestamp.match(/([+-])(\d{2}):?(\d{2})$/);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null;
  return sign * (hours * 60 + minutes);
}

export function resolveTimestampOffsetLocalTimeContext(input: {
  startedAtTimestamp: string;
  endedAtTimestamp: string;
  source: "provider_offset" | "device_offset";
}): RecordLocalTimeContext {
  const startUtcOffsetMinutes = offsetMinutesFromTimestamp(input.startedAtTimestamp);
  const endUtcOffsetMinutes = offsetMinutesFromTimestamp(input.endedAtTimestamp);
  if (startUtcOffsetMinutes == null || endUtcOffsetMinutes == null) {
    return localTimeContextUnknown();
  }
  return resolveRecordLocalTimeContext({
    startedAt: new Date(input.startedAtTimestamp),
    endedAt: new Date(input.endedAtTimestamp),
    startUtcOffsetMinutes,
    endUtcOffsetMinutes,
    source: input.source,
  });
}

function timeFormatter(locale: string | undefined, timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: timezone,
  });
}

export function formatRecordLocalTime(
  timestamp: string,
  context: RecordLocalTimeContext,
  boundary: "start" | "end",
  locale?: string,
  viewerTimezone?: string,
): string {
  const date = parseValidDate(timestamp);
  if (!date) return "--";

  if (context.timezone) {
    try {
      return timeFormatter(locale, context.timezone)
        .format(date)
        .replace(/\u202f/g, " ");
    } catch {
      return "--";
    }
  }

  const offsetMinutes =
    boundary === "start" ? context.startUtcOffsetMinutes : context.endUtcOffsetMinutes;
  if (offsetMinutes == null) {
    if (!viewerTimezone) return "--";
    try {
      return timeFormatter(locale, viewerTimezone)
        .format(date)
        .replace(/\u202f/g, " ");
    } catch {
      return "--";
    }
  }
  const shiftedDate = new Date(date.getTime() + offsetMinutes * 60_000);
  return timeFormatter(locale, "UTC")
    .format(shiftedDate)
    .replace(/\u202f/g, " ");
}

export function recordLocalHour(
  timestamp: string,
  context: RecordLocalTimeContext,
  boundary: "start" | "end" = "start",
): number | null {
  const date = parseValidDate(timestamp);
  if (!date) return null;
  const timezone = context.timezone;
  const offsetMinutes =
    boundary === "start" ? context.startUtcOffsetMinutes : context.endUtcOffsetMinutes;
  const projectedDate =
    timezone == null && offsetMinutes != null
      ? new Date(date.getTime() + offsetMinutes * 60_000)
      : date;
  const projectedTimezone = timezone ?? (offsetMinutes == null ? null : "UTC");
  if (!projectedTimezone) return null;

  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: projectedTimezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(projectedDate);
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour + minute / 60;
  } catch {
    return null;
  }
}
