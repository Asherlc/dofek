/**
 * Shared test infrastructure for the dofek monorepo.
 *
 * Provides typed helpers that eliminate type suppression comments in tests:
 * - `createMockResponse()` — builds a fully typed `Response` mock
 * - `createTypedMockFetch()` — builds a `typeof fetch` mock with accessible `.mock` property
 * - `mockCallArg()` — extracts a typed argument from `vi.fn().mock.calls`
 */
import { vi } from "vitest";

/**
 * A fetch function created by `vi.fn()` with proper type parameters.
 * This gives `.mock.calls` the correct tuple types automatically,
 * so destructuring call args doesn't need type suppression comments.
 */
export type TypedMockFetch = ReturnType<typeof vi.fn<typeof globalThis.fetch>> &
  typeof globalThis.fetch;

/**
 * Create a typed `vi.fn()` mock for `globalThis.fetch`.
 *
 * The returned function is both callable as `fetch(url, init)` and has
 * a `.mock` property with properly typed `.calls` — so you can write:
 *
 * ```ts
 * const fetchFn = createTypedMockFetch();
 * fetchFn.mockResolvedValue(createMockResponse({ ok: true }));
 * // ... call code under test ...
 * const [url, options] = fetchFn.mock.calls[0]; // properly typed!
 * ```
 */
export function createTypedMockFetch(): TypedMockFetch {
  return vi.fn<typeof globalThis.fetch>();
}

/**
 * Options for `createMockResponse()`.
 */
export interface MockResponseOptions {
  ok?: boolean;
  status?: number;
  statusText?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  text?: string;
  arrayBuffer?: ArrayBuffer;
}

/**
 * Create a fully typed `Response` object with sensible defaults.
 *
 * Avoids partial fetch mock type errors by providing all required
 * Response properties. The `json()` method returns `body` (default: `{}`),
 * and `text()` returns `text` or stringified `body`.
 *
 * Usage:
 * ```ts
 * const fetchFn = createTypedMockFetch();
 * fetchFn.mockResolvedValue(createMockResponse({
 *   ok: true,
 *   status: 200,
 *   body: { data: [1, 2, 3] },
 * }));
 * ```
 */
export function createMockResponse(options: MockResponseOptions = {}): Response {
  const {
    ok = true,
    status = ok ? 200 : 500,
    statusText = ok ? "OK" : "Internal Server Error",
    url = "https://mock.test/",
    headers = {},
    body = {},
    text,
    arrayBuffer,
  } = options;

  const resolvedText = text ?? (typeof body === "string" ? body : JSON.stringify(body));

  // Build a real Response so all native properties exist.
  // We override json/text/arrayBuffer methods for convenience.
  const response = new Response(resolvedText, {
    status,
    statusText,
    headers: new Headers(headers),
  });

  // Override methods so tests can control return values precisely.
  // Using Object.defineProperty to override read-only properties on Response.
  Object.defineProperty(response, "url", { value: url, writable: false });
  Object.defineProperty(response, "ok", { value: ok, writable: false });

  // Override json() to return the body object directly (avoids double-serialization).
  const originalJson = response.json.bind(response);
  Object.defineProperty(response, "json", {
    value: () => (body !== undefined ? Promise.resolve(body) : originalJson()),
  });

  if (arrayBuffer) {
    Object.defineProperty(response, "arrayBuffer", {
      value: () => Promise.resolve(arrayBuffer),
    });
  }

  return response;
}

/**
 * Create a simple fetch mock that returns a fixed response.
 *
 * This is a convenience wrapper combining `createTypedMockFetch()` and
 * `createMockResponse()`. The returned mock function has properly typed
 * `.mock.calls`.
 *
 * Usage:
 * ```ts
 * const fetchFn = createSimpleMockFetch({ ok: true, body: { data: [] } });
 * const client = new ApiClient(fetchFn);
 * await client.getData();
 * const [url, options] = fetchFn.mock.calls[0]; // typed!
 * ```
 */
export function createSimpleMockFetch(responseOptions: MockResponseOptions): TypedMockFetch {
  const mockFetch = createTypedMockFetch();
  mockFetch.mockResolvedValue(createMockResponse(responseOptions));
  return mockFetch;
}
