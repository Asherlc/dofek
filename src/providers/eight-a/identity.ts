import { z } from "zod";
import type { SourceClimbingLogEntry } from "../../db/climbing-log-sync.ts";
import { exportDate, nullableExportText } from "../../lib/climbing-file.ts";
import { ClimbingImportValidationError } from "../../lib/climbing-import-error.ts";

type KnownIdentity = { id: string; externalId: string | null; raw: unknown };
const nativePrefix = "eight-a:native:";
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

/** Match only shared source facts; absent identifiers/names/dates cannot prove a transition. */
function projection(raw: unknown, nativeId?: string | null): string | null {
  const isNative = nativeId?.startsWith(nativePrefix) ?? false;
  const row = isNative ? nativeRaw(raw) : csvRaw(raw);
  if (!row) return null;
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
  const project = isNative
    ? row.project
    : row.project === "0" || row.project === "false"
      ? false
      : row.project === "1" || row.project === "true"
        ? true
        : null;
  return JSON.stringify([
    kind,
    date,
    name,
    location,
    sector === "Unknown Sector" ? null : sector,
    text(row.difficulty),
    text(row.type)?.toLowerCase() ?? null,
    tries,
    text(row.comment),
    text(isNative ? row.subType : row.sub_type),
    project,
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
    for (const row of nativeKnown) {
      const keys = new Set([projection(row.raw, row.externalId), projection(csvRaw(row.raw))]);
      for (const key of keys)
        if (key !== null) {
          const group = byProjection.get(key) ?? [];
          group.push(row);
          byProjection.set(key, group);
        }
    }
    for (const entry of incoming) {
      const key = projection(entry.raw);
      const candidates = key === null ? [] : (byProjection.get(key) ?? []);
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
