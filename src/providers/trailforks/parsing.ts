import {
  type LegacyActivityType,
  type ProviderActivityType,
  resolveProviderActivityType,
} from "@dofek/training/activity-types";
import { createActivityTypeMapper } from "@dofek/training/training";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { z } from "zod";

/**
 * Documented Trailforks `list_filter_values` activitytype IDs with useful
 * canonical mappings. Other IDs fall through to `other`. Unverified against a
 * live Pro/Outside+ `list_my_activities` payload.
 */
const TRAILFORKS_ACTIVITY_TYPE_MAP: Record<number, LegacyActivityType> = {
  1: "mountain_biking",
  2: "e_bike_cycling",
  5: "trail_running",
  6: "hiking",
  10: "snowshoeing",
  11: "downhill_skiing",
  12: "skiing",
  13: "cross_country_skiing",
  17: "mountain_biking",
  18: "mountain_biking",
  19: "gravel_cycling",
};

const mapNumericActivityType = createActivityTypeMapper(TRAILFORKS_ACTIVITY_TYPE_MAP);

/** The Trailforks Apple association file advertises `/ridelog/view/*`. */
const RIDELOG_URL_PATTERN =
  /^https:\/\/(?:www\.)?trailforks\.com\/ridelog\/view\/(\d+)\/?(?:[?#].*)?$/i;

const offsetDateTimeSchema = z.iso.datetime({ offset: true });
const positiveIntSchema = z.number().int().positive();
const positiveUnixSecondsSchema = z.number().finite().positive();

export class TrailforksActivityParseError extends Error {
  constructor() {
    super("Trailforks returned an invalid activity list.");
    this.name = "TrailforksActivityParseError";
  }
}

export interface ParsedTrailforksActivity {
  externalId: string;
  /** Present only when upstream supplied sport/activitytype; omitted fields stay undefined. */
  activityType?: ProviderActivityType;
  /** Present only when upstream supplied title/name. */
  name?: string;
  startedAt: Date;
  /** Present only when upstream supplied a reliable end timestamp. */
  endedAt?: Date;
  /** Unmodified upstream activity object for provenance. */
  raw: Record<string, unknown>;
}

export function mapTrailforksActivityType(activityType: number): ProviderActivityType {
  return mapNumericActivityType(activityType);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function readNumber(row: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function externalIdFromRow(row: Record<string, unknown>): string | null {
  for (const key of ["id", "ridelog_id", "ridelogid", "ridelogId"] as const) {
    const value = row[key];
    const parsed = positiveIntSchema.safeParse(value);
    if (parsed.success) return String(parsed.data);
  }

  const link = readString(row, "link", "url", "activity_url", "activityUrl");
  if (!link) return null;
  const match = RIDELOG_URL_PATTERN.exec(link);
  return match?.[1] ?? null;
}

function parseOffsetDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = offsetDateTimeSchema.safeParse(value);
  if (!parsed.success) return null;
  const date = new Date(parsed.data);
  return Number.isFinite(date.getTime()) ? date : null;
}

function parseUnixSeconds(value: unknown): Date | null {
  const parsed = positiveUnixSecondsSchema.safeParse(value);
  if (!parsed.success) return null;
  const date = new Date(parsed.data * 1000);
  return Number.isFinite(date.getTime()) ? date : null;
}

function startedAtFromRow(row: Record<string, unknown>): Date | null {
  return (
    parseOffsetDate(row.started_at) ??
    parseOffsetDate(row.start_time) ??
    parseOffsetDate(row.startedAt) ??
    parseOffsetDate(row.startTime) ??
    parseOffsetDate(row.date) ??
    parseUnixSeconds(row.start_timestamp) ??
    parseUnixSeconds(row.startTimestamp) ??
    null
  );
}

function endedAtFromRow(row: Record<string, unknown>): Date | undefined {
  // Only accept explicitly reliable end timestamps — never fabricate from durations.
  return (
    parseOffsetDate(row.ended_at) ??
    parseOffsetDate(row.end_time) ??
    parseOffsetDate(row.endedAt) ??
    parseOffsetDate(row.endTime) ??
    parseUnixSeconds(row.end_timestamp) ??
    parseUnixSeconds(row.endTimestamp) ??
    undefined
  );
}

function activityTypeFromRow(row: Record<string, unknown>): ProviderActivityType | undefined {
  const numericType = readNumber(row, "activitytype", "activity_type", "activityType", "type");
  if (numericType !== null && Number.isInteger(numericType)) {
    return mapTrailforksActivityType(numericType);
  }

  const stringType = readString(
    row,
    "activitytype",
    "activity_type",
    "activityType",
    "type",
    "sport",
  );
  if (stringType) {
    return resolveProviderActivityType(stringType, "other");
  }

  return undefined;
}

function parseActivityRow(value: unknown): ParsedTrailforksActivity {
  if (!isRecord(value)) throw new TrailforksActivityParseError();

  const externalId = externalIdFromRow(value);
  const startedAt = startedAtFromRow(value);
  if (!externalId || !startedAt) throw new TrailforksActivityParseError();

  const endedAt = endedAtFromRow(value);
  if (endedAt && endedAt.getTime() < startedAt.getTime()) {
    throw new TrailforksActivityParseError();
  }

  const name = readString(value, "title", "name") ?? undefined;
  const activityType = activityTypeFromRow(value);

  return {
    externalId,
    startedAt,
    raw: value,
    ...(activityType === undefined ? {} : { activityType }),
    ...(name === undefined ? {} : { name }),
    ...(endedAt === undefined ? {} : { endedAt }),
  };
}

function extractActivityRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) throw new TrailforksActivityParseError();
  if (Array.isArray(payload.activities)) return payload.activities;
  throw new TrailforksActivityParseError();
}

function payloadFromCallToolResult(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }

  const textBlocks = result.content.filter(
    (content): content is Extract<CallToolResult["content"][number], { type: "text" }> =>
      content.type === "text",
  );
  if (textBlocks.length !== 1 || textBlocks[0] === undefined) {
    throw new TrailforksActivityParseError();
  }

  try {
    return JSON.parse(textBlocks[0].text);
  } catch {
    throw new TrailforksActivityParseError();
  }
}

/**
 * Strictly parse an opaque MCP `list_my_activities` result.
 * Every returned row must validate; otherwise the entire payload is rejected
 * so the provider writes nothing. Prefer `structuredContent` when present
 * (Trailforks also returns a formatted Markdown content block).
 */
export function parseTrailforksActivityListResult(
  result: CallToolResult,
): ParsedTrailforksActivity[] {
  try {
    const rows = extractActivityRows(payloadFromCallToolResult(result));
    return rows.map((row) => parseActivityRow(row));
  } catch (error: unknown) {
    if (error instanceof TrailforksActivityParseError) throw error;
    throw new TrailforksActivityParseError();
  }
}
