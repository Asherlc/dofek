/**
 * Base HTTP client for OAuth 2.0 providers.
 *
 * Standardizes:
 * - Bearer token authorization
 * - GET/POST with proper headers
 * - Zod runtime validation of API responses
 * - Consistent error handling
 * - Fetch function injection for testability
 */

import type { z } from "zod";

/**
 * Base class for providers that make HTTP requests with bearer token auth.
 *
 * Subclasses inherit `get()` and `post()` methods that automatically attach
 * the Authorization header and validate responses with Zod schemas.
 *
 * @example
 * ```ts
 * class StravaClient extends ProviderHttpClient {
 *   async getActivities(page: number) {
 *     return this.get("/athlete/activities", activitiesSchema, { page: String(page) });
 *   }
 * }
 * ```
 */
export class ProviderHttpClient {
  protected readonly accessToken: string;
  protected readonly apiBase: string;
  protected readonly fetchFn: typeof globalThis.fetch;

  constructor(
    accessToken: string,
    apiBase: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.accessToken = accessToken;
    this.apiBase = apiBase;
    this.fetchFn = fetchFn;
  }

  /**
   * Build request headers. Override in subclasses that need additional headers
   * (e.g., Accept, rate-limit tokens).
   */
  protected getHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  /**
   * Handle non-OK responses. Override to customize error parsing per-provider.
   * Default behavior: extract response text and throw with status code.
   */
  protected async handleErrorResponse(response: Response, path: string): Promise<never> {
    const text = await response.text();
    const truncated = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    throw new Error(`API error ${response.status} on ${path}: ${truncated}`);
  }

  /**
   * GET a JSON resource and validate with a Zod schema.
   *
   * @param path - URL path relative to apiBase (e.g., "/v1/workouts")
   * @param schema - Zod schema to parse the response body
   * @param params - Optional query parameters
   */
  protected async get<T extends z.ZodType>(
    path: string,
    schema: T,
    params?: Record<string, string>,
  ): Promise<z.infer<T>> {
    const url = new URL(path, this.apiBase);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await this.fetchFn(url.toString(), {
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      await this.handleErrorResponse(response, path);
    }

    const json: unknown = await response.json();
    return schema.parse(json);
  }

  /**
   * POST JSON and validate the response with a Zod schema.
   *
   * @param path - URL path relative to apiBase
   * @param schema - Zod schema to parse the response body
   * @param body - Request body (will be JSON-stringified)
   */
  protected async post<T extends z.ZodType>(
    path: string,
    schema: T,
    body?: Record<string, unknown>,
  ): Promise<z.infer<T>> {
    const url = new URL(path, this.apiBase);
    const response = await this.fetchFn(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.getHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      await this.handleErrorResponse(response, path);
    }

    const json: unknown = await response.json();
    return schema.parse(json);
  }

  /**
   * GET raw bytes (e.g., for downloading FIT files).
   * No schema validation since the response is binary.
   */
  protected async getBuffer(url: string): Promise<Buffer> {
    const response = await this.fetchFn(url, {
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to download from ${url} (${response.status})`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
