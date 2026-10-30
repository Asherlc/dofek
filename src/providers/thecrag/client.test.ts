import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TheCragClient } from "./client.ts";
import { apiAscent, logbookPage } from "./test-helpers.ts";

const captureException = vi.hoisted(() => vi.fn());
vi.mock("../../lib/error-reporting.ts", () => ({ captureException }));
afterEach(() => vi.clearAllMocks());

describe("theCrag official logbook client", () => {
  it("sends the key only in its header and preserves cancellation", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json(logbookPage()));
    const controller = new AbortController();
    const page = await new TheCragClient(fetchFn, "private-key").fetchPage(1, {
      since: 1791676799,
      signal: controller.signal,
    });
    expect(page).toMatchObject({ account: { id: "123" }, page: 1, perPage: 250 });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://www.thecrag.com/api/logbook/ascents?page=1&since=1791676799",
      expect.objectContaining({ method: "GET", redirect: "manual", signal: controller.signal }),
    );
    expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).get("X-CData-Key")).toBe(
      "key=private-key",
    );
    expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).get("Accept")).toBe("application/json");
  });

  it("accepts header-safe keys without imposing an undocumented key format", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json(logbookPage()));
    await new TheCragClient(fetchFn, "base64-key==").fetchPage(1);
    expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).get("X-CData-Key")).toBe(
      "key=base64-key==",
    );
  });

  it("omits since on full requests and normalizes numeric account IDs", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(logbookPage([], { account: { id: 123 } })));
    expect(await new TheCragClient(fetchFn, "key").fetchPage(1)).toMatchObject({
      account: { id: "123" },
    });
    expect(String(fetchFn.mock.calls[0]?.[0])).not.toContain("since");
  });

  it.each(["", "\r\nprivate-key", "key\0"])(
    "rejects invalid key syntax before sending it: %j",
    async (key) => {
      const fetchFn = vi.fn<typeof fetch>();
      expect(() => new TheCragClient(fetchFn, key)).toThrow(/personal API key/);
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it.each([302, 400, 401, 403, 429, 500])(
    "reports HTTP %s without exposing upstream bodies",
    async (status) => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("private-key private notes", { status }));
      let failure: unknown;
      try {
        await new TheCragClient(fetchFn, "private-key").fetchPage(1);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(inspect(failure)).not.toMatch(/private-key|private notes/);
      expect(inspect(failure)).toContain(String(status));
    },
  );

  it.each([
    { data: { account: { id: "123" }, ascents: [], numberAscents: -1, page: 1, perPage: 250 } },
    logbookPage([], { page: "0" }),
    logbookPage([], { account: { id: "not-an-id" } }),
    { error: "private notes private-key" },
  ])("sanitizes invalid response schemas", async (body) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
    await expect(new TheCragClient(fetchFn, "private-key").fetchPage(1)).rejects.toThrow(
      /invalid logbook response/,
    );
    expect(inspect(captureException.mock.calls, { depth: null })).not.toMatch(
      /private-key|private notes/,
    );
  });

  it("sanitizes invalid JSON without attaching the decoding error", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"private-key private notes'));
    await expect(new TheCragClient(fetchFn, "private-key").fetchPage(1)).rejects.toThrow(
      /invalid logbook JSON/,
    );
    expect(captureException).toHaveBeenCalled();
    expect(inspect(captureException.mock.calls, { depth: null })).not.toMatch(
      /private-key|private notes/,
    );
  });

  it("retains opaque ascent provenance for the mapper", async () => {
    const ascent = apiAscent({ pitch: [{ opaque: true }] });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json(logbookPage([ascent])));
    expect((await new TheCragClient(fetchFn, "key").fetchPage(1)).ascents).toEqual([ascent]);
  });
});
