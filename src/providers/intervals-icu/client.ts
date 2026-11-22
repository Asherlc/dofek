import type { z } from "zod";
import { ProviderAuthenticationFailedError } from "../auth-errors.ts";

export const INTERVALS_ICU_API_ORIGIN = "https://intervals.icu";
const API_PREFIX = "/api/v1";

export class IntervalsIcuHttpError extends Error {
  readonly status: number;
  constructor(path: string, status: number) {
    super(`Intervals.icu GET ${path} failed (${status})`);
    this.name = "IntervalsIcuHttpError";
    this.status = status;
  }
}

/** Authenticated, GET-only client pinned to the vendor origin (redirects are rejected). */
export class IntervalsIcuClient {
  readonly #accessToken: string;
  readonly #fetchFn: typeof globalThis.fetch;

  constructor(accessToken: string, fetchFn: typeof globalThis.fetch) {
    this.#accessToken = accessToken;
    this.#fetchFn = fetchFn;
  }

  async get<T>(
    path: string,
    schema: z.ZodType<T>,
    options?: { query?: Record<string, string>; signal?: AbortSignal },
  ): Promise<T> {
    if (!path.startsWith("/")) throw new Error("Intervals.icu path must start with '/'");
    const url = new URL(`${API_PREFIX}${path}`, INTERVALS_ICU_API_ORIGIN);
    for (const [key, value] of Object.entries(options?.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const response = await this.#fetchFn(url, {
      method: "GET",
      redirect: "error",
      signal: options?.signal,
      headers: { Authorization: `Bearer ${this.#accessToken}`, Accept: "application/json" },
    });
    if (response.status === 401) {
      throw new ProviderAuthenticationFailedError("Intervals.icu");
    }
    if (!response.ok) throw new IntervalsIcuHttpError(path, response.status);
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new Error(`Intervals.icu GET ${path} returned malformed JSON`, { cause: error });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new Error(`Intervals.icu GET ${path} returned an unexpected shape`, {
        cause: parsed.error,
      });
    }
    return parsed.data;
  }
}
