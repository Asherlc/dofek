import { validateHeaderValue } from "node:http";
import { z } from "zod";
import { captureException } from "../../lib/error-reporting.ts";
import { ProviderAuthError, ProviderTokenRejectedError } from "../auth-errors.ts";

const integer = z
  .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().nonnegative().safe());
const pageSchema = z.object({
  data: z.object({
    account: z.object({
      id: z
        .union([z.string().regex(/^[1-9]\d*$/), z.number().int().positive().safe()])
        .transform(String),
    }),
    ascents: z.array(z.object({ epoch: integer }).catchall(z.json())),
    numberAscents: integer,
    page: integer.pipe(z.number().positive()),
    perPage: integer.pipe(z.number().positive()),
  }),
});

export class TheCragClient {
  readonly #fetch: typeof fetch;
  readonly #key: string;

  constructor(fetchFn: typeof fetch, key: string) {
    if (!key)
      throw new ProviderTokenRejectedError(
        "theCrag",
        "Paste your personal API key from theCrag Settings > API Keys.",
      );
    try {
      validateHeaderValue("X-CData-Key", `key=${key}`);
    } catch {
      const error = new ProviderTokenRejectedError(
        "theCrag",
        "Your personal API key contains invalid characters. Copy it again from theCrag Settings > API Keys.",
      );
      captureException(error, { tags: { provider: "thecrag", phase: "key_validation" } });
      throw error;
    }
    this.#fetch = fetchFn;
    this.#key = key;
  }

  async fetchPage(page: number, options: { since?: number; signal?: AbortSignal } = {}) {
    const url = new URL("https://www.thecrag.com/api/logbook/ascents");
    url.searchParams.set("page", String(page));
    if (options.since !== undefined) url.searchParams.set("since", String(options.since));
    const response = await this.#fetch(url.href, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "application/json", "X-CData-Key": `key=${this.#key}` },
      signal: options.signal,
    });
    if (response.status === 401)
      throw new ProviderTokenRejectedError(
        "theCrag",
        "The logbook API returned 401. Check your key in theCrag Settings > API Keys and reconnect.",
      );
    if (response.status === 400 || response.status === 403)
      throw new ProviderAuthError(
        "authorization_failed",
        `theCrag denied logbook access (${response.status}). Check your API key, active supporter status and weekly usage budget in theCrag Settings > API Keys.`,
      );
    if (response.status === 429)
      throw new Error(
        "theCrag limited logbook access (429). Check your weekly usage budget in theCrag Settings > API Keys and try again when access is available.",
      );
    if (response.status !== 200)
      throw new Error(
        `theCrag logbook request failed (${response.status}). Try again or contact support.`,
      );
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      options.signal?.throwIfAborted();
      const error = new Error(
        "theCrag returned invalid logbook JSON. Try again or contact support.",
      );
      captureException(error, { tags: { provider: "thecrag", phase: "logbook_response" } });
      throw error;
    }
    const parsed = pageSchema.safeParse(body);
    if (!parsed.success)
      throw new Error(
        "theCrag returned an invalid logbook response. Try again or contact support.",
      );
    return parsed.data.data;
  }
}
