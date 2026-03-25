import { parseHealthDate } from "./dates.ts";

export interface HealthRecord {
  type: string;
  sourceName: string | null;
  unit: string | null;
  value: number;
  startDate: Date;
  endDate: Date;
  creationDate: Date;
}

export function parseRecord(attrs: Record<string, string>): HealthRecord | null {
  const type = attrs.type;
  const value = parseFloat(attrs.value ?? "");
  if (!type || Number.isNaN(value)) return null;

  return {
    type,
    sourceName: attrs.sourceName ?? null,
    unit: attrs.unit ?? null,
    value,
    startDate: parseHealthDate(attrs.startDate ?? ""),
    endDate: parseHealthDate(attrs.endDate ?? ""),
    creationDate: parseHealthDate(attrs.creationDate ?? ""),
  };
}

// Category records have string values (e.g., MindfulSession, SexualActivity)
export interface CategoryRecord {
  type: string;
  sourceName: string | null;
  value: string | null;
  startDate: Date;
  endDate: Date;
}

export function parseCategoryRecord(attrs: Record<string, string>): CategoryRecord | null {
  const type = attrs.type;
  if (!type) return null;

  return {
    type,
    sourceName: attrs.sourceName ?? null,
    value: attrs.value ?? null,
    startDate: parseHealthDate(attrs.startDate ?? ""),
    endDate: parseHealthDate(attrs.endDate ?? ""),
  };
}

export interface RouteLocation {
  date: Date;
  lat: number;
  lng: number;
  altitude?: number;
  horizontalAccuracy?: number;
  verticalAccuracy?: number;
  course?: number;
  speed?: number;
}

export function parseRouteLocation(attrs: Record<string, string>): RouteLocation | null {
  const lat = parseFloat(attrs.latitude ?? "");
  const lng = parseFloat(attrs.longitude ?? "");
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;

  const optNum = (key: string): number | undefined => {
    const parsed = parseFloat(attrs[key] ?? "");
    return Number.isNaN(parsed) ? undefined : parsed;
  };

  return {
    date: parseHealthDate(attrs.date ?? ""),
    lat,
    lng,
    altitude: optNum("altitude"),
    horizontalAccuracy: optNum("horizontalAccuracy"),
    verticalAccuracy: optNum("verticalAccuracy"),
    course: optNum("course"),
    speed: optNum("speed"),
  };
}
