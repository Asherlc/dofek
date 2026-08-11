export const MOUNTAIN_PROJECT_BASE_URL = "https://www.mountainproject.com";

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

  async getTickExport(userId: string): Promise<string> {
    const response = await this.#fetchFn(
      `${MOUNTAIN_PROJECT_BASE_URL}/user/${encodeURIComponent(userId)}/ticks/tick-export`,
      { headers: { Accept: "text/csv" } },
    );
    if (response.status === 404) {
      throw new MountainProjectTickExportError(
        response.status,
        "Mountain Project we couldn't read your ticks — check that your Mountain Project profile ID is correct and that your ticks aren't set to private.",
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
