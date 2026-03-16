/**
 * Test helpers for whoop-whoop client tests.
 *
 * Provides typed fetch mock helpers that eliminate type suppression comments.
 */
import { vi } from "vitest";

/**
 * A fetch function created by `vi.fn()` with proper type parameters.
 * This gives `.mock.calls` the correct tuple types automatically,
 * so destructuring call args doesn't need type suppression.
 */
export type TypedMockFetch = ReturnType<typeof vi.fn<typeof globalThis.fetch>> &
  typeof globalThis.fetch;

/**
 * Create a mock fetch that returns a fixed response, with properly typed
 * `.mock.calls` for asserting on call arguments.
 *
 * Uses a real `Response` object so all required properties exist.
 */
export function createMockFetch(response: {
  status: number;
  ok: boolean;
  body: unknown;
  statusText?: string;
}): TypedMockFetch {
  const textValue =
    typeof response.body === "string" ? response.body : JSON.stringify(response.body);

  const mockResponse = new Response(textValue, {
    status: response.status,
    statusText: response.statusText,
  });

  // Override json() to return the body object directly (avoids re-parsing)
  Object.defineProperty(mockResponse, "json", {
    value: () => Promise.resolve(response.body),
    configurable: true,
  });
  Object.defineProperty(mockResponse, "ok", {
    value: response.ok,
    configurable: true,
  });

  const fn = vi.fn<typeof globalThis.fetch>();
  fn.mockResolvedValue(mockResponse);
  return fn;
}
