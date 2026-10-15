export const MOUNTAIN_PROJECT_BASE_URL = "https://www.mountainproject.com";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface MountainProjectAreaReference {
  /** Zero identifies the root's missing parent in the observed API. */
  id: number;
  name: string;
}

export interface MountainProjectRoute {
  id: number;
  title: string;
  parent: MountainProjectAreaReference;
  raw: Record<string, JsonValue>;
}

export interface MountainProjectArea extends MountainProjectRoute {
  /** Native Area position, in upstream longitude/latitude order. */
  coordinates?: readonly [number, number] | null;
}

function object(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validCoordinates(value: unknown): value is [number, number] | null | undefined {
  return (
    value === undefined ||
    value === null ||
    (Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "number" &&
      Number.isFinite(value[0]) &&
      Math.abs(value[0]) <= 180 &&
      typeof value[1] === "number" &&
      Number.isFinite(value[1]) &&
      Math.abs(value[1]) <= 90)
  );
}

export class MountainProjectTickExportError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "MountainProjectTickExportError";
    this.status = status;
  }
}

/** Parses the public profile URL stored in a manual-token connection. */
export function parseMountainProjectProfileId(input: string): string {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Paste your Mountain Project profile URL or numeric profile ID.");
  }
  if (
    url.protocol !== "https:" ||
    !["mountainproject.com", "www.mountainproject.com"].includes(url.hostname)
  ) {
    throw new Error("Paste your Mountain Project profile URL or numeric profile ID.");
  }
  const match = /^\/user\/(\d+)(?:\/|$)/.exec(url.pathname);
  if (!match?.[1]) {
    throw new Error("Paste your Mountain Project profile URL or numeric profile ID.");
  }
  return match[1];
}

export class MountainProjectClient {
  readonly #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = fetchFn;
  }

  getRoute(id: string): Promise<MountainProjectRoute> {
    return this.#getEntity("route", id);
  }

  getArea(id: string): Promise<MountainProjectArea> {
    return this.#getEntity("area", id);
  }

  async #getEntity(kind: "route" | "area", id: string): Promise<MountainProjectArea> {
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
      throw new Error(`Mountain Project ${kind} ID must be a positive integer.`);
    }
    const response = await this.#fetchFn(`${MOUNTAIN_PROJECT_BASE_URL}/api/v2/${kind}s/${id}`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(
        `Mountain Project ${kind} ${id} failed (${response.status}). Please try again.`,
      );
    }
    const raw: unknown = await response.json();
    if (
      !object(raw) ||
      raw.id !== Number(id) ||
      typeof raw.title !== "string" ||
      !raw.title.trim() ||
      !object(raw.parent) ||
      !Number.isSafeInteger(raw.parent.id) ||
      typeof raw.parent.id !== "number" ||
      raw.parent.id < 0 ||
      typeof raw.parent.name !== "string" ||
      (kind === "area" && !validCoordinates(raw.coordinates))
    ) {
      throw new Error(`Mountain Project ${kind} ${id} returned invalid data. Please try again.`);
    }
    return {
      id: Number(id),
      title: raw.title,
      parent: { id: raw.parent.id, name: raw.parent.name },
      raw,
      ...(kind === "area" && validCoordinates(raw.coordinates) && raw.coordinates !== undefined
        ? { coordinates: raw.coordinates }
        : {}),
    };
  }

  async getTickExport(userId: string): Promise<string> {
    const response = await this.#fetchFn(
      `${MOUNTAIN_PROJECT_BASE_URL}/user/${encodeURIComponent(userId)}/ticks/tick-export`,
      { headers: { Accept: "text/csv" } },
    );
    if (response.status === 404) {
      throw new MountainProjectTickExportError(
        response.status,
        "Mountain Project: we couldn't read your ticks — check that your Mountain Project profile ID is correct and that your ticks aren't set to private.",
      );
    }
    if (!response.ok) {
      throw new MountainProjectTickExportError(
        response.status,
        `Mountain Project tick export failed (${response.status}). Please try again.`,
      );
    }
    return response.text();
  }
}
