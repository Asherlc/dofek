import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderAuthError, ProviderTokenRejectedError } from "../auth-errors.ts";
import { TheCragClient } from "./client.ts";
import { apiAscent, logbookPage } from "./test-helpers.ts";

const captureException = vi.hoisted(() => vi.fn());
vi.mock("../../lib/error-reporting.ts", () => ({ captureException }));
afterEach(() => vi.clearAllMocks());

describe("theCrag official logbook client", () => {
  it("preserves cancellation during response body decoding", async () => {
    const controller = new AbortController();
    const reason = new Error("sync cancelled");
    const response = Response.json(logbookPage());
    vi.spyOn(response, "json").mockImplementation(async () => {
      controller.abort(reason);
      throw reason;
    });
    await expect(
      new TheCragClient(vi.fn<typeof fetch>().mockResolvedValue(response), "key").fetchPage(1, {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(captureException).not.toHaveBeenCalled();
  });
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
      expect(captureException).not.toHaveBeenCalled();
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
      if (status === 401) {
        expect(failure).toBeInstanceOf(ProviderTokenRejectedError);
        expect(failure).toHaveProperty("authFailureReason", "authentication_failed");
        expect(failure).toHaveProperty("message", expect.stringContaining("reconnect"));
      } else if (status === 400 || status === 403) {
        expect(failure).toBeInstanceOf(ProviderAuthError);
        expect(failure).toHaveProperty("authFailureReason", "authorization_failed");
        expect(failure).toHaveProperty("message", expect.stringContaining("supporter status"));
      } else if (status === 429) {
        expect(failure).toHaveProperty("message", expect.stringContaining("weekly usage budget"));
      }
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
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { provider: "thecrag", phase: "logbook_response" },
    });
    expect(inspect(captureException.mock.calls, { depth: null })).not.toMatch(
      /private-key|private notes/,
    );
  });

  it("retains opaque ascent provenance for the mapper", async () => {
    const ascent = apiAscent({ pitch: [{ opaque: true }] });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json(logbookPage([ascent])));
    expect((await new TheCragClient(fetchFn, "key").fetchPage(1)).ascents).toEqual([ascent]);
  });

  it.each(["1", "123", 123])("normalizes account identity %j and pagination", async (id) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        logbookPage([apiAscent({ epoch: "1791676800" })], {
          account: { id },
          numberAscents: "1234",
          page: "12",
          perPage: "250",
        }),
      ),
    );
    expect(await new TheCragClient(fetchFn, "key").fetchPage(12)).toEqual({
      account: { id: String(id) },
      ascents: [apiAscent({ epoch: 1791676800 })],
      numberAscents: 1234,
      page: 12,
      perPage: 250,
    });
  });

  it.each(["x123", "123x", "0", "0123", "1x", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects malformed account identity %j",
    async (id) => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(logbookPage([], { account: { id } })));
      await expect(new TheCragClient(fetchFn, "key").fetchPage(1)).rejects.toThrow(
        /invalid logbook response/,
      );
    },
  );

  it.each(["x12", "12x", "abc", -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects malformed source epoch %j",
    async (epoch) => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(logbookPage([apiAscent({ epoch })])));
      await expect(new TheCragClient(fetchFn, "key").fetchPage(1)).rejects.toThrow(
        /invalid logbook response/,
      );
    },
  );

  it("requires source progress on each ascent", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(logbookPage([apiAscent({ epoch: undefined })])));
    await expect(new TheCragClient(fetchFn, "key").fetchPage(1)).rejects.toThrow(
      /invalid logbook response/,
    );
  });
});
