import { z } from "zod";

export const MOUNTAIN_PROJECT_BASE_URL = "https://www.mountainproject.com";

const rawResponseSchema = z.record(z.string(), z.json());
const routeResponseSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().regex(/\S/),
  parent: z.object({
    id: z.number().int().nonnegative(),
    name: z.string(),
  }),
});
const areaResponseSchema = routeResponseSchema.extend({
  coordinates: z
    .tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
    .nullable()
    .optional(),
});

export interface MountainProjectAreaReference {
  /** Zero identifies the root's missing parent in the observed API. */
  id: number;
  name: string;
}

export interface MountainProjectRoute {
  id: number;
  title: string;
  parent: MountainProjectAreaReference;
  raw: z.infer<typeof rawResponseSchema>;
}

export interface MountainProjectArea extends MountainProjectRoute {
  /** Native Area position, in upstream longitude/latitude order. */
  coordinates?: readonly [number, number] | null;
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
    return this.#getEntity("route", id, routeResponseSchema);
  }

  getArea(id: string): Promise<MountainProjectArea> {
    return this.#getEntity("area", id, areaResponseSchema);
  }

  async #getEntity<ResponseData extends z.infer<typeof routeResponseSchema>>(
    kind: "route" | "area",
    id: string,
    schema: z.ZodType<ResponseData>,
  ): Promise<ResponseData & { raw: z.infer<typeof rawResponseSchema> }> {
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
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error(`Mountain Project ${kind} ${id} returned invalid data. Please try again.`, {
        cause: error,
      });
    }
    const raw = rawResponseSchema.safeParse(body);
    const parsed = schema.safeParse(raw.success ? raw.data : undefined);
    if (!raw.success || !parsed.success || parsed.data.id !== Number(id)) {
      throw new Error(`Mountain Project ${kind} ${id} returned invalid data. Please try again.`);
    }
    return {
      ...parsed.data,
      raw: raw.data,
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
