import { describe, expect, it, vi } from "vitest";
import { MountainProjectClient, parseMountainProjectProfileId } from "./client.ts";

describe("parseMountainProjectProfileId", () => {
  it.each([
    ["110186720", "110186720"],
    [" 110186720 ", "110186720"],
    ["https://www.mountainproject.com/user/110186720", "110186720"],
    ["https://www.mountainproject.com/user/110186720/evan-davis", "110186720"],
    ["https://www.mountainproject.com/user/110186720/evan-davis/tick-export?view=all", "110186720"],
  ])("extracts %s", (input, expected) => {
    expect(parseMountainProjectProfileId(input)).toBe(expected);
  });

  it.each([
    "",
    "110abc",
    "x110186720",
    "http://www.mountainproject.com/user/110186720/name",
    "https://example.com/user/110186720/name",
    "https://www.mountainproject.com/route/110186720/name",
    "https://www.mountainproject.com/area/user/110186720/name",
  ])("rejects invalid input %s", (input) => {
    expect(() => parseMountainProjectProfileId(input)).toThrow(
      "Paste your Mountain Project profile URL or numeric profile ID.",
    );
  });
});

describe("MountainProjectClient", () => {
  it("fetches the public tick export without credentials", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("Date,Route", { status: 200 }));
    const client = new MountainProjectClient(fetchFn);

    await expect(client.getTickExport("110186720")).resolves.toBe("Date,Route");
    expect(fetchFn).toHaveBeenCalledWith(
      "https://www.mountainproject.com/user/110186720/ticks/tick-export",
      expect.objectContaining({ headers: { Accept: "text/csv" } }),
    );
  });

  it("reports a private-or-missing profile with actionable guidance", async () => {
    const client = new MountainProjectClient(async () => new Response("missing", { status: 404 }));

    await expect(client.getTickExport("110186720")).rejects.toThrow(
      "Mountain Project: we couldn't read your ticks — check that your Mountain Project profile ID is correct and that your ticks aren't set to private.",
    );
  });

  it("reports unexpected export responses without treating them as private profiles", async () => {
    const client = new MountainProjectClient(
      async () => new Response("unavailable", { status: 503 }),
    );

    await expect(client.getTickExport("110186720")).rejects.toThrow(
      "Mountain Project tick export failed (503). Please try again.",
    );
  });
});
