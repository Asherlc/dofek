import {
  type LocalTimeSource,
  localTimeContextUnknown,
  resolveRecordLocalTimeContext,
} from "@dofek/format/record-local-time";
import timezoneAt from "tz-lookup";

const MAXIMUM_PLAUSIBLE_OFFSET_DIFFERENCE_MINUTES = 60;

export type ActivityLocalTimeSource = LocalTimeSource | "gps_timezone" | "home_zone_fallback";

export interface SuppliedActivityLocalTime {
  timezone: string | null;
  startUtcOffsetMinutes: number | null;
  endUtcOffsetMinutes: number | null;
  source: LocalTimeSource;
}

export interface ActivityLocalTimeContext {
  timezone: string | null;
  startUtcOffsetMinutes: number | null;
  endUtcOffsetMinutes: number | null;
  source: ActivityLocalTimeSource;
}

interface ActivityCoordinates {
  latitude: number;
  longitude: number;
}

interface ResolvePlausibleActivityLocalTimeInput {
  startedAt: Date;
  endedAt?: Date | null;
  supplied: SuppliedActivityLocalTime;
  homeTimezone?: string | null;
  coordinates?: ActivityCoordinates | null;
  requireReferenceTimezone?: boolean;
}

export interface PlausibleActivityLocalTimeResult {
  context: ActivityLocalTimeContext;
  rejected: SuppliedActivityLocalTime | null;
  reference: { source: "gps" | "home_zone"; timezone: string } | null;
}

function referenceTimezone(
  coordinates: ActivityCoordinates | null | undefined,
  homeTimezone: string | null | undefined,
): PlausibleActivityLocalTimeResult["reference"] {
  if (
    coordinates &&
    Number.isFinite(coordinates.latitude) &&
    Number.isFinite(coordinates.longitude) &&
    coordinates.latitude >= -90 &&
    coordinates.latitude <= 90 &&
    coordinates.longitude >= -180 &&
    coordinates.longitude <= 180
  ) {
    return {
      source: "gps",
      timezone: timezoneAt(coordinates.latitude, coordinates.longitude),
    };
  }
  const timezone = homeTimezone?.trim();
  return timezone ? { source: "home_zone", timezone } : null;
}

function contextInReferenceZone(
  input: ResolvePlausibleActivityLocalTimeInput,
  reference: NonNullable<PlausibleActivityLocalTimeResult["reference"]>,
): ActivityLocalTimeContext {
  const resolved = resolveRecordLocalTimeContext({
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    timezone: reference.timezone,
    source: "user_home_timezone",
  });
  return {
    timezone: resolved.timezone,
    startUtcOffsetMinutes: resolved.startUtcOffsetMinutes,
    endUtcOffsetMinutes: resolved.endUtcOffsetMinutes,
    source: reference.source === "gps" ? "gps_timezone" : "home_zone_fallback",
  };
}

function suppliedContextIsPlausible(
  supplied: SuppliedActivityLocalTime,
  expected: ActivityLocalTimeContext,
): boolean {
  if (supplied.source === "unknown" || supplied.startUtcOffsetMinutes == null) return false;
  if (expected.startUtcOffsetMinutes == null) return false;
  if (
    Math.abs(supplied.startUtcOffsetMinutes - expected.startUtcOffsetMinutes) >
    MAXIMUM_PLAUSIBLE_OFFSET_DIFFERENCE_MINUTES
  ) {
    return false;
  }
  return !(
    supplied.endUtcOffsetMinutes != null &&
    expected.endUtcOffsetMinutes != null &&
    Math.abs(supplied.endUtcOffsetMinutes - expected.endUtcOffsetMinutes) >
      MAXIMUM_PLAUSIBLE_OFFSET_DIFFERENCE_MINUTES
  );
}

/**
 * Validate provider/device local-time evidence against a geographic zone at
 * the activity instant. GPS is authoritative; the configured home zone is the
 * fallback reference. Invalid observations are retained separately for audit.
 */
export function resolvePlausibleActivityLocalTime(
  input: ResolvePlausibleActivityLocalTimeInput,
): PlausibleActivityLocalTimeResult {
  const reference = referenceTimezone(input.coordinates, input.homeTimezone);
  if (!reference) {
    if (input.requireReferenceTimezone) {
      throw new Error(
        "activity local-time plausibility requires GPS coordinates or a home timezone",
      );
    }
    return {
      context: localTimeContextUnknown(),
      rejected: input.supplied.source === "unknown" ? null : input.supplied,
      reference: null,
    };
  }

  const fallback = contextInReferenceZone(input, reference);
  if (suppliedContextIsPlausible(input.supplied, fallback)) {
    return { context: input.supplied, rejected: null, reference };
  }
  return {
    context: fallback,
    rejected: input.supplied.source === "unknown" ? null : input.supplied,
    reference,
  };
}
