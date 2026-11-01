import { z } from "zod";
import type { SourceClimbingLogEntry } from "../../db/climbing-log-sync.ts";
import { exportDate, nullableExportText } from "../../lib/climbing-file.ts";
import { ClimbingImportValidationError } from "../../lib/climbing-import-error.ts";

type KnownIdentity = { id: string; externalId: string | null; raw: unknown };
const nativePrefix = "eight-a:native:";
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const sharedCsvFields = new Set([
  "route_boulder",
  "name",
  "location_name",
  "sector_name",
  "area_name",
  "country_code",
  "date",
  "type",
  "sub_type",
  "rating",
  "project",
  "tries",
  "difficulty",
  "comment",
  "recommended",
]);
function object(value: unknown): Record<string, unknown> | null {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  return parsed.success ? parsed.data : null;
}
function text(value: unknown) {
  return nullableExportText(typeof value === "string" ? value : undefined);
}
function csvRaw(raw: unknown) {
  const value = object(raw);
  return object(value?.csv) ?? (typeof value?.route_boulder === "string" ? value : null);
}
function nativeRaw(raw: unknown) {
  const value = object(raw);
  return object(value?.native) ?? (value?.ascentId != null ? value : null);
}
function csvFingerprint(raw: unknown): string | null {
  const row = csvRaw(raw);
  return row ? JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))) : null;
}
function csvFlag(value: unknown) {
  const normalized = text(value);
  if (normalized === null) return null;
  if (normalized === "0" || normalized === "false") return false;
  if (normalized === "1" || normalized === "true") return true;
  return undefined;
}

/** Match only shared source facts; absent identifiers/names/dates cannot prove a transition. */
function projection(raw: unknown, nativeId?: string | null): string | null {
  const isNative = nativeId?.startsWith(nativePrefix) ?? false;
  const row = isNative ? nativeRaw(raw) : csvRaw(raw);
  if (!row) return null;
  if (
    !isNative &&
    (!z.record(z.string(), z.string()).safeParse(row).success ||
      Object.entries(row).some(([key, value]) => !sharedCsvFields.has(key) && text(value) !== null))
  )
    return null;
  const category = nativeId?.split(":")[2];
  const kind = isNative
    ? category === "bouldering" || category === "gymboulder"
      ? "boulder"
      : category === "sportclimbing" || category === "gymroute"
        ? "route"
        : null
    : row.route_boulder === "BOULDER"
      ? "boulder"
      : row.route_boulder === "ROUTE"
        ? "route"
        : null;
  const name = text(isNative ? row.zlaggableName : row.name);
  const location = text(isNative ? row.cragName : row.location_name);
  const date = exportDate(text(row.date) ?? undefined, "Vertical-Life identity");
  if (!kind || !name || !location || !date) return null;
  const sector = text(isNative ? row.sectorName : row.sector_name);
  const tries = isNative
    ? (row.tries ?? null)
    : text(row.tries) === null
      ? null
      : Number(row.tries);
  const project = isNative ? row.project : csvFlag(row.project);
  const recommended = isNative ? (row.recommended ?? null) : csvFlag(row.recommended);
  if (project === undefined || recommended === undefined) return null;
  const code = text(row.country_code);
  if (!isNative && code !== null && !/^[A-Z]{2}$/.test(code)) return null;
  const country = isNative ? text(row.countryName) : code === null ? null : regionNames.of(code);
  const rating = isNative
    ? (row.rating ?? null)
    : text(row.rating) === null
      ? null
      : Number(row.rating);
  if (typeof rating === "number" && !Number.isFinite(rating)) return null;
  return JSON.stringify([
    kind,
    date,
    name,
    location,
    text(isNative ? row.areaName : row.area_name),
    country,
    sector === "Unknown Sector" ? null : sector,
    text(row.difficulty),
    text(row.type)?.toLowerCase() ?? null,
    tries,
    text(row.comment),
    text(isNative ? row.subType : row.sub_type),
    project,
    rating,
    recommended,
  ]);
}
function failure(existing = false): never {
  throw new ClimbingImportValidationError(
    existing
      ? "Existing CSV history has no unique exact match in the Vertical-Life logbook. Review those imported records before switching to account sync."
      : "CSV rows need a unique exact match in the synced Vertical-Life logbook. Sync new ascents from Vertical-Life; edited, unmatched or ambiguous CSV rows cannot be imported after connection.",
  );
}
function mergedRaw(native: unknown, csv: unknown) {
  return z.json().parse({ native, csv });
}

/** One resolver for the initial transition and every subsequent account sync or upload. */
export function resolveEightAIdentities(
  incoming: readonly SourceClimbingLogEntry[],
  known: readonly KnownIdentity[],
  source: "native" | "csv",
  connected: boolean,
) {
  const migrations: Array<{ id: string; externalId: string }> = [];
  const rawUpdates: Array<{ id: string; raw: z.infer<ReturnType<typeof z.json>> }> = [];
  const nativeKnown = known.filter((row) => row.externalId?.startsWith(nativePrefix));
  const nativeById = new Map(nativeKnown.map((row) => [row.externalId, row]));
  if (source === "csv") {
    if (!connected && !nativeKnown.length)
      return { entries: [...incoming], migrations, rawUpdates };
    const matched = new Set<string>();
    const byProjection = new Map<string, KnownIdentity[]>();
    const byCsvFingerprint = new Map<string, KnownIdentity[]>();
    for (const row of nativeKnown) {
      const key = projection(row.raw, row.externalId);
      if (key !== null) {
        const group = byProjection.get(key) ?? [];
        group.push(row);
        byProjection.set(key, group);
      }
      const fingerprint = csvFingerprint(row.raw);
      if (fingerprint !== null) {
        const group = byCsvFingerprint.get(fingerprint) ?? [];
        group.push(row);
        byCsvFingerprint.set(fingerprint, group);
      }
    }
    for (const entry of incoming) {
      const key = projection(entry.raw);
      const fingerprint = csvFingerprint(entry.raw);
      const candidates = [
        ...new Map(
          [
            ...(key === null ? [] : (byProjection.get(key) ?? [])),
            ...(fingerprint === null ? [] : (byCsvFingerprint.get(fingerprint) ?? [])),
          ].map((row) => [row.id, row]),
        ).values(),
      ];
      if (candidates.length !== 1) failure();
      const row = candidates[0];
      if (!row || matched.has(row.id)) failure();
      matched.add(row.id);
      rawUpdates.push({ id: row.id, raw: mergedRaw(nativeRaw(row.raw), entry.raw) });
    }
    return { entries: [], migrations, rawUpdates };
  }
  const legacy = known.filter(
    (row) =>
      !row.externalId?.startsWith(nativePrefix) &&
      (csvRaw(row.raw) !== null || row.externalId?.startsWith("eight-a:")),
  );
  const bindings = new Map<string, KnownIdentity>();
  const incomingByProjection = new Map<string, SourceClimbingLogEntry[]>();
  for (const entry of incoming) {
    const key = projection(entry.raw, entry.externalId);
    if (key !== null) {
      const group = incomingByProjection.get(key) ?? [];
      group.push(entry);
      incomingByProjection.set(key, group);
    }
  }
  for (const row of legacy) {
    const key = projection(row.raw);
    const candidates = key === null ? [] : (incomingByProjection.get(key) ?? []);
    if (candidates.length !== 1) failure(true);
    const candidate = candidates[0];
    if (!candidate || bindings.has(candidate.externalId) || nativeById.has(candidate.externalId))
      failure();
    bindings.set(candidate.externalId, row);
    migrations.push({ id: row.id, externalId: candidate.externalId });
  }
  const entries = incoming.map((entry) => {
    const row = nativeById.get(entry.externalId) ?? bindings.get(entry.externalId);
    const csv = csvRaw(row?.raw);
    return csv ? { ...entry, raw: mergedRaw(entry.raw, csv) } : entry;
  });
  return { entries, migrations, rawUpdates };
}
